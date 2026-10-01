import { AxeBuilder } from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { render } from "@asksite/renderer";
import { DESIGN_IDS, FONT_IDS, SiteDocument, type DesignId, type FontId, type SiteDocumentInput } from "@asksite/site-schema";
import { DESIGN_CSS, FIXTURE_FORM_ACTION, FIXTURE_SITE_URL, FIXTURES, inDesign, loadFixture, stubStylesheets, type FixtureName } from "../fixtures/index.ts";
import { BASELINE } from "../packages/renderer/src/baseline.ts";
import { renderDocument } from "../packages/renderer/src/render.ts";

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
const SCREENSHOT_CSS = fileURLToPath(new URL("./screenshot.css", import.meta.url));

// A 4x3 light-gray PNG. Every remote image is served from memory, so screenshots never
// depend on the network (a live image gave a steady pixel diff in earlier research).
const GRAY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEUlEQVR42mM4ffUhHDHg5AAASSceDT8mdlEAAAAASUVORK5CYII=", "base64");

async function openHtml(page: Page, html: string): Promise<void> {
  await page.route(/^https?:\/\//, (route) =>
    route.request().resourceType() === "image"
      ? route.fulfill({ body: GRAY_PNG, contentType: "image/png" })
      : route.abort(),
  );
  await page.setContent(html, { waitUntil: "load" });
}

const openDocument = (page: Page, doc: SiteDocumentInput): Promise<void> =>
  openHtml(page, render(doc, { stylesheets: DESIGN_CSS, formAction: FIXTURE_FORM_ACTION, siteUrl: FIXTURE_SITE_URL }).pages[0]!.html);

/** The fixture's page in the given design (A12), or in its own design when none is given. */
const open = (page: Page, name: FixtureName, design?: DesignId): Promise<void> => openDocument(page, inDesign(loadFixture(name), design));

/** The baseline sheet (styles/sheets/baseline.css, compiled by `pnpm build:css`): today's page's sheet. */
const BASELINE_CSS = readFileSync(new URL("../packages/renderer/styles/out/baseline.css", import.meta.url), "utf8");

/**
 * Today's page (BASELINE) for the fixture, with the baseline sheet, in the fixture's own lettering or the one
 * given. It is built only from files that no design build may change (A12 §9), so a design's own traits (a
 * hero that clips, a scroll padding that keeps focus clear of the call bar) can never hide what a RED proof
 * checks (A12-0 round-2 attack, I-1).
 */
function openToday(page: Page, name: FixtureName, font?: FontId): Promise<void> {
  const options = { stylesheets: stubStylesheets(BASELINE_CSS), formAction: FIXTURE_FORM_ACTION, siteUrl: FIXTURE_SITE_URL };
  const doc = loadFixture(name);
  const input = font === undefined ? doc : { ...doc, theme: { ...doc.theme, font } };
  return openHtml(page, renderDocument(SiteDocument.parse(input), BASELINE, options).pages[0]!.html);
}

/**
 * Every WCAG 2.2 A/AA violation, whatever axe's impact rating (impact is severity, not the WCAG level:
 * meta-viewport is AA but rated moderate; A9), plus any structure-rule violation, as "rule: selectors" lines.
 */
async function axeProblems(page: Page): Promise<string[]> {
  const wcag = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const structure = await new AxeBuilder({ page }).withRules(STRUCTURE_RULES).analyze();
  return [...wcag.violations, ...structure.violations].map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}

const sidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

const isPhoneProject = (page: Page) => (page.viewportSize()?.width ?? 0) < 768;

/**
 * The layout, reflow and axe checks (axe's WCAG 2.2 target-size rule is the tap-target check), which the
 * phone-emulation projects also run (A9). Keyboard-focus tests and screenshots stay on the desktop projects.
 */
const MOBILE = { tag: "@mobile" };

/**
 * The key that moves keyboard focus to the next link, button or field. On macOS, WebKit's plain Tab
 * skips links and buttons and reaches only form fields; Option+Tab reaches them all (Playwright's own
 * test "should traverse only form elements", darwin + WebKit only; A9).
 */
