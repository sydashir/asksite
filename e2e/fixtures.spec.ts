import { AxeBuilder } from "@axe-core/playwright";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { render, type RenderedSitePage } from "@asksite/renderer";
import { DESIGN_IDS, FONT_IDS, PAGES, SiteDocument, type DesignId, type FontId, type PageId, type SiteDocumentInput } from "@asksite/site-schema";
import { DESIGN_CSS, FIXTURE_FORM_ACTION, FIXTURE_SITE_URL, FIXTURES, inDesign, loadFixture, renderFixture, stubStylesheets, type FixtureName } from "../fixtures/index.ts";
import { BASELINE } from "../packages/renderer/src/baseline.ts";
import { weeklyHours } from "../packages/renderer/src/format.ts";
import { renderDocument } from "../packages/renderer/src/render.ts";
import { DOM_ID } from "../packages/renderer/src/sections/ids.ts";

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

/** The one https origin every test page is served from (the host the fixtures give the renderer as siteUrl). */
const ORIGIN = new URL(FIXTURE_SITE_URL).origin;

/** What the harness did with each request the page made (the proof that nothing leaves the machine reads it). */
type Handled = { url: string; how: "page" | "image" | "aborted" };

/**
 * Serves a site's pages from memory on ORIGIN with page.route and route.fulfill (Playwright 1.63 docs, checked
 * with context7, /microsoft/playwright: Route.fulfill, Route.abort, handler order): a request for a rendered
 * page's path gets that page's HTML, an image from any host gets the gray PNG, and everything else is aborted.
 * No handler ever continues a request, so nothing reaches the network (the proof test below checks it).
 */
async function serve(page: Page, pages: readonly RenderedSitePage[]): Promise<Handled[]> {
  const handled: Handled[] = [];
  await page.route(/^https?:\/\//, (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const found = url.origin === ORIGIN && request.method() === "GET" ? pages.find((p) => p.path === url.pathname) : undefined;
    if (found !== undefined) {
      handled.push({ url: request.url(), how: "page" });
      return route.fulfill({ body: found.html, contentType: "text/html; charset=utf-8" });
    }
    if (request.resourceType() === "image") {
      handled.push({ url: request.url(), how: "image" });
      return route.fulfill({ body: GRAY_PNG, contentType: "image/png" });
    }
    handled.push({ url: request.url(), how: "aborted" });
    return route.abort();
  });
  return handled;
}

/** Serves the site and opens one of its pages (Home unless another is named). */
async function openPages(page: Page, pages: readonly RenderedSitePage[], id: PageId = "home"): Promise<Handled[]> {
  const handled = await serve(page, pages);
  await page.goto(ORIGIN + PAGES[id].path, { waitUntil: "load" });
  return handled;
}

const renderOptions = { stylesheets: DESIGN_CSS, formAction: FIXTURE_FORM_ACTION, siteUrl: FIXTURE_SITE_URL };

const openDocument = (page: Page, doc: SiteDocumentInput, id?: PageId): Promise<Handled[]> =>
  openPages(page, render(doc, renderOptions).pages, id);

/** The fixture's page in the given design (A12), or in its own design when none is given. */
const open = (page: Page, name: FixtureName, design?: DesignId, id?: PageId): Promise<Handled[]> =>
  openDocument(page, inDesign(loadFixture(name), design), id);

/** The baseline sheet (styles/sheets/baseline.css, compiled by `pnpm build:css`): today's page's sheet. */
const BASELINE_CSS = readFileSync(new URL("../packages/renderer/styles/out/baseline.css", import.meta.url), "utf8");

/**
 * Today's page (BASELINE) for the fixture, with the baseline sheet, in the fixture's own lettering or the one
 * given. It is built only from files that no design build may change (A12 §9), so a design's own traits (a
 * hero that clips, a scroll padding that keeps focus clear of the call bar) can never hide what a RED proof
 * checks (A12-0 round-2 attack, I-1).
 */
