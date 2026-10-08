import { execFile } from "node:child_process";
import { mkdir, rmdir, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DESIGN_IDS, PAGES, type PageId } from "@asksite/site-schema";
import { expect, test, type Page } from "@playwright/test";
import { loadFixture, renderFixture } from "../../../fixtures/index.ts";
import { LIFECYCLE_TITLE, lifecycleSlug, V2_COPY, type LifecycleEngine } from "./lifecycle.ts";

// The lifecycle tests of every design for one engine. They change the running server's state, so they run alone,
// after every other test: lifecycle-chromium.spec.ts and lifecycle-webkit.spec.ts call this with their engine set by a
// top-level test.use (Playwright refuses a browserName in a describe group), in the "lifecycle" project
// (playwright.config.ts). This file is not a test file: a test file may not import another.

const ROOT = "localhost:8789";
const REPO = fileURLToPath(new URL("../../..", import.meta.url));
/** Held while one operate.ts runs: a directory, because mkdir fails for all but one caller. */
const OPERATE_LOCK = `${REPO}.wrangler/e2e-operate.lock`;
const OPERATE_LOCK_STALE_MS = 120_000;

/**
 * Changes the running server's state (operate.ts): approve a second version, take down or restore the site.
 * operate.ts opens its own copy of the state wrangler dev is serving, and D1 or R2 fails with "internal error" when
 * the server is busy meanwhile. So the lifecycle tests run alone (playwright.config.ts), the test's own page has no
 * request in flight, and two runs never overlap (the lock).
 */
async function operate(page: Page, command: "approve-v2" | "take-down" | "restore", slug: string): Promise<void> {
  await page.waitForLoadState("networkidle");
  await mkdir(`${REPO}.wrangler`, { recursive: true });
  for (;;) {
    try {
      await mkdir(OPERATE_LOCK);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A worker killed at its test timeout never reaches the finally below: a lock older than any run takes is stale.
      const held = await stat(OPERATE_LOCK).then((info) => Date.now() - info.mtimeMs, () => 0);
      if (held > OPERATE_LOCK_STALE_MS) await rmdir(OPERATE_LOCK).catch(() => undefined);
      await new Promise((done) => setTimeout(done, 200));
    }
  }
  try {
    await promisify(execFile)("node", [fileURLToPath(new URL("./operate.ts", import.meta.url)), command, slug], { cwd: REPO });
  } finally {
    await rmdir(OPERATE_LOCK);
  }
}

/** The lifecycle of a live site, per design, on the design's own site for this engine (global-setup.ts), one test
 *  after the other: the second approval (U2) first, then the takedown and the restore of what is live by then. */
export function lifecycleTests(engine: LifecycleEngine): void {
  const v1 = { headline: loadFixture("plumber-austin").copy?.heroHeadline ?? "", intro: loadFixture("plumber-austin").copy?.sectionIntros?.services ?? "" };
  const pages = renderFixture("plumber-austin").map((p) => p.page);
  for (const design of DESIGN_IDS) {
    test.describe(design, () => {
      test.describe(LIFECYCLE_TITLE, () => {
        test.describe.configure({ mode: "serial" });
        test.beforeEach(async ({ browserName }) => {
          expect(browserName).toBe(engine);
          // Each operate() run takes seconds on a busy machine: the wait must not eat the default 30 s of the test.
          test.setTimeout(150_000);
        });
        const slug = lifecycleSlug(design, engine);
        const live = (id: PageId): string => `https://${slug}.${ROOT}${PAGES[id].path}`;

        test("shows no page of the first version, next to the second, after a second approval (U2)", async ({ page }) => {
          const home = page.getByRole("heading", { level: 1 });
          await page.goto(live("home"));
          await expect(home).toHaveText(v1.headline);
          await page.locator('a[href="/services"]:visible').first().click();
          await expect(page.getByText(v1.intro)).toBeVisible();

          await operate(page, "approve-v2", slug);

          // Each view after the switch must be the second version: a reload, then links to the pages the browser has seen.
          // Cache-Control: no-cache is what makes a browser ask again, so every document answer must carry it. (The
          // browser cache is not used over the local self-signed certificate, so the views alone cannot show a stale copy.)
          const cacheControls: string[] = [];
          page.on("response", (response) => {
            if (response.request().resourceType() === "document") cacheControls.push(`${response.url()} ${response.headers()["cache-control"] ?? ""}`);
          });
          const seen: string[] = [];
          await page.reload();
          await expect(page.getByText(V2_COPY.servicesIntro)).toBeVisible();
          seen.push(await page.locator("body").innerText());
          await page.locator('a[href="/"]:visible').first().click();
          await expect(home).toHaveText(V2_COPY.heroHeadline);
          seen.push(await page.locator("body").innerText());
          await page.locator('a[href="/services"]:visible').first().click();
          await expect(page.getByText(V2_COPY.servicesIntro)).toBeVisible();
          seen.push(await page.locator("body").innerText());
          await page.goto(live("home"));
          await expect(home).toHaveText(V2_COPY.heroHeadline);
          seen.push(await page.locator("body").innerText());
          expect(seen.filter((text) => text.includes(v1.headline) || text.includes(v1.intro))).toEqual([]);
          expect(cacheControls.length).toBeGreaterThanOrEqual(4);
          expect(cacheControls.filter((line) => !line.endsWith(" no-cache"))).toEqual([]);
        });

        test("answers 404 on every page after a takedown and serves every page again after the restore", async ({ page }) => {
          const statuses = async () => {
            const found: Array<{ id: PageId; status: number | undefined }> = [];
            for (const id of pages) found.push({ id, status: (await page.goto(live(id)))?.status() });
            return found;
          };
          await operate(page, "take-down", slug);
          expect(await statuses()).toEqual(pages.map((id) => ({ id, status: 404 })));
          await operate(page, "restore", slug);
          expect(await statuses()).toEqual(pages.map((id) => ({ id, status: 200 })));
          await page.goto(live("home"));
          await expect(page.getByRole("heading", { level: 1 })).toHaveText(V2_COPY.heroHeadline);
        });
      });
    });
  }
}