const nextFocusKey = (browserName: string): string => (browserName === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab");

/**
 * Tabs through the whole page and lists every focused element that sits entirely under the call bar,
 * as "TAG id-or-text" (e.g. "A (512) 555-0142"). Positions are read two frames after each key press:
 * WebKit can scroll the newly focused element into view on a later frame (a textarea measured 892 px
 * down an 844 px window straight after the press, 397 px two frames later), and an earlier reading
 * sees the old scroll position (A9 review).
 */
async function focusHiddenByCallBar(page: Page, browserName: string): Promise<string[]> {
  const hidden: string[] = [];
  for (let step = 0; step < 60; step++) {
    await page.keyboard.press(nextFocusKey(browserName));
    const covered = await page.evaluate(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const focused = document.activeElement;
      const bar = document.querySelector('aside[aria-label="Call us"]');
      if (!(focused instanceof HTMLElement) || focused === document.body || !bar || bar.contains(focused)) return null;
      const covers = focused.getBoundingClientRect().top >= bar.getBoundingClientRect().top;
      return covers ? `${focused.tagName} ${focused.id || (focused.textContent ?? "").trim().slice(0, 40)}`.trim() : null;
    });
    if (covered) hidden.push(covered);
  }
  return hidden;
}

/** True when the contact form's honeypot field lies wholly left of or above the page, where no one can scroll to it. */
const honeypotOffScreen = (page: Page) =>
  page.locator("#contact-website").evaluate((field) => {
    const box = field.getBoundingClientRect();
    return box.right + window.scrollX <= 0 || box.bottom + window.scrollY <= 0;
  });

/**
 * Opens the header's phone menu and follows its FAQ link, whatever the design's menu is (a <details>
 * disclosure or a :target link, both work without JavaScript), and lists what went wrong. The menu is
 * found by role and name: the navigation named "Main", then the one visible control whose text names the
 * menu. Playwright 1.63 gives <summary> no ARIA role, so that control is matched by its text among
 * summary, link and button elements.
 */