function openToday(page: Page, name: FixtureName, font?: FontId, id?: PageId): Promise<Handled[]> {
  const options = { stylesheets: stubStylesheets(BASELINE_CSS), formAction: FIXTURE_FORM_ACTION, siteUrl: FIXTURE_SITE_URL };
  const doc = loadFixture(name);
  const input = font === undefined ? doc : { ...doc, theme: { ...doc.theme, font } };
  return openPages(page, renderDocument(SiteDocument.parse(input), BASELINE, options).pages, id);
}

/**
 * The page matrix (moderator M6): Home and /contact run in every project, phones included; Services, About and
 * Gallery run only in the projects named here. One list, by project name; a test below fails when a name is
 * not a project of playwright.config.ts, so a rename cannot silently drop the inner pages.
 */
const INNER_PAGE_PROJECTS: readonly string[] = ["chromium-390", "chromium-1200"];
const runsPage = (id: PageId, project: string): boolean => id === "home" || id === "contact" || INNER_PAGE_PROJECTS.includes(project);

/**
 * The screenshot matrix, page by project: Home and /contact on the four desktop projects, the inner pages on the
 * INNER_PAGE_PROJECTS. A missing baseline fails ("A snapshot doesn't exist") unless run with --update-snapshots; nothing skips it.
 */
const DESKTOP_PROJECTS: readonly string[] = ["chromium-390", "chromium-1200", "chromium-1920", "webkit-390"];
const SCREENSHOT_MATRIX: Readonly<Record<PageId, readonly string[]>> = {
  home: DESKTOP_PROJECTS,
  contact: DESKTOP_PROJECTS,
  services: INNER_PAGE_PROJECTS,
  about: INNER_PAGE_PROJECTS,
  gallery: INNER_PAGE_PROJECTS,
};

/**
 * The fixtures with screenshot baselines: the five that serve listed places. The three newer fixtures (an IT firm that
 * serves the whole country, a law firm, a business that serves customers worldwide) run every other check below, in
 * every design, but have no baselines (moderator ruling, 2026-10-09).
 */
const SCREENSHOT_FIXTURES: readonly FixtureName[] = ["plumber-austin", "hvac-phoenix", "roofing-extreme", "cleaning-minimal", "electrical-xss"];

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
 * Opens the header's phone menu on Home and follows its Services link, whatever the design's menu is (a <details>
 * disclosure or a :target link, both work without JavaScript), and lists what went wrong. The menu is
 * found by role and name: the navigation named "Main", then the one visible control whose text names the
 * menu. Playwright 1.63 gives <summary> no ARIA role, so that control is matched by its text among
 * summary, link and button elements.
 */
async function phoneMenuProblems(page: Page): Promise<string[]> {
  const nav = page.getByRole("navigation", { name: "Main" });
  const services = nav.getByRole("link", { name: "Services", exact: true }).filter({ visible: true });
  if ((await services.count()) > 0) return ["the Services link shows before the menu opens"];
  const toggle = nav.locator("summary, a, button").filter({ hasText: /menu/i, visible: true });
  const toggles = await toggle.count();
  if (toggles !== 1) return [`${toggles} visible menu controls`];
  await toggle.click();
  const shown = await services.first().waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false);
  if (!shown) return ["the Services link stays hidden after the menu opens"];
  await services.first().click();
  return (await page.waitForURL(`${ORIGIN}${PAGES.services.path}`, { timeout: 5_000 }).then(() => true, () => false)) ? [] : [`the Services link leads to ${page.url()}`];
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

/** Today's sticky call bar, put back on /contact (its bar is static there now) for the RED proofs that need one that sticks. */
const STICKY_BAR_CSS = 'aside[aria-label="Call us"]{position:sticky!important;bottom:0!important;z-index:10!important}';

/** The phone windows the /contact call bar check runs at (heights around 915-1040 px were where Send covered a sticky bar). */
const CALL_BAR_HEIGHTS = [844, 900, 932, 1024] as const;
/** The projects that run it: both engines at 390 px, where the call bar shows. One list, checked against the config below. */
const CALL_BAR_PROJECTS: readonly string[] = ["chromium-390", "webkit-390"];

/**
 * Lists where the call bar and Send get in each other's way on /contact, in three views: at load, after Send is
 * scrolled to the middle of the window, and after the bar itself is scrolled to the bottom. In each view a bar
 * link that is in the window must be wholly inside it, must answer elementFromPoint at its centre and corners,
 * and Send's box must not meet the bar's. (The bar may sit below the fold at load: it is static on /contact.)
 */
