import { AxeBuilder } from "@axe-core/playwright";
import { execFile } from "node:child_process";
import { mkdir, rmdir, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DESIGN_IDS, PAGE_IDS, PAGES, type DesignId, type PageId } from "@asksite/site-schema";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { loadFixture, renderFixture } from "../../../fixtures/index.ts";
import { apexPlaceholder, formProblems, messageTooLong, notFound, siteBusy, thankYou, tooManyRequests, unavailable, unreadableForm } from "../src/pages.ts";
import { watchCsp } from "./csp.ts";
import { E2E_FIXTURES, e2eSlug, type E2eFixture } from "./global-setup.ts";
import { LIFECYCLE_ENGINES, lifecycleSlug, V2_COPY, type LifecycleEngine } from "./lifecycle.ts";

const ROOT = "localhost:8789";
/** The published site of a fixture in a design (global-setup.ts seeds every design x fixture). */
const site = (design: DesignId, fixture: E2eFixture): { siteId: string; url: string } | undefined =>
  (JSON.parse(process.env["ASKSITE_E2E_SITES"] ?? "{}") as Record<string, { siteId: string; url: string }>)[e2eSlug(design, fixture)];

/** The address of one page of a published site (the site's url ends in "/", a page path starts with it). */
const pageUrl = (design: DesignId, fixture: E2eFixture, id: PageId): string => `${site(design, fixture)?.url ?? ""}${PAGES[id].path.slice(1)}`;

/** The pages a fixture publishes, Home first (the same in every design). */
const pagesOf = (fixture: E2eFixture): PageId[] => renderFixture(fixture).map((p) => p.page);

// The same gates as Plan 1's e2e: every WCAG 2.2 A/AA violation, whatever axe's impact rating (impact is
// severity, not the WCAG level: meta-viewport is AA but rated moderate; A9 item 4), plus every structure rule.
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const STRUCTURE_RULES = [
  "region",
  "heading-order",
  "landmark-one-main",
  "landmark-unique",
  "landmark-no-duplicate-banner",
  "landmark-no-duplicate-contentinfo",
  "landmark-no-duplicate-main",
  "landmark-banner-is-top-level",
  "landmark-contentinfo-is-top-level",
  "landmark-main-is-top-level",
  "page-has-heading-one",
];

async function axeProblems(page: Page): Promise<string[]> {
  const wcag = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const structure = await new AxeBuilder({ page }).withRules(STRUCTURE_RULES).analyze();
  return [...wcag.violations, ...structure.violations].map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}

const sidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/**
 * The key that moves keyboard focus to the next link, button or field. On macOS, WebKit's plain Tab skips
 * links and buttons and reaches only form fields; Option+Tab reaches them all (as in Plan 1's e2e; A9).
 */