async function phoneMenuProblems(page: Page): Promise<string[]> {
  const nav = page.getByRole("navigation", { name: "Main" });
  const faq = nav.getByRole("link", { name: "FAQ", exact: true }).filter({ visible: true });
  if ((await faq.count()) > 0) return ["the FAQ link shows before the menu opens"];
  const toggle = nav.locator("summary, a, button").filter({ hasText: /menu/i, visible: true });
  const toggles = await toggle.count();
  if (toggles !== 1) return [`${toggles} visible menu controls`];
  await toggle.click();
  const shown = await faq.first().waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false);
  if (!shown) return ["the FAQ link stays hidden after the menu opens"];
  await faq.first().click();
  return (await page.waitForURL(/#faq$/, { timeout: 5_000 }).then(() => true, () => false)) ? [] : [`the FAQ link leads to ${page.url()}`];
}

/**
 * The font-family values that <body> and every element in it that is drawn (has a box) compute, each once,
 * sorted. Each lettering choice must change this set (A12-0 round-5 rulings, attack4 I-1, reading B): the
 * user's Bold decision (2026-09-27) keeps a system-ui body and draws headings, buttons and prices in its own
 * face, so the h1 and the body alone may read the same for two choices. KNOWN LIMIT: this reads each computed
 * family list, not the font the browser draws, so a design could pass by changing only a fallback font; the
 * judges' screenshots of the three lettering choices are the backstop.
 */
const pageFonts = (page: Page): Promise<string> =>
  page.evaluate(() =>
    [...new Set([document.body, ...document.body.querySelectorAll("*")].filter((el) => el.getClientRects().length > 0).map((el) => getComputedStyle(el).fontFamily))]
      .sort()
      .join(" | "),
  );

/** How a contact form field is drawn: its box, and the corner radius and padding a native select would differ in. */
type FieldShape = { width: number; height: number; radius: string; paddingTop: string; paddingLeft: string };

const fieldShape = (page: Page, selector: string): Promise<FieldShape> =>
  page.locator(selector).evaluate((el) => {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return { width: box.width, height: box.height, radius: style.borderTopLeftRadius, paddingTop: style.paddingTop, paddingLeft: style.paddingLeft };
  });

/**
 * The service select must look like the text fields: the same corner radius and padding, and the same width
 * and height to within 0.05 px (toBeCloseTo with 1 digit). Boxes are fractional (MDN, getBoundingClientRect),
 * and two grid columns can differ by one layout unit, 1/64 px, as in the approved Classic and Modern two-column
 * forms (A12-0 round-5 rulings, attack4 I-2). A native select is 2 px or more off.
 */
function expectSameShape(select: FieldShape, field: FieldShape): void {
  const { width, height, ...style } = select;
  const { width: fieldWidth, height: fieldHeight, ...fieldStyle } = field;
  expect(style).toEqual(fieldStyle);
  expect(width).toBeCloseTo(fieldWidth, 1);
  expect(height).toBeCloseTo(fieldHeight, 1);
}

/** Where the sticky call bar can cover Send on a phone: Send's centre this many px above the window's bottom edge. */
const SEND_OFFSETS = [10, 40, 75] as const;

type TapLog = { clicks: string[]; submits: number };

/**
 * Fills the contact form, leaving keyboard focus in the message box (a visitor who has just typed), scrolls
 * Send's centre `offset` px above the window's bottom edge and taps it there with the mouse or a finger.
 * Returns what the tap's click landed on and how many requests the form posted. The form's endpoint answers
 * 204 No Content, so the page stays, and a submission is counted once its request reaches the network.
 * Why: while a text field has focus the call bar stops sticking (focus-outside); pressing Send moves focus off
 * the field, the bar sticks again under the finger, and the release used to land on the bar, so the tap never
 * clicked Send and nothing was sent (Plan 2B QA, A12-0 round-5 rulings).
 */
async function tapSend(page: Page, input: "mouse" | "touch", offset: number): Promise<{ clicked: string; posts: number }> {
  let posts = 0;
  await page.route(FIXTURE_FORM_ACTION, (route) => {
    if (route.request().method() === "POST") posts += 1;
    return route.fulfill({ status: 204 });
  });
  await page.locator("#contact-name").fill("Pat Smith");
  await page.locator("#contact-phone").fill("512 555 0100");
  await page.locator("#contact-message").fill("The kitchen tap drips.");
  const point = await page.getByRole("button", { name: "Send request" }).evaluate((send, above) => {
    const box = send.getBoundingClientRect();
    window.scrollBy(0, box.top + box.height / 2 - (window.innerHeight - above));
    const moved = send.getBoundingClientRect();
    return { x: moved.left + moved.width / 2, y: moved.top + moved.height / 2, above: window.innerHeight - (moved.top + moved.height / 2) };
  }, offset);
  expect(Math.abs(point.above - offset)).toBeLessThanOrEqual(1); // WebKit scrolls by whole pixels
  await page.evaluate(() => {
    const log: TapLog = { clicks: [], submits: 0 };
    Object.assign(window, { tapLog: log });
    document.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : document.body;
      const control = target.closest("button, a");
      log.clicks.push(control === null ? target.tagName : `${control.tagName} ${(control.textContent ?? "").trim()}`);
    }, true);
    document.addEventListener("submit", () => {
      log.submits += 1;
    }, true);
  });
  if (input === "touch") await page.touchscreen.tap(point.x, point.y);
  else await page.mouse.click(point.x, point.y);
  const log = (): TapLog => (window as unknown as { tapLog: TapLog }).tapLog;
  await page.waitForFunction(() => (window as unknown as { tapLog: TapLog }).tapLog.clicks.length > 0);
  const { clicks, submits } = await page.evaluate(log);
  await expect.poll(() => posts).toBe(submits);
  return { clicked: clicks.join(", "), posts };
}

/** The id of each element keyboard focus lands on, over `steps` presses ("" for one without an id). */
async function focusedIds(page: Page, browserName: string, steps = 80): Promise<string[]> {
  const ids: string[] = [];
  for (let step = 0; step < steps; step++) {
    await page.keyboard.press(nextFocusKey(browserName));
    ids.push(await page.evaluate(() => document.activeElement?.id ?? ""));
  }
  return ids;
}