async function callBarProblems(page: Page): Promise<string[]> {
  const send = page.getByRole("button", { name: "Send request" });
  const bar = page.locator('aside[aria-label="Call us"]');
  const look = (view: string) =>
    page.evaluate((view) => {
      const sendBox = document.querySelector("button[type=submit]")?.getBoundingClientRect();
      const barBox = document.querySelector('aside[aria-label="Call us"]')?.getBoundingClientRect();
      if (!sendBox || !barBox) return [`${view}: no Send button or call bar`];
      const problems: string[] = [];
      if (sendBox.top < barBox.bottom && sendBox.bottom > barBox.top) problems.push(`${view}: Send's box meets the bar's`);
      for (const link of document.querySelectorAll<HTMLAnchorElement>('aside[aria-label="Call us"] a')) {
        const box = link.getBoundingClientRect();
        if (box.bottom <= 0 || box.top >= window.innerHeight) continue; // below the fold: not in this view
        if (box.top < 0 || box.bottom > window.innerHeight) problems.push(`${view}: "${link.textContent?.trim()}" is cut off by the window`);
        // The corners, pulled in along the diagonal to where a rounded button's own edge is (a pill has no corner at the box's).
        const radius = Math.min(parseFloat(getComputedStyle(link).borderTopLeftRadius) || 0, box.height / 2, box.width / 2);
        const inset = radius * (1 - Math.SQRT1_2) + 2;
        const points = [[0.5, 0.5], [0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [box.left + inset + (box.width - 2 * inset) * x!, box.top + inset + (box.height - 2 * inset) * y!] as const);
        for (const [x, y] of points) {
          if (document.elementFromPoint(x, y)?.closest("a") !== link) problems.push(`${view}: "${link.textContent?.trim()}" is covered at ${Math.round(x)},${Math.round(y)}`);
        }
      }
      return problems;
    }, view);
  const problems = await look("at load");
  await send.evaluate((el) => el.scrollIntoView({ block: "center" }));
  problems.push(...(await look("with Send in view")));
  await bar.evaluate((el) => el.scrollIntoView({ block: "end" }));
  problems.push(...(await look("with the bar in view")));
  return problems;
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


/** The one visible control that opens the header's phone menu (a <summary>, link or button named "Menu"); none above the menu's breakpoint. */
const menuToggle = (page: Page): Locator =>
  page.getByRole("navigation", { name: "Main" }).locator("summary, a, button").filter({ hasText: /menu/i, visible: true });

/** The visible links in the header's nav to a page. */
const headerLinks = (page: Page, id: PageId): Locator =>
  page.getByRole("navigation", { name: "Main" }).locator(`a[href="${PAGES[id].path}"]`).filter({ visible: true });

/**
 * Follows the header's link to a page, opening the phone menu first when no link shows (WCAG 2.4.5: a visitor
 * reaches every page from any page, whatever the width). Works with JavaScript off.
 */
async function followHeader(page: Page, id: PageId): Promise<void> {
  if ((await headerLinks(page, id).count()) === 0) await menuToggle(page).click();
  await headerLinks(page, id).first().click();
  await page.waitForURL(ORIGIN + PAGES[id].path, { timeout: 5_000 });
}

/**
 * The pages with no header link a visitor can use here. When none shows at all the nav is behind a menu, so the
 * menu is opened once and looked at again (a nav with some inline links is never behind one).
 */
async function unreachablePages(page: Page, ids: readonly PageId[]): Promise<string[]> {
  const missing = async (): Promise<PageId[]> => {
    const counts = await Promise.all(ids.map(async (id) => ({ id, shown: await headerLinks(page, id).count() })));
    return counts.filter(({ shown }) => shown === 0).map(({ id }) => id);
  };
  let lacking = await missing();
  if (lacking.length === ids.length && (await menuToggle(page).count()) === 1) {
    await menuToggle(page).click();
    lacking = await missing();
  }
  return lacking.map((id) => `no header link to ${PAGES[id].path}`);
}

/** How many links to "/contact#quote" show on the page at this width (the call bar below its breakpoint, the closing band above it). */
const visibleQuoteLinks = (page: Page): Promise<number> => page.locator('a[href="/contact#quote"]').filter({ visible: true }).count();

/**
 * Lists what is wrong with the quote form's Name field where a visitor has landed: missing, not wholly in the
 * window, or covered (by a sticky bar or header). Works with JavaScript off. The field is judged where it is:
 * elementFromPoint at its centre and corners must return the field itself. (A trial click would not do: when
 * something covers the target Playwright scrolls on its retries, so a covered field passes once it is scrolled clear.)
 */
async function nameFieldProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const name = document.querySelector<HTMLElement>("#contact-name");
    if (!name) return ["no Name field on the page"];
    const box = name.getBoundingClientRect();
    if (box.top < 0 || box.left < 0 || box.bottom > window.innerHeight || box.right > document.documentElement.clientWidth) return ["the Name field is not wholly in the window"];
    // The corners, pulled in along the diagonal to where a rounded field's own edge is.
    const radius = Math.min(parseFloat(getComputedStyle(name).borderTopLeftRadius) || 0, box.height / 2, box.width / 2);
    const inset = radius * (1 - Math.SQRT1_2) + 2;
    const points = [[0.5, 0.5], [0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [box.left + inset + (box.width - 2 * inset) * x!, box.top + inset + (box.height - 2 * inset) * y!] as const);
    return points.some(([x, y]) => document.elementFromPoint(x, y) !== name) ? ["the Name field is covered"] : [];
  });
}