const nextFocusKey = (browserName: string): string => (browserName === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab");

/** The id of each element keyboard focus lands on, over `steps` presses ("" for one without an id). */
async function focusedIds(page: Page, browserName: string, steps = 80): Promise<string[]> {
  const ids: string[] = [];
  for (let step = 0; step < steps; step++) {
    await page.keyboard.press(nextFocusKey(browserName));
    ids.push(await page.evaluate(() => document.activeElement?.id ?? ""));
  }
  return ids;
}

/** True when the contact form's honeypot field lies wholly left of or above the page, where no one can scroll to it. */
const honeypotOffScreen = (page: Page) =>
  page.locator("#contact-website").evaluate((field) => {
    const box = field.getBoundingClientRect();
    return box.right + window.scrollX <= 0 || box.bottom + window.scrollY <= 0;
  });

/** For the RED proofs: drops every class that could hide the honeypot field (its own and its ancestors' inside the form). */
const unhideHoneypot = (page: Page) =>
  page.locator("#contact-website").evaluate((field) => {
    for (let el: Element | null = field; el !== null && el.tagName !== "FORM"; el = el.parentElement) el.removeAttribute("class");
  });

/**
 * The visitor network a design's form post comes from. A15 stores at most 3 leads a UTC day per site and
 * network and 5 per network across all sites, so each design's post comes from its own network, and each
 * network still stores one lead per run, as playwright.config.ts plans: impact posts from the project's own
 * TEST-NET-1 address, refined and modern from the same host in TEST-NET-2 and TEST-NET-3 (RFC 5737).
 */
function designVisitor(testInfo: TestInfo, design: DesignId): string {
  const own = testInfo.project.use.extraHTTPHeaders?.["cf-connecting-ip"] ?? "";
  const host = /^192\.0\.2\.(\d+)$/.exec(own)?.[1];
  if (host === undefined) throw new Error(`Project ${testInfo.project.name} has no TEST-NET-1 visitor address`);
  return `${({ impact: "192.0.2", refined: "198.51.100", modern: "203.0.113" } as const)[design]}.${host}`;
}

const isLifecycleEngine = (name: string): boolean => (LIFECYCLE_ENGINES as readonly string[]).includes(name);

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
/** Held while one operate.ts runs: a directory, because mkdir fails for all but one caller. */
const OPERATE_LOCK = `${REPO}.wrangler/e2e-operate.lock`;
const OPERATE_LOCK_STALE_MS = 120_000;

/**
 * Changes the running server's state (operate.ts): approve a second version, take down or restore the site.
 * One at a time across the workers: each run opens its own copy of the state wrangler dev is serving, and two
 * at once fail with D1 and R2 "internal error"s.
 */
async function operate(command: "approve-v2" | "take-down" | "restore", slug: string): Promise<void> {
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

// Every published page in every design (A12).
for (const design of DESIGN_IDS) {
  test.describe(design, () => {
    for (const fixture of E2E_FIXTURES) {
      test.describe(`published ${fixture}`, () => {
        for (const id of pagesOf(fixture)) {
          test(`serves ${id} in its design, with its photos and zero CSP violations`, async ({ page }) => {
            const violations = await watchCsp(page);
            const badPhotos: string[] = [];
            page.on("response", (r) => {
              if (r.url().startsWith(`https://media.${ROOT}/`) && r.status() !== 200) badPhotos.push(`${r.status()} ${r.url()}`);
            });
            page.on("requestfailed", (r) => badPhotos.push(`failed ${r.url()}`));
            const response = await page.goto(pageUrl(design, fixture, id));
            expect(response?.status()).toBe(200);
            expect(response?.headers()["content-security-policy"]).toContain(`img-src https://media.${ROOT};`);
            await expect(page.locator("body")).toHaveAttribute("data-design", design);
            await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", pageUrl(design, fixture, id));
            await page.waitForLoadState("load");
            // Gallery photos are lazy-loaded: scroll each into view, then wait for it to decode.
            for (const img of await page.locator("img").all()) {
              await img.scrollIntoViewIfNeeded();
              await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), { timeout: 15_000 }).toBe(true);
            }
            expect(badPhotos).toEqual([]);
            expect(await violations()).toEqual([]);
            // Bold embeds its heading font as a data: woff2 in its sheet (A12 USER DECISION 2026-09-27): it must load
            // under the CSP the Worker serves (font-src data:), on every page (moderator ruling 2026-10-01 22:47).
            if (design === "impact") {
              const faces = await page.evaluate(async () => {
                await document.fonts.ready;
                return [...document.fonts].filter((f) => f.family.replace(/"/g, "") === "Archivo Condensed").map((f) => f.status);
              });
              expect(faces).toEqual(["loaded"]);
            }
          });

          test(`passes axe on ${id} (every WCAG 2.2 A/AA violation, plus the structure rules)`, async ({ page }) => {
            await page.goto(pageUrl(design, fixture, id));
            expect(await axeProblems(page)).toEqual([]);
          });

          test(`links every page of the site from ${id}'s header, each answering 200, and HEAD answers as GET does`, async ({ page }) => {
            await page.goto(pageUrl(design, fixture, id));
            // Every rendered page is in the header's nav (a design may list it twice: inline links and a menu), and nothing else.
            const listed = await page.locator('nav[aria-label="Main"] a').evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).href));
            const hrefs = [...new Set(listed)];
            expect(hrefs).toEqual(pagesOf(fixture).map((other) => pageUrl(design, fixture, other)));
            for (const href of hrefs) {
              const get = await page.request.get(href);
              expect({ href, status: get.status() }).toEqual({ href, status: 200 });
              const head = await page.request.head(href);
              expect({ href, status: head.status() }).toEqual({ href, status: get.status() });
            }
          });
        }

        // A page a site does not have (a fixture without About or Gallery) answers 404 to GET and to HEAD alike.
        const missing = PAGE_IDS.filter((id) => !pagesOf(fixture).includes(id));
        if (missing.length > 0) {
          test(`answers GET and HEAD with 404 for ${missing.join(" and ")}, which it does not have`, async ({ page }) => {
            for (const id of missing) {
              const get = await page.request.get(pageUrl(design, fixture, id));
              const head = await page.request.head(pageUrl(design, fixture, id));
              expect({ id, get: get.status(), head: head.status() }).toEqual({ id, get: 404, head: 404 });
            }
          });
        }
      });
    }

    test.describe("contact form in a real browser", () => {
      test("submits to the Worker and lands on the thank-you page", async ({ page }, testInfo) => {
        const plumber = site(design, "plumber-austin");
        await page.setExtraHTTPHeaders({ "cf-connecting-ip": designVisitor(testInfo, design) });
        const violations = await watchCsp(page);
        // Exactly one form post per design per network (A15 caps): the form is only on /contact, reached from Home.
        await page.goto(plumber?.url ?? "");
        expect(await page.locator("form").count()).toBe(0);
        await page.locator('a[href="/contact#quote"]:visible').first().click();
        await expect(page).toHaveURL(`${plumber?.url}contact#quote`);
        await page.getByLabel("Name").fill("Pat Browser");
        await page.getByLabel("Phone").fill("(512) 555-0123");
        await page.getByLabel("How can we help? (optional)").fill("Leaking tap");
        await page.getByRole("button", { name: "Send request" }).click();
        await expect(page).toHaveURL(`${plumber?.url}_f/${plumber?.siteId}/sent`);
        // QA-2 RU(2): the page names the business the visitor wrote to, and links back to it.
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("Thanks! Your message was sent to Reliable Rooter Plumbing.");
        expect(await violations()).toEqual([]);
        expect(await axeProblems(page)).toEqual([]);
        await page.getByRole("link", { name: "Back to Reliable Rooter Plumbing" }).click();
        await expect(page).toHaveURL(plumber?.url ?? "");
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      });

      test("its honeypot field lies wholly off-screen", async ({ page }) => {
        await page.goto(pageUrl(design, "plumber-austin", "contact"));
        expect(await honeypotOffScreen(page)).toBe(true);
      });

      test("keyboard focus reaches it but never its honeypot field", async ({ page, browserName }) => {
        await page.goto(pageUrl(design, "plumber-austin", "contact"));
        const ids = await focusedIds(page, browserName);
        expect(ids).toContain("contact-message");
        expect(ids).not.toContain("contact-website");
      });
    });

    // The lifecycle of a live site, on the design's own site per engine (global-setup.ts), one test after the other:
    // the second approval (U2) first, then the takedown and the restore of what is live by then.
    test.describe("a live site's lifecycle", () => {
      test.describe.configure({ mode: "serial" });
      test.beforeEach(async ({ browserName }, testInfo) => {
        test.skip(!isLifecycleEngine(browserName) || testInfo.project.name === "chromium-390", "run in chromium-1280 and webkit-390 only: one site per engine");
        // operate() takes its turn behind the other workers' runs (the lock), and each run takes seconds on a busy machine:
        // the wait must not eat the default 30 s of the test.
        test.setTimeout(150_000);
      });
      const live = (engine: string, id: PageId): string => `https://${lifecycleSlug(design, engine as LifecycleEngine)}.${ROOT}${PAGES[id].path}`;
      const v1 = { headline: loadFixture("plumber-austin").copy?.heroHeadline ?? "", intro: loadFixture("plumber-austin").copy?.sectionIntros?.services ?? "" };

      test("shows no page of the first version, next to the second, after a second approval (U2)", async ({ page, browserName }) => {
        const home = page.getByRole("heading", { level: 1 });
        await page.goto(live(browserName, "home"));
        await expect(home).toHaveText(v1.headline);
        await page.locator('a[href="/services"]:visible').first().click();
        await expect(page.getByText(v1.intro)).toBeVisible();

        await operate("approve-v2", lifecycleSlug(design, browserName as LifecycleEngine));

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
        await page.goto(live(browserName, "home"));
        await expect(home).toHaveText(V2_COPY.heroHeadline);
        seen.push(await page.locator("body").innerText());
        expect(seen.filter((text) => text.includes(v1.headline) || text.includes(v1.intro))).toEqual([]);
        expect(cacheControls.length).toBeGreaterThanOrEqual(4);
        expect(cacheControls.filter((line) => !line.endsWith(" no-cache"))).toEqual([]);
      });

      test("answers 404 on every page after a takedown and serves every page again after the restore", async ({ page, browserName }) => {
        const slug = lifecycleSlug(design, browserName as LifecycleEngine);
        const ids = pagesOf("plumber-austin");
        const statuses = async () => {
          const found: Array<{ id: PageId; status: number | undefined }> = [];
          for (const id of ids) found.push({ id, status: (await page.goto(live(browserName, id)))?.status() });
          return found;
        };
        await operate("take-down", slug);
        expect(await statuses()).toEqual(ids.map((id) => ({ id, status: 404 })));
        await operate("restore", slug);
        expect(await statuses()).toEqual(ids.map((id) => ({ id, status: 200 })));
        await page.goto(live(browserName, "home"));
        await expect(page.getByRole("heading", { level: 1 })).toHaveText(V2_COPY.heroHeadline);
      });
    });
  });
}