// Every check below runs in every page design (A12).
for (const design of DESIGN_IDS) {
  test.describe(design, () => {
    for (const name of FIXTURES) {
      test.describe(name, () => {
        test.beforeEach(async ({ page }) => {
          await open(page, name, design);
        });

        test("passes axe (every WCAG 2.2 A/AA violation, landmarks, heading order) with every <details> closed, then open", MOBILE, async ({ page }) => {
          test.slow(); // four axe runs: triple the 30 s timeout (31.7 s once on a busy machine, Plan 2 Task 6)
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

        test("never scrolls sideways", MOBILE, async ({ page }) => {
          expect(await sidewaysScroll(page)).toBe(0);
        });

        test("reflows at 320 px without sideways scrolling (WCAG 1.4.10)", MOBILE, async ({ page }) => {
          test.skip(!isPhoneProject(page), "checked once per engine, in the phone projects");
          await page.setViewportSize({ width: 320, height: 800 });
          expect(await sidewaysScroll(page)).toBe(0);
        });

        test("still reflows at 320 px after any service is chosen in the contact form", MOBILE, async ({ page }) => {
          test.skip(!isPhoneProject(page), "checked once per engine, in the phone projects");
          await page.setViewportSize({ width: 320, height: 800 });
          const select = page.locator("#contact-service");
          const scrolled: Record<string, number> = {};
          for (const label of await select.locator("option").allTextContents()) {
            await select.selectOption({ label });
            const sideways = await sidewaysScroll(page);
            if (sideways > 0) scrolled[label] = sideways;
          }
          expect(scrolled).toEqual({});
        });

        test("keyboard focus is never hidden under the call bar (WCAG 2.4.11)", async ({ page, browserName }) => {
          test.skip(!isPhoneProject(page), "the call bar only shows below 768 px");
          expect(await focusHiddenByCallBar(page, browserName)).toEqual([]);
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
          await expect(page).toHaveScreenshot([design, `${name}.png`], { fullPage: true, stylePath: SCREENSHOT_CSS });
        });
      });
    }

    test("the contact form's honeypot field lies wholly off-screen", MOBILE, async ({ page }) => {
      await open(page, "plumber-austin", design);
      expect(await honeypotOffScreen(page)).toBe(true);
    });

    test("keyboard focus reaches the contact form but never its honeypot field", async ({ page, browserName }) => {
      await open(page, "plumber-austin", design);
      const ids = await focusedIds(page, browserName);
      expect(ids).toContain("contact-message");
      expect(ids).not.toContain("contact-website");
    });

    test("each lettering choice changes the fonts the page uses", async ({ page }) => {
      const doc = inDesign(loadFixture("plumber-austin"), design);
      const fonts = new Set<string>();
      for (const font of FONT_IDS) {
        await openDocument(page, { ...doc, theme: { ...doc.theme, font } });
        fonts.add(await pageFonts(page));
      }
      expect(fonts.size).toBe(FONT_IDS.length);
    });

    // A phone visitor who has typed a message and taps Send low on the screen, where the call bar sticks again
    // as the press moves focus off the field (A12-0 round-5 rulings; the 390 px projects run it in Chromium and
    // WebKit, with the mouse and with touch).
    for (const input of ["mouse", "touch"] as const) {
      test.describe(`tapping Send with the ${input}`, () => {
        test.use({ hasTouch: input === "touch" });

        for (const offset of SEND_OFFSETS) {
          test(`sends the form exactly once with Send's centre ${offset} px above the bottom edge`, async ({ page }) => {
            test.skip(page.viewportSize()?.width !== 390, "checked in the 390 px projects, where the call bar shows");
            await open(page, "plumber-austin", design);
            expect(await tapSend(page, input, offset)).toEqual({ clicked: "BUTTON Send request", posts: 1 });
          });
        }
      });
    }

    test.describe("with JavaScript disabled", () => {
      test.use({ javaScriptEnabled: false });

      test("the FAQ accordion is exclusive", async ({ page }) => {
        await open(page, "plumber-austin", design);
        const items = page.locator('details[name="faq"]');
        await expect(items.nth(0)).toHaveAttribute("open", "");
        await items.nth(1).locator("summary").click();
        await expect(items.nth(1)).toHaveAttribute("open", "");
        await expect(items.nth(0)).not.toHaveAttribute("open", "");
      });

      test("the phone menu opens and its links work", async ({ page }) => {
        test.skip((page.viewportSize()?.width ?? 0) >= 1024, "the menu is replaced by inline links on wide screens");
        await open(page, "plumber-austin", design);
        expect(await phoneMenuProblems(page)).toEqual([]);
      });
    });

    test("XSS payloads never execute", async ({ page }) => {
      const dialogs: string[] = [];
      page.on("dialog", async (dialog) => {
        dialogs.push(dialog.message());
        await dialog.dismiss();
      });
      await open(page, "electrical-xss", design);
      for (const field of await page.locator("input:not([tabindex='-1']), select, textarea").all()) await field.focus();
      await page.mouse.move(10, 10);
      await page.locator("h1").hover();
      expect(dialogs).toEqual([]);
      expect(await page.title()).toBe("<img src=x onerror=alert(1)>");
      const ld = await page.locator('script[type="application/ld+json"]').first().textContent();
      expect(JSON.parse(ld ?? "{}").name).toBe("<img src=x onerror=alert(1)>");
    });

    test("the service select has the same size and shape as the text fields", async ({ page }) => {
      await open(page, "plumber-austin", design);
      expectSameShape(await fieldShape(page, "#contact-service"), await fieldShape(page, "#contact-name"));
    });
  });
}

test.describe("the gates can fail (RED proof)", () => {
  // Each proof edits today's page (BASELINE), which no design build changes; the unit RED blocks do the same.
  test("axe reports low-contrast text as serious", MOBILE, async ({ page }) => {
    await openToday(page, "plumber-austin");
    await page.addStyleTag({ content: ":root{--aw-color-text-muted:#BBBBBB}" });
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations.filter((v) => v.impact === "serious").map((v) => v.id)).toContain("color-contrast");
  });

  test("the sideways-scroll check sees a word that cannot wrap", MOBILE, async ({ page }) => {
    await openToday(page, "plumber-austin");
    await page.addStyleTag({ content: "body{overflow-wrap:normal!important}" });
    await page.locator("h1").evaluate((h1) => {
      h1.textContent = "W".repeat(300);
    });
    expect(await sidewaysScroll(page)).toBeGreaterThan(0);
  });

  test("the axe gate fails on a WCAG AA violation that axe rates moderate (zoom turned off)", MOBILE, async ({ page }) => {
    await openToday(page, "plumber-austin");
    await page.locator('meta[name="viewport"]').evaluate((meta) => {
      meta.setAttribute("content", "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no");
    });
    expect((await axeProblems(page)).map((line) => line.split(":")[0])).toContain("meta-viewport");
  });

  test("the axe gate fails on a WCAG A violation that axe rates minor (a deprecated ARIA role)", MOBILE, async ({ page }) => {
    await openToday(page, "plumber-austin");
    await page.locator("main").evaluate((main) => main.insertAdjacentHTML("afterbegin", '<div role="directory"><p>Old role</p></div>'));
    expect((await axeProblems(page)).map((line) => line.split(":")[0])).toContain("aria-deprecated-role");
  });

  test("axe reports content outside a landmark", MOBILE, async ({ page }) => {
    await openToday(page, "plumber-austin");
    await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", "<p>Outside every landmark</p>"));
    expect((await axeProblems(page)).map((line) => line.split(":")[0])).toContain("region");
  });

  test("the axe gate sees tap targets that are too small and too close (WCAG 2.5.8)", MOBILE, async ({ page }) => {
    await openToday(page, "plumber-austin");
    await page.locator("main").evaluate((main) => {
      const tiny = "display:block;width:8px;height:8px;overflow:hidden";
      main.insertAdjacentHTML("afterbegin", `<div style="display:flex"><a href="#a" style="${tiny}">A</a><a href="#b" style="${tiny}">B</a></div>`);
    });
    expect((await axeProblems(page)).map((line) => line.split(":")[0])).toContain("target-size");
  });

  test("the honeypot check sees the field moved on-screen", MOBILE, async ({ page }) => {
    await openToday(page, "plumber-austin");
    await page.addStyleTag({ content: "div:has(> #contact-website){left:0!important}" });
    expect(await honeypotOffScreen(page)).toBe(false);
  });

  test("the phone menu check sees a menu that does not open", async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) >= 1024, "the menu is replaced by inline links on wide screens");
    await openToday(page, "plumber-austin");
    await page.addStyleTag({ content: 'nav[aria-label="Main"] ul{display:none!important}' });
    expect(await phoneMenuProblems(page)).toEqual(["the FAQ link stays hidden after the menu opens"]);
  });

  test("the focus check sees a honeypot field that keyboard focus can reach", async ({ page, browserName }) => {
    await openToday(page, "plumber-austin");
    await page.locator("#contact-website").evaluate((field) => field.removeAttribute("tabindex"));
    expect(await focusedIds(page, browserName)).toContain("contact-website");
  });

  test("the focus check sees a field hidden under a call bar that always sticks", async ({ page, browserName }) => {
    test.skip(!isPhoneProject(page), "the call bar only shows below 768 px");
    await openToday(page, "plumber-austin");
    await page.addStyleTag({ content: "aside{position:sticky!important}" });
    expect(await focusHiddenByCallBar(page, browserName)).not.toEqual([]);
  });

  test("the lettering check sees a page that draws every lettering choice in one font", async ({ page }) => {
    const fonts = new Set<string>();
    for (const font of FONT_IDS) {
      await openToday(page, "plumber-austin", font);
      await page.addStyleTag({ content: "*{font-family:Georgia,serif!important}" });
      fonts.add(await pageFonts(page));
    }
    expect(fonts.size).toBe(1);
  });

  // What the lettering check allows (reading B): Bold keeps one family for the h1 and the body, and the
  // lettering choice still changes its other headings, buttons and prices.
  test("the lettering check allows a page whose h1 and body keep one font for every choice", async ({ page }) => {
    const fonts = new Set<string>();
    const pairs = new Set<string>();
    for (const font of FONT_IDS) {
      await openToday(page, "plumber-austin", font);
      await page.addStyleTag({ content: "h1{font-family:Georgia,serif!important}body{font-family:system-ui,sans-serif!important}" });
      fonts.add(await pageFonts(page));
      pairs.add(await page.evaluate(() => `${getComputedStyle(document.querySelector("h1") ?? document.body).fontFamily} | ${getComputedStyle(document.body).fontFamily}`));
    }
    expect({ fonts: fonts.size, pairs: pairs.size }).toEqual({ fonts: FONT_IDS.length, pairs: 1 });
  });

  test("the select check sees a native select", async ({ page }) => {
    await openToday(page, "plumber-austin");
    await page.addStyleTag({ content: "#contact-service{appearance:auto!important}" });
    const select = await fieldShape(page, "#contact-service");
    const name = await fieldShape(page, "#contact-name");
    expect(Math.abs(select.height - name.height)).toBeGreaterThan(1);
    expect(() => expectSameShape(select, name)).toThrow();
  });

  test("the select check sees a select half a pixel narrower, and allows one layout unit (1/64 px)", async ({ page }) => {
    await openToday(page, "plumber-austin");
    const name = await fieldShape(page, "#contact-name");
    await page.addStyleTag({ content: "#contact-service{width:calc(100% - 0.5px)!important}" });
    const half = await fieldShape(page, "#contact-service");
    expect(name.width - half.width).toBe(0.5);
    expect(() => expectSameShape(half, name)).toThrow(/toBeCloseTo/);
    await page.addStyleTag({ content: "#contact-service{width:calc(100% - 0.015625px)!important}" });
    const unit = await fieldShape(page, "#contact-service");
    expect(name.width - unit.width).toBe(0.015625);
    expectSameShape(unit, name);
  });

  test("the Send check sees a tap that the call bar takes", async ({ page }) => {
    test.skip(page.viewportSize()?.width !== 390, "checked in the 390 px projects, where the call bar shows");
    await openToday(page, "plumber-austin");
    // Today's page without the fix in styles/shared.css: Send no longer stacks above the call bar.
    await page.addStyleTag({ content: 'form button[type="submit"]{position:static!important;z-index:auto!important}' });
    expect(await tapSend(page, "mouse", 40)).toEqual({ clicked: "BODY", posts: 0 });
  });

  test("the focus check sees a link hidden under a call bar that sticks while a link has focus", async ({ page, browserName }) => {
    test.skip(!isPhoneProject(page), "the call bar only shows below 768 px");
    await openToday(page, "plumber-austin");
    // The bar stays static while a form field has focus, so only a hidden link can be found.
    await page.addStyleTag({ content: "html:has(a:focus-visible) aside{position:sticky!important}" });
    // Where a key press scrolls is each engine's choice: Linux WebKit centres the focused Send button, so no later link
    // happens to land under the bar there (CI, 2026-10-01). So the proof places one: the page's last link outside the
    // bar sits in the band the stuck bar covers, and focus starts on the stop before it. The next key press then
    // reaches that link without scrolling, because it is already in view.
    await page.evaluate(() => {
      const bar = document.querySelector('aside[aria-label="Call us"]');
      if (!bar) throw new Error("no call bar");
      const stops = [...document.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, summary")].filter(
        (el) => !bar.contains(el) && el.tabIndex >= 0 && el.getClientRects().length > 0,
      );
      const link = stops.findLast((el) => el.tagName === "A");
      const before = link ? stops[stops.indexOf(link) - 1] : undefined;
      if (!link || !before) throw new Error("no link with a stop before it");
      const band = bar.getBoundingClientRect().height;
      const box = link.getBoundingClientRect();
      window.scrollTo(0, box.top + window.scrollY - (window.innerHeight - band / 2 - box.height / 2));
      before.focus({ preventScroll: true });
    });
    expect((await focusHiddenByCallBar(page, browserName)).filter((stop) => stop.startsWith("A "))).not.toEqual([]);
  });
});