/** Follows a link that should lead to the quote form and lists what is wrong where it lands: another address, or a Name field problem. */
async function quoteLandingProblems(page: Page, link: Locator): Promise<string[]> {
  await link.click();
  await page.waitForLoadState("load");
  const problems = page.url() === `${ORIGIN}${PAGES.contact.path}#quote` ? [] : [`landed on ${page.url()}`];
  return [...problems, ...(await nameFieldProblems(page))];
}

/** The vertical order of a page's sections, by the DOM ids given: those present, top first. */
const sectionOrder = (page: Page, ids: readonly string[]): Promise<string[]> =>
  page.evaluate(
    (ids) =>
      ids
        .flatMap((id) => {
          const el = document.getElementById(id);
          return el === null ? [] : [{ id, top: el.getBoundingClientRect().top + window.scrollY }];
        })
        .sort((a, b) => a.top - b.top)
        .map((section) => section.id),
    [...ids],
  );

/** The opening hours of a fixture as its page writes them ("7:30 AM – 6:00 PM", "Open 24 hours"), each once; none when it has no hours. */
const hoursTimes = (name: FixtureName): string[] => {
  const hours = loadFixture(name).facts.hours ?? [];
  return hours.length === 0 ? [] : [...new Set(weeklyHours(hours).map((row) => row.time))];
};

/** The ids of a fixture's rendered pages, Home first (the same in every design). */
const pagesOf = (name: FixtureName): PageId[] => renderFixture(name).map((p) => p.page);