test.describe("contact form problems in a real browser", () => {
  test("shows plain-words problems for a bad phone number, without the typed text", async ({ page }) => {
    await page.goto(pageUrl("modern", "cleaning-minimal", "contact")); // the design a cleaning business starts on (A12)
    await page.getByLabel("Name").fill("Pat");
    await page.getByLabel("Phone").fill("call me");
    await page.getByRole("button", { name: "Send request" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Please check your details");
    await expect(page.getByRole("listitem")).toHaveText(["Please enter a phone number we can call back, with at least 7 digits. Use only digits, spaces, dashes, dots, parentheses and a plus sign, and leave out any extension."]);
    expect(await page.content()).not.toContain("call me");
    expect(await axeProblems(page)).toEqual([]);
  });
});

// QA-2 RU(3): a wrong or old address on a live site is no longer a dead end.
test.describe("a wrong path on a live site", () => {
  for (const [fixture, name] of [["plumber-austin", "Reliable Rooter Plumbing"], ["electrical-xss", "<img src=x onerror=alert(1)>"]] as const) {
    test(`links to the page of ${fixture}`, async ({ page }) => {
      const live = site("impact", fixture); // both fixtures start on impact (A12)
      const dialogs: string[] = [];
      page.on("dialog", (dialog) => {
        dialogs.push(dialog.message());
        void dialog.dismiss();
      });
      const response = await page.goto(`${live?.url}old-page`);
      expect(response?.status()).toBe(404);
      expect(response?.headers()["x-robots-tag"]).toBe("noindex");
      const link = page.getByRole("link", { name: `Go to ${name}'s page` });
      await expect(link).toHaveAttribute("href", "/");
      expect(await axeProblems(page)).toEqual([]);
      await link.click();
      await expect(page).toHaveURL(live?.url ?? "");
      expect(dialogs).toEqual([]);
    });
  }
});

test.describe("fixed pages", () => {
  // Two fixed pages hold variable text: the business phone on the site-busy page (A15), and abuse@<root>
  // on the apex page. The latter has no break opportunity (UAX #14: LB15d, LB28, LB29), so the longest
  // legal root name must reflow too.
  const LONGEST_ROOT = ["w".repeat(63), "w".repeat(63), "w".repeat(63), "w".repeat(61)].join("."); // 253 characters
  // Business names are at most 60 characters (site-schema): a real one, and one with no break opportunity.
  const LONG_NAME = "Longhorn Storm Restoration Roofing, Gutters, Siding & Window";
  const UNBROKEN_NAME = "W".repeat(60);
  const PHONE = { text: "(512) 555-0142", tel: "+15125550142" };
  const PAGES: Array<[string, () => Response]> = [
    ["apex placeholder", () => apexPlaceholder(ROOT)],
    ["apex placeholder for the longest root domain", () => apexPlaceholder(LONGEST_ROOT)],
    ["404", () => notFound(ROOT)],
    ["404 on a live site with a long name", () => notFound(ROOT, LONG_NAME)],
    ["404 on a live site with an unbroken name", () => notFound(ROOT, UNBROKEN_NAME)],
    ["503", () => unavailable(ROOT)],
    ["thank-you", () => thankYou(ROOT, null)],
    ["thank-you naming a long name", () => thankYou(ROOT, LONG_NAME)],
    ["thank-you naming an unbroken name", () => thankYou(ROOT, UNBROKEN_NAME)],
    ["rate limited", () => tooManyRequests(ROOT, null)],
    ["rate limited with the business phone", () => tooManyRequests(ROOT, PHONE)],
    ["site busy", () => siteBusy(ROOT, Date.now(), null)],
    ["site busy with the business phone", () => siteBusy(ROOT, Date.now(), PHONE)],
    ["unreadable form", () => unreadableForm(ROOT)],
    ["message too long", () => messageTooLong(ROOT)],
    ["form problems", () => formProblems(ROOT, ["Please enter your name (up to 80 characters).", "Please check your email address, or leave it empty."])],
  ];

  for (const [name, build] of PAGES) {
    test(`${name} passes axe and reflows at 320 px`, async ({ page }) => {
      await page.setContent(await build().text());
      expect(await axeProblems(page)).toEqual([]);
      await page.setViewportSize({ width: 320, height: 640 });
      expect(await sidewaysScroll(page)).toBe(0);
    });
  }

  test("the live 404 and apex pages come from the Worker with noindex", async ({ page }) => {
    const missing = await page.goto(`https://${ROOT}/nope`);
    expect(missing?.status()).toBe(404);
    expect(missing?.headers()["x-robots-tag"]).toBe("noindex");
    const apex = await page.goto(`https://${ROOT}/`);
    expect(apex?.status()).toBe(200);
    expect(await axeProblems(page)).toEqual([]);
  });
});

test.describe("the gates can fail (RED proof)", () => {
  test("the CSP watcher sees a blocked image", async ({ page }) => {
    const violations = await watchCsp(page);
    await page.goto(site("modern", "cleaning-minimal")?.url ?? "");
    await page.evaluate(() => {
      const img = document.createElement("img");
      img.src = "https://images.example.com/x.png";
      img.alt = "x";
      document.body.append(img);
    });
    await expect.poll(violations).toEqual(["img-src https://images.example.com/x.png"]);
  });

  // The two honeypot proofs strip the classes that hide the field, so they hold whatever a design uses to hide it.
  test("the honeypot check sees the field shown on the page", async ({ page }) => {
    await page.goto(pageUrl("impact", "plumber-austin", "contact"));
    await unhideHoneypot(page);
    expect(await honeypotOffScreen(page)).toBe(false);
  });

  test("the focus check sees a honeypot field that keyboard focus can reach", async ({ page, browserName }) => {
    await page.goto(pageUrl("impact", "plumber-austin", "contact"));
    await unhideHoneypot(page);
    await page.locator("#contact-website").evaluate((field) => field.removeAttribute("tabindex"));
    expect(await focusedIds(page, browserName)).toContain("contact-website");
  });

  test("axe sees a fixed page without its main landmark", async ({ page }) => {
    await page.setContent((await notFound(ROOT).text()).replace("<main>", "<div>").replace("</main>", "</div>"));
    expect((await axeProblems(page)).map((line) => line.split(":")[0])).toContain("region");
  });

  test("the axe gate fails on a WCAG AA violation that axe rates moderate (zoom turned off)", async ({ page }) => {
    await page.setContent((await notFound(ROOT).text()).replace("initial-scale=1", "initial-scale=1, maximum-scale=1, user-scalable=no"));
    const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(violations.map((v) => `${v.id} ${v.impact}`)).toEqual(["meta-viewport moderate"]);
    expect((await axeProblems(page)).map((line) => line.split(":")[0])).toEqual(["meta-viewport"]);
  });

  test("the axe gate fails on a WCAG A violation that axe rates minor (a deprecated ARIA role)", async ({ page }) => {
    await page.setContent((await notFound(ROOT).text()).replace("<main>", '<main>\n<div role="directory"><p>Old role</p></div>'));
    const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(violations.map((v) => `${v.id} ${v.impact}`)).toEqual(["aria-deprecated-role minor"]);
    expect((await axeProblems(page)).map((line) => line.split(":")[0])).toEqual(["aria-deprecated-role"]);
  });
});