test("the phone projects emulate a real phone: mobile browser, coarse pointer, no hover, and the page's meta viewport sets the width", MOBILE, async ({ page }, testInfo) => {
  test.skip(testInfo.project.metadata["phone"] !== true, "only the phone-emulation projects");
  await open(page, "plumber-austin");
  await page.locator('meta[name="viewport"]').evaluate((meta) => {
    meta.setAttribute("content", "width=600");
  });
  const phone = await page.evaluate(() => ({
    mobileBrowser: /\bMobile\b/.test(navigator.userAgent), // "Mobile/15E148 Safari" on iPhone, "Mobile Safari" on Android
    hover: matchMedia("(hover: hover)").matches,
    coarse: matchMedia("(pointer: coarse)").matches,
    width: document.documentElement.clientWidth,
  }));
  expect(phone).toEqual({ mobileBrowser: true, hover: false, coarse: true, width: 600 });
});

/** The engine each phone-emulation project must run (A9b): iOS browsers are WebKit, Android's is Chromium. */
const PHONE_ENGINES: Record<string, string> = { "webkit-iphone": "webkit", "chromium-pixel": "chromium" };

test("each phone project runs its own engine: webkit-iphone in WebKit, chromium-pixel in Chromium", MOBILE, async ({ browser }, testInfo) => {
  // Every project checks the phone list first, and the skip goes by project name, not by metadata (A9c), so
  // removing, renaming or unmarking a phone project fails the run instead of skipping this test everywhere.
  const phones = testInfo.config.projects.filter((project) => project.metadata["phone"] === true).map((project) => project.name);
  expect(phones).toEqual(Object.keys(PHONE_ENGINES));
  test.skip(!Object.hasOwn(PHONE_ENGINES, testInfo.project.name), "only the phone-emulation projects run a phone engine");
  expect(browser.browserType().name()).toBe(PHONE_ENGINES[testInfo.project.name]);
});