// Every check below runs in every page design (A12), on every page of the fixture the matrix lets the project run.
for (const design of DESIGN_IDS) {
  test.describe(design, () => {
    for (const name of FIXTURES) {
      test.describe(name, () => {
        for (const id of pagesOf(name)) {
          test.describe(id, () => {
            test.beforeEach(async ({ page }, testInfo) => {
              test.skip(!runsPage(id, testInfo.project.name), "inner pages run in the INNER_PAGE_PROJECTS only");
              await open(page, name, design, id);
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

            if (id === "contact") {
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
            }

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

            test("reaches every page of the site from the header (WCAG 2.4.5)", MOBILE, async ({ page }) => {
              expect(await unreachablePages(page, pagesOf(name))).toEqual([]);
            });

            // Below its breakpoint the call bar carries the link, above it the closing band; Contact is the form itself.
            if (id !== "contact") {
              test("shows a link to the quote form", MOBILE, async ({ page }) => {
                expect(await visibleQuoteLinks(page)).toBeGreaterThan(0);
              });
            }

            if (id === "contact" && hoursTimes(name).length > 0) {
              test("shows the opening hours", MOBILE, async ({ page }) => {
                for (const time of hoursTimes(name)) await expect(page.getByText(time).filter({ visible: true }).first()).toBeVisible();
              });
            }

            if (SCREENSHOT_FIXTURES.includes(name)) {
              test("matches the screenshot baseline", async ({ page }, testInfo) => {
                test.skip(!SCREENSHOT_MATRIX[id].includes(testInfo.project.name), "not in the SCREENSHOT_MATRIX");
                await expect(page).toHaveScreenshot([design, name, `${id}.png`], { fullPage: true, stylePath: SCREENSHOT_CSS });
              });
            }
          });
        }
      });
    }

    test("the contact form's honeypot field lies wholly off-screen", MOBILE, async ({ page }) => {
      await open(page, "plumber-austin", design, "contact");
      expect(await honeypotOffScreen(page)).toBe(true);
    });

    test("keyboard focus reaches the contact form but never its honeypot field", async ({ page, browserName }) => {
      await open(page, "plumber-austin", design, "contact");
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
            await open(page, "plumber-austin", design, "contact");
            expect(await tapSend(page, input, offset)).toEqual({ clicked: "BUTTON Send request", posts: 1 });
          });
        }
      });
    }

    // On /contact the form sits near the first screen and Send stacks above the call bar, so a sticky bar there
    // let Send cover its buttons on phones about 915-1040 px tall (WCAG 2.5.8); the bar is static on that page.
    for (const height of CALL_BAR_HEIGHTS) {
      test.describe(`at 390 x ${height}`, () => {
        test.use({ viewport: { width: 390, height } });

        test("the /contact call bar never overlaps Send", async ({ page }, testInfo) => {
          test.skip(!CALL_BAR_PROJECTS.includes(testInfo.project.name), "checked in CALL_BAR_PROJECTS");
          await open(page, "plumber-austin", design, "contact");
          expect(await callBarProblems(page)).toEqual([]);
        });
      });
    }

    test.describe("with JavaScript disabled", () => {
      test.use({ javaScriptEnabled: false });

      test("the FAQ accordion is exclusive", async ({ page }) => {
        await open(page, "plumber-austin", design, "services");
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

    for (const id of pagesOf("electrical-xss")) {
      test(`XSS payloads never execute on ${id}`, async ({ page }, testInfo) => {
        test.skip(!runsPage(id, testInfo.project.name), "inner pages run in the INNER_PAGE_PROJECTS only");
        const payload = "<img src=x onerror=alert(1)>";
        const dialogs: string[] = [];
        page.on("dialog", async (dialog) => {
          dialogs.push(dialog.message());
          await dialog.dismiss();
        });
        await open(page, "electrical-xss", design, id);
        for (const field of await page.locator("input:not([tabindex='-1']), select, textarea").all()) await field.focus();
        await page.mouse.move(10, 10);
        await page.locator("h1").hover();
        expect(dialogs).toEqual([]);
        expect(await page.locator("img[src='x']").count()).toBe(0);
        expect(await page.title()).toBe(id === "home" ? payload : `${PAGES[id].label} | ${payload}`);
        await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", ORIGIN + PAGES[id].path);
        // The business (the block with a name; its @type is the trade's schema.org type, Electrician here) is on Home only, and holds the payload as text.
        const blocks = (await page.locator('script[type="application/ld+json"]').allTextContents()).map((ld) => JSON.parse(ld) as { name?: string });
        expect(blocks.flatMap((block) => block.name ?? [])).toEqual(id === "home" ? [payload] : []);
      });
    }

    // The owner's order inside a page (U1): roofing-extreme puts reviews before credentials on Home and the service
    // area before the form on /contact. plumber-austin has the default order, which shows the check tells them apart.
    test("draws the sections in the owner's order inside a page (U1)", MOBILE, async ({ page }) => {
      const home = [DOM_ID.trust, DOM_ID.testimonials];
      const contact = [DOM_ID.contact, DOM_ID.serviceArea];
      await open(page, "roofing-extreme", design);
      expect(await sectionOrder(page, home)).toEqual([DOM_ID.testimonials, DOM_ID.trust]);
      await open(page, "roofing-extreme", design, "contact");
      expect(await sectionOrder(page, contact)).toEqual([DOM_ID.serviceArea, DOM_ID.contact]);
      await open(page, "plumber-austin", design);
      expect(await sectionOrder(page, home)).toEqual([DOM_ID.trust, DOM_ID.testimonials]);
      await open(page, "plumber-austin", design, "contact");
      expect(await sectionOrder(page, contact)).toEqual([DOM_ID.contact, DOM_ID.serviceArea]);
    });

    // The journeys of a visitor on plumber-austin (the fixture with every page), with JavaScript on and off.
    for (const javaScriptEnabled of [true, false]) {
      test.describe(`journeys with JavaScript ${javaScriptEnabled ? "on" : "off"}`, () => {
        test.use({ javaScriptEnabled });

        test("every page is reached from Home through the header, and the brand link returns Home", async ({ page }) => {
          await open(page, "plumber-austin", design);
          for (const id of pagesOf("plumber-austin").filter((other) => other !== "home")) {
            await followHeader(page, id);
            await expect(page.locator("h1")).toHaveCount(1);
            await page.locator('header a[href="/"]:not(nav a)').first().click();
            await page.waitForURL(`${ORIGIN}/`, { timeout: 5_000 });
          }
        });

        test("Get a quote on Home (the call bar on a phone, the hero above it) lands on the form with the Name field in view", async ({ page }) => {
          await open(page, "plumber-austin", design);
          const link = isPhoneProject(page) ? page.locator('aside[aria-label="Call us"] a[href="/contact#quote"]') : page.locator('#top a[href="/contact#quote"]').first();
          expect(await quoteLandingProblems(page, link)).toEqual([]);
        });

        test("Get a quote on an inner page (the call bar on a phone, the closing band above it) lands on the form with the Name field in view", async ({ page }) => {
          await open(page, "plumber-austin", design, "services");
          const link = isPhoneProject(page) ? page.locator('aside[aria-label="Call us"] a[href="/contact#quote"]') : page.locator('#get-in-touch a[href="/contact#quote"]');
          expect(await quoteLandingProblems(page, link)).toEqual([]);
        });
      });
    }

    test("the service select has the same size and shape as the text fields", async ({ page }) => {
      await open(page, "plumber-austin", design, "contact");
      expectSameShape(await fieldShape(page, "#contact-service"), await fieldShape(page, "#contact-name"));
    });
  });
}

test.describe("the harness", () => {
  test("serves every request from memory: a page, a gray image or an abort, and nothing leaves the machine", async ({ page }, testInfo) => {
    // One run per engine is the proof: Chromium and WebKit (the 1200 px and the 390 px WebKit projects).
    test.skip(!["chromium-1200", "webkit-390"].includes(testInfo.project.name), "proved once in Chromium and once in WebKit");
    const requested: string[] = [];
    const addresses: unknown[] = [];
    const failures = new Map<string, string>();
    page.on("request", (request) => requested.push(request.url()));
    page.on("requestfailed", (request) => failures.set(request.url(), request.failure()?.errorText ?? ""));
    page.on("response", async (response) => addresses.push(await response.serverAddr()));
    const handled = await open(page, "plumber-austin");
    // Reaches for the outside world: an image and a fetch from another host, a form post, a stylesheet.
    const outcomes = await page.evaluate(async () => {
      const img = new Image();
      const loaded = new Promise((resolve) => {
        img.onload = () => resolve("loaded");
        img.onerror = () => resolve("failed");
      });
      img.src = "https://images.example.net/photo.png";
      const fetched = await fetch("https://api.example.net/data").then(() => "reached", () => "refused");
      const posted = await fetch("https://forms.example.com/submit", { method: "POST", body: "x" }).then(() => "reached", () => "refused");
      return { image: await loaded, fetched, posted };
    });
    expect(outcomes).toEqual({ image: "loaded", fetched: "refused", posted: "refused" });
    // Every http(s) request the page made went through the harness, and the harness only fulfilled or aborted.
    expect(requested.filter((url) => /^https?:/.test(url)).sort()).toEqual(handled.map((h) => h.url).sort());
    expect(handled.filter((h) => h.how === "aborted").map((h) => h.url)).toEqual(["https://api.example.net/data", "https://forms.example.com/submit"]);
    expect(handled.filter((h) => h.how === "page").map((h) => h.url)).toEqual([`${ORIGIN}/`]);
    // Each abort failed with route.abort()'s own reason (Chromium and WebKit word it differently), not with a name lookup or
    // a connection error, which is what a request that was let out (route.continue()) would have failed with.
    const aborted = ["https://api.example.net/data", "https://forms.example.com/submit"];
    await expect.poll(() => aborted.map((url) => failures.get(url))).toEqual(aborted.map(() => (testInfo.project.name.startsWith("webkit") ? "Blocked by Web Inspector" : "net::ERR_FAILED")));
    // A fulfilled response has no server behind it.
    expect(addresses.every((address) => address === null)).toBe(true);
  });

  test("the inner-page, call bar and desktop projects are projects of the config", async ({}, testInfo) => {
    const names = testInfo.config.projects.map((project) => project.name);
    expect([...INNER_PAGE_PROJECTS, ...CALL_BAR_PROJECTS].filter((name) => !names.includes(name))).toEqual([]);
    // The screenshot matrix's desktop list is exactly the config's non-phone projects: a rename or an added project fails here.
    expect([...DESKTOP_PROJECTS]).toEqual(testInfo.config.projects.filter((project) => project.metadata["phone"] !== true).map((project) => project.name));
  });
});

test("holds exactly the screenshot baselines of the SCREENSHOT_MATRIX, and no other file", async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-1200", "reads the baseline folder once");
  const folder = fileURLToPath(new URL("./fixtures.spec.ts-snapshots/", import.meta.url));
  expect(readdirSync(folder).sort()).toEqual([...DESIGN_IDS].sort());
  for (const design of DESIGN_IDS) {
    const expected = SCREENSHOT_FIXTURES.flatMap((name) => pagesOf(name).flatMap((id) => SCREENSHOT_MATRIX[id].map((project) => `${name}/${id}-${project}-darwin.png`))).sort();
    const found = readdirSync(`${folder}${design}`, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => `${entry.parentPath.slice(`${folder}${design}`.length + 1)}/${entry.name}`)
      .sort();
    expect({ design, found }).toEqual({ design, found: expected });
  }
});

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
    await openToday(page, "plumber-austin", undefined, "contact");
    await page.addStyleTag({ content: "div:has(> #contact-website){left:0!important}" });
    expect(await honeypotOffScreen(page)).toBe(false);
  });

  test("the phone menu check sees a menu that does not open", async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) >= 1024, "the menu is replaced by inline links on wide screens");
    await openToday(page, "plumber-austin");
    await page.addStyleTag({ content: 'nav[aria-label="Main"] ul{display:none!important}' });
    expect(await phoneMenuProblems(page)).toEqual(["the Services link stays hidden after the menu opens"]);
  });

  test("the focus check sees a honeypot field that keyboard focus can reach", async ({ page, browserName }) => {
    await openToday(page, "plumber-austin", undefined, "contact");
    await page.locator("#contact-website").evaluate((field) => field.removeAttribute("tabindex"));
    expect(await focusedIds(page, browserName)).toContain("contact-website");
  });

  test("the focus check sees a field hidden under a call bar that always sticks", async ({ page, browserName }) => {
    test.skip(!isPhoneProject(page), "the call bar only shows below 768 px");
    await openToday(page, "plumber-austin", undefined, "contact");
    await page.setViewportSize({ width: 390, height: 500 }); // the form's fields lie below the fold, so Tab scrolls them to the bottom edge
    await page.addStyleTag({ content: STICKY_BAR_CSS });
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
    await openToday(page, "plumber-austin", undefined, "contact");
    await page.addStyleTag({ content: "#contact-service{appearance:auto!important}" });
    const select = await fieldShape(page, "#contact-service");
    const name = await fieldShape(page, "#contact-name");
    expect(Math.abs(select.height - name.height)).toBeGreaterThan(1);
    expect(() => expectSameShape(select, name)).toThrow();
  });

  test("the select check sees a select half a pixel narrower, and allows one layout unit (1/64 px)", async ({ page }) => {
    await openToday(page, "plumber-austin", undefined, "contact");
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
    await openToday(page, "plumber-austin", undefined, "contact");
    // Today's page without the fix in styles/shared.css: Send no longer stacks above the call bar, which sticks again once focus leaves the field (as it did on /contact before the bar became static there).
    await page.addStyleTag({ content: STICKY_BAR_CSS + "html:has(:focus-visible:not(aside *)) aside{position:static!important}" + 'form button[type="submit"]{position:static!important;z-index:auto!important}' });
    expect(await tapSend(page, "mouse", 40)).toEqual({ clicked: "BODY", posts: 0 });
  });

  test("the call bar check sees Send over a sticky bar's buttons", async ({ page }, testInfo) => {
    test.skip(!CALL_BAR_PROJECTS.includes(testInfo.project.name), "checked in CALL_BAR_PROJECTS");
    // Today's page with the bar sticking on /contact, as it did before it became static there. Where Send sits in the band
    // depends on the engine's layout, so the proof looks at every window height the real check runs at: all must be
    // clean on the static bar (above), and the sticky bar must be caught at one or more.
    const caught: number[] = [];
    for (const height of CALL_BAR_HEIGHTS) {
      await page.setViewportSize({ width: 390, height });
      await openToday(page, "plumber-austin", undefined, "contact");
      await page.addStyleTag({ content: STICKY_BAR_CSS });
      if ((await callBarProblems(page)).length > 0) caught.push(height);
    }
    expect(caught.length).toBeGreaterThan(0);
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

  test("the reachability check sees a page whose header lacks a link to an existing page", MOBILE, async ({ page }) => {
    await openToday(page, "plumber-austin");
    expect(await unreachablePages(page, pagesOf("plumber-austin"))).toEqual([]);
    await page.locator('nav[aria-label="Main"] a[href="/gallery"]').evaluateAll((links) => links.forEach((link) => link.closest("li")?.remove()));
    expect(await unreachablePages(page, pagesOf("plumber-austin"))).toEqual(["no header link to /gallery"]);
  });

  test("the quote-landing check sees a link that lands on a page without the form", async ({ page }) => {
    await openToday(page, "plumber-austin");
    const hero = page.getByRole("link", { name: "Get a free quote" }).first();
    await hero.evaluate((link) => link.setAttribute("href", "/services#quote"));
    expect(await quoteLandingProblems(page, hero)).toEqual([`landed on ${ORIGIN}/services#quote`, "no Name field on the page"]);
  });

  test("the quote-landing check sees a Name field that something covers", async ({ page }) => {
    await openToday(page, "plumber-austin", undefined, "contact");
    await page.locator("#contact-name").scrollIntoViewIfNeeded();
    expect(await nameFieldProblems(page)).toEqual([]);
    await page.addStyleTag({ content: 'body::after{content:"";position:fixed;inset:0;z-index:50}' });
    expect(await nameFieldProblems(page)).toEqual(["the Name field is covered"]);
  });

  test("the quote-landing check sees a sticky header that covers the Name field where the visitor lands", async ({ page }) => {
    await openToday(page, "plumber-austin", undefined, "contact");
    await page.addStyleTag({ content: "header{position:sticky!important;top:0!important;z-index:50!important;min-height:120px!important}" });
    await page.locator("#contact-name").evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 24));
    expect(await nameFieldProblems(page)).toEqual(["the Name field is covered"]);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator("#contact-name").evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 200));
    expect(await nameFieldProblems(page)).toEqual([]);
  });

  test("the visible-quote check sees a page whose only quote link is hidden at 1200", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-1200", "the window is set here, so one run proves it");
    await openToday(page, "plumber-austin", undefined, "services");
    expect(await visibleQuoteLinks(page)).toBeGreaterThan(0); // the closing band's link; the call bar hides from 768 px
    await page.addStyleTag({ content: "#get-in-touch a[href='/contact#quote']{display:none!important}" });
    expect(await visibleQuoteLinks(page)).toBe(0);
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
