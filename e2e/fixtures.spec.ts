import { AxeBuilder } from "@axe-core/playwright";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { FIXTURES, loadStylesheet, renderFixture, type FixtureName } from "../fixtures/index.ts";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
// Best-practice rules for page structure: all content inside landmarks, headings in order,
// one main, no duplicate or nested landmarks. Any violation of these fails, whatever its impact.
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
];
const stylesheet = loadStylesheet();
const SCREENSHOT_CSS = fileURLToPath(new URL("./screenshot.css", import.meta.url));

// A 4x3 light-gray PNG. Every remote image is served from memory, so screenshots never
// depend on the network (a live image gave a steady pixel diff in earlier research).
const GRAY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEUlEQVR42mM4ffUhHDHg5AAASSceDT8mdlEAAAAASUVORK5CYII=", "base64");

async function open(page: Page, name: FixtureName): Promise<void> {
  await page.route(/^https?:\/\//, (route) =>
    route.request().resourceType() === "image"
      ? route.fulfill({ body: GRAY_PNG, contentType: "image/png" })
      : route.abort(),
  );
  await page.setContent(renderFixture(name, stylesheet), { waitUntil: "load" });
}

/** Serious/critical WCAG violations plus any structure-rule violation, as "rule: selectors" lines. */
async function axeProblems(page: Page): Promise<string[]> {
  const wcag = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const structure = await new AxeBuilder({ page }).withRules(STRUCTURE_RULES).analyze();
  return [...wcag.violations.filter((v) => v.impact === "serious" || v.impact === "critical"), ...structure.violations].map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`,
  );
}

const sidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

const isPhoneProject = (page: Page) => (page.viewportSize()?.width ?? 0) < 768;

/** Tabs through the whole page and lists every focused element that sits entirely under the call bar. */
async function focusHiddenByCallBar(page: Page): Promise<string[]> {
  const hidden: string[] = [];
  for (let step = 0; step < 60; step++) {
    await page.keyboard.press("Tab");
    const covered = await page.evaluate(() => {
      const focused = document.activeElement;
      const bar = document.querySelector('aside[aria-label="Call us"]');
      if (!(focused instanceof HTMLElement) || focused === document.body || !bar || bar.contains(focused)) return null;
      const covers = focused.getBoundingClientRect().top >= bar.getBoundingClientRect().top;
      return covers ? focused.id || (focused.textContent ?? "").trim().slice(0, 40) || focused.tagName : null;
    });
    if (covered) hidden.push(covered);
  }
  return hidden;
}

for (const name of FIXTURES) {
  test.describe(name, () => {
    test.beforeEach(async ({ page }) => {
      await open(page, name);
    });

    test("passes axe (WCAG 2.2 AA serious/critical, landmarks, heading order) with every <details> closed, then open", async ({ page }) => {
      const closed = await axeProblems(page);
      // Content inside a closed <details> is not rendered, so axe skips it: open them all and scan again.
      await page.evaluate(() => {
        for (const details of document.querySelectorAll("details")) {
          details.removeAttribute("name");
          details.open = true;
        }
      });
      expect({ closed, open: await axeProblems(page) }).toEqual({ closed: [], open: [] });
    });

    test("never scrolls sideways", async ({ page }) => {
      expect(await sidewaysScroll(page)).toBe(0);
    });

    test("reflows at 320 px without sideways scrolling (WCAG 1.4.10)", async ({ page }) => {
      test.skip(!isPhoneProject(page), "checked once per engine, in the phone projects");
      await page.setViewportSize({ width: 320, height: 800 });
      expect(await sidewaysScroll(page)).toBe(0);
    });

    test("keyboard focus is never hidden under the call bar (WCAG 2.4.11)", async ({ page }) => {
      test.skip(!isPhoneProject(page), "the call bar only shows below 768 px");
      expect(await focusHiddenByCallBar(page)).toEqual([]);
    });

    test("ships no JavaScript: only JSON-LD scripts, no event handlers", async ({ page }) => {
      const scriptTypes = await page.locator("script").evaluateAll((els) => els.map((el) => el.getAttribute("type")));
      expect(scriptTypes.every((type) => type === "application/ld+json")).toBe(true);
      const handlers = await page.evaluate(() =>
        [...document.querySelectorAll("*")].flatMap((el) => el.getAttributeNames().filter((n) => n.startsWith("on"))),
      );
      expect(handlers).toEqual([]);
    });

    test("matches the screenshot baseline", async ({ page }) => {
      await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: true, stylePath: SCREENSHOT_CSS });
    });
  });
}

test.describe("the gates can fail (RED proof)", () => {
  test("axe reports low-contrast text as serious", async ({ page }) => {
    await open(page, "plumber-austin");
    await page.addStyleTag({ content: ":root{--aw-color-text-muted:#BBBBBB}" });
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations.filter((v) => v.impact === "serious").map((v) => v.id)).toContain("color-contrast");
  });

  test("the sideways-scroll check sees a word that cannot wrap", async ({ page }) => {
    await open(page, "plumber-austin");
    await page.addStyleTag({ content: "body{overflow-wrap:normal!important}" });
    await page.locator("h1").evaluate((h1) => {
      h1.textContent = "W".repeat(300);
    });
    expect(await sidewaysScroll(page)).toBeGreaterThan(0);
  });

  test("axe reports content outside a landmark", async ({ page }) => {
    await open(page, "plumber-austin");
    await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", "<p>Outside every landmark</p>"));
    expect((await axeProblems(page)).map((line) => line.split(":")[0])).toContain("region");
  });

  test("the focus check sees a field hidden under a call bar that always sticks", async ({ page }) => {
    test.skip(!isPhoneProject(page), "the call bar only shows below 768 px");
    await open(page, "plumber-austin");
    await page.addStyleTag({ content: "aside{position:sticky!important}" });
    expect(await focusHiddenByCallBar(page)).not.toEqual([]);
  });
});

test.describe("with JavaScript disabled", () => {
  test.use({ javaScriptEnabled: false });

  test("the FAQ accordion is exclusive", async ({ page }) => {
    await open(page, "plumber-austin");
    const items = page.locator('details[name="faq"]');
    await expect(items.nth(0)).toHaveAttribute("open", "");
    await items.nth(1).locator("summary").click();
    await expect(items.nth(1)).toHaveAttribute("open", "");
    await expect(items.nth(0)).not.toHaveAttribute("open", "");
  });

  test("the phone menu opens and its links work", async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) >= 1024, "the menu is replaced by inline links on wide screens");
    await open(page, "plumber-austin");
    const menu = page.locator("header details");
    await menu.locator("summary").click();
    await expect(menu).toHaveAttribute("open", "");
    await menu.getByRole("link", { name: "FAQ" }).click();
    await expect(page).toHaveURL(/#faq$/);
  });
});

test("XSS payloads never execute", async ({ page }) => {
  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await open(page, "electrical-xss");
  for (const field of await page.locator("input:not([tabindex='-1']), select, textarea").all()) await field.focus();
  await page.mouse.move(10, 10);
  await page.locator("h1").hover();
  expect(dialogs).toEqual([]);
  expect(await page.title()).toBe("<img src=x onerror=alert(1)>");
  const ld = await page.locator('script[type="application/ld+json"]').first().textContent();
  expect(JSON.parse(ld ?? "{}").name).toBe("<img src=x onerror=alert(1)>");
});
