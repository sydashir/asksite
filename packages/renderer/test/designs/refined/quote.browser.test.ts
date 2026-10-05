// Classic's quote rule (moderator, 2026-10-05): the first screen of every page but Contact (whose first screen is the
// form itself) offers the quote in exactly one label, in every window. The owner's words (copy.ctaText) in the header,
// the hero, the Services box or the closing band, or the call bar's fixed "Get a quote", never both: where the call bar
// carries the quote (phones, and windows under 32rem tall such as a phone held sideways) the page leaves the quote to
// it, on every screen, not only the first (ruling, 2026-10-05), so a phone held sideways is also scrolled one screen at
// a time. Classic has no per-item quote link, so every link to the form counts. Each fixture's whole site, plus an
// owner with one service and questions (the Services box then sits on a phone's first screen), with the real Classic
// sheet, served on the fixtures' origin from memory as in journey.browser.test.ts, in Chromium and WebKit.
// Where the call bar carries the quote, the closing band shows the large number to tap instead, so the same sites are
// also read with the bigger default text (root font size 125%, moderator 2026-10-05): every page of every fixture, in
// every lettering at 320-430 px and in its own at the reflow widths 600-1920 px, with every <details> but the phone menu
// open (the questions' answers; controller ruling, 2026-10-05), loses no text (no sideways scroll, nothing cut by its
// box or past the page's edge) and breaks a phone number only between its parts.
// The pages run no JavaScript; the checks are script text, since the renderer's TypeScript program has no DOM types.
import { chromium, webkit, type Browser, type BrowserType, type Page } from "@playwright/test";
import { FONT_IDS, PAGES } from "@asksite/site-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURES, FIXTURE_SITE_URL, loadFixture } from "../../../../../fixtures/index.ts";
import type { RenderedSite } from "../../../src/render.ts";
import { classicSite } from "./site.ts";

const ORIGIN = new URL(FIXTURE_SITE_URL).origin;
const GRAY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEUlEQVR42mM4ffUhHDHg5AAASSceDT8mdlEAAAAASUVORK5CYII=", "base64");
const plumber = loadFixture("plumber-austin");
const oneService = {
  ...plumber,
  facts: { ...plumber.facts, services: plumber.facts.services.slice(0, 1) },
  copy: { ...plumber.copy, serviceDescriptions: plumber.copy.serviceDescriptions.slice(0, 1) },
};
const SITES: ReadonlyArray<readonly [string, RenderedSite]> = [
  ...FIXTURES.map((name) => [name, classicSite(loadFixture(name))] as const),
  ["plumber-austin with one service", classicSite(oneService)],
];
/** Phones, the narrowest first. */
const PHONES = [320, 340, 360, 375, 390, 400, 414, 430] as const;
/** Where the layout reflows from phones up (the sheet's steps and either side of them), to a wide desktop. */
const REFLOW = [600, 768, 900, 1023, 1024, 1040, 1060, 1079, 1080, 1199, 1280, 1440, 1920] as const;
/** Every fixture's whole site in each lettering, for the bigger default text: phones in every lettering, and the reflow widths in the fixture's own. */
const LETTERED: ReadonlyArray<{ readonly name: string; readonly site: RenderedSite; readonly widths: readonly number[] }> = FIXTURES.flatMap((fixture) =>
  FONT_IDS.map((font) => {
    const doc = loadFixture(fixture);
    const own = font === doc.theme.font;
    return { name: `${fixture} ${font}`, site: classicSite({ ...doc, theme: { ...doc.theme, font } }), widths: own ? [...PHONES, ...REFLOW] : PHONES };
  }),
);
let site: RenderedSite | undefined;

/** Phones held sideways (the iPhone 13, the iPhone Pro Max, the Pixel 7): at least 48rem wide, under 32rem tall. */
const SIDEWAYS = [
  [844, 390],
  [932, 430],
  [915, 412],
] as const;
/** Phones, tablets, laptops and phones held sideways. */
const WINDOWS = [[390, 844], [768, 1024], [900, 800], [1023, 768], [1280, 800], ...SIDEWAYS] as const;

/** The distinct labels of the links to the quote form that are drawn (not display:none or hidden) on the screen in view. */
const QUOTE_LABELS = `[...new Set([...document.querySelectorAll('a[href="/contact#quote"]')].filter((a) => {
  const box = a.getBoundingClientRect();
  return getComputedStyle(a).visibility === "visible" && box.width > 0 && box.height > 0 &&
    box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth;
}).map((a) => a.textContent.replace(/\\s+/g, " ").trim()))]`;

/**
 * The bigger default text: a visitor's text-size setting at 125%, the root font size 20 px. Transitions are off, so what
 * is measured is the settled page, never a button's padding or text still on its way from the 100% size.
 */
const BIGGER_TEXT = "html{font-size:125%!important}*,::before,::after{transition:none!important}";
/** Every <details> open but the phone menu (the questions' accordion leaves its group first, so all stay open). */
const OPEN_DETAILS = `for (const d of document.querySelectorAll("details:not(.menu)")) { d.removeAttribute("name"); d.open = true; }`;
/**
 * Plain wrapping forced on the big number and the Service area's buttons, as an engine without text-wrap:balance would
 * wrap them (Safari before 17.5; the floor is iOS 16.4; review rf125, addendum 3): the number must still break only
 * between its parts.
 */
const PLAIN_WRAP = ".c-ph,.pg-a .bt{text-wrap:wrap!important}";

/**
 * The text a visitor cannot read whole, as "problem" strings: the page scrolling sideways, a piece of text cut by a box
 * that clips its overflow or past the page's left or right edge, and a word of a phone number (a tel: link) split over
 * two lines. Text that is not drawn (screen-reader only, the honeypot, a closed menu) and the select's own text (the
 * browser draws it) are left out.
 */
const LOST_TEXT = `(() => {
  const out = [];
  const width = document.documentElement.clientWidth;
  const sideways = document.documentElement.scrollWidth - width;
  if (sideways > 0) out.push("scrolls sideways by " + sideways + " px");
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (parent === null || !node.data.trim() || parent.closest(".sr-only, .hp, select, script, style")) continue;
    if (!parent.checkVisibility({ visibilityProperty: true })) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0.5);
    const text = JSON.stringify(node.data.trim().slice(0, 24));
    for (let box = parent; box !== document.body; box = box.parentElement) {
      const style = getComputedStyle(box);
      const clipX = style.overflowX !== "visible", clipY = style.overflowY !== "visible";
      if (!clipX && !clipY) continue;
      const b = box.getBoundingClientRect();
      if (rects.some((r) => (clipX && (r.left < b.left - 1 || r.right > b.right + 1)) || (clipY && (r.top < b.top - 1 || r.bottom > b.bottom + 1)))) out.push(text + " cut by its box");
    }
    if (rects.some((r) => r.left < -1 || r.right > width + 1)) out.push(text + " past the page's edge");
    if (parent.closest('a[href^="tel:"]') === null) continue;
    for (const word of node.data.matchAll(/\\S+/g)) {
      const part = document.createRange();
      part.setStart(node, word.index);
      part.setEnd(node, word.index + word[0].length);
      const lines = new Set([...part.getClientRects()].filter((r) => r.width > 0.5).map((r) => Math.round(r.bottom)));
      if (lines.size > 1) out.push(JSON.stringify(word[0]) + " of a phone number split over " + lines.size + " lines");
    }
  }
  return [...new Set(out)];
})()`;

/** A browser whose tab is served the current site on the fixtures' origin from memory (photos are a gray tile, anything else is aborted). */
async function launch(engine: BrowserType): Promise<{ browser: Browser; page: Page }> {
  const browser = await engine.launch();
  const context = await browser.newContext();
  await context.route(/^https?:\/\//, (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const found = url.origin === ORIGIN && request.method() === "GET" ? site?.pages.find((p) => p.path === url.pathname) : undefined;
    if (found !== undefined) return route.fulfill({ body: found.html, contentType: "text/html; charset=utf-8" });
    if (request.resourceType() === "image") return route.fulfill({ body: GRAY_PNG, contentType: "image/png" });
    return route.abort();
  });
  return { browser, page: await context.newPage() };
}

describe.each([
  ["Chromium", chromium],
  ["WebKit", webkit],
] as const)("Classic's quote on the first screen in %s", (_name, engine) => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    ({ browser, page } = await launch(engine));
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);

  it("offers the quote in exactly one label on the first screen of every page but Contact, upright and sideways", async () => {
    const problems: string[] = [];
    for (const [width, height] of WINDOWS) {
      await page.setViewportSize({ width, height });
      for (const [name, each] of SITES) {
        site = each;
        for (const { page: id } of each.pages.filter((p) => p.page !== "contact")) {
          await page.goto(ORIGIN + PAGES[id].path, { waitUntil: "load" });
          const labels = (await page.evaluate(QUOTE_LABELS)) as string[];
          if (labels.length !== 1) problems.push(`${name} ${id} at ${width}x${height}: ${JSON.stringify(labels)}`);
        }
      }
    }
    expect(problems).toEqual([]);
  }, 240_000);

  it("never offers two quote labels on any screen of a page held sideways, scrolled one screen at a time", async () => {
    const problems: string[] = [];
    for (const [width, height] of SIDEWAYS) {
      await page.setViewportSize({ width, height });
      for (const [name, each] of SITES) {
        site = each;
        for (const { page: id } of each.pages.filter((p) => p.page !== "contact")) {
          await page.goto(ORIGIN + PAGES[id].path, { waitUntil: "load" });
          const total = (await page.evaluate("document.documentElement.scrollHeight")) as number;
          for (let top = 0; top < total; top += height) {
            await page.evaluate(`scrollTo(0, ${top})`);
            const labels = (await page.evaluate(QUOTE_LABELS)) as string[];
            if (labels.length > 1) problems.push(`${name} ${id} at ${width}x${height}, scrolled to ${top} px: ${JSON.stringify(labels)}`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  }, 240_000);
});

describe.each([
  ["Chromium", chromium],
  ["WebKit", webkit],
] as const)("Classic with the bigger default text in %s", (_name, engine) => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    ({ browser, page } = await launch(engine));
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);

  it.each([
    ["as built", ""],
    ["with plain wrapping forced where a sheet might balance", PLAIN_WRAP],
  ])("loses no text on any page of any fixture at root font size 125%, %s: 320-430 px in every lettering, 600-1920 px in its own", async (_case, css) => {
    const problems: string[] = [];
    for (const { name, site: each, widths } of LETTERED) {
      site = each;
      for (const { page: id } of each.pages) {
        await page.setViewportSize({ width: PHONES[0], height: 800 });
        await page.goto(ORIGIN + PAGES[id].path, { waitUntil: "load" });
        await page.addStyleTag({ content: BIGGER_TEXT + css });
        await page.evaluate(OPEN_DETAILS);
        await page.evaluate("document.fonts.ready");
        for (const width of widths) {
          await page.setViewportSize({ width, height: 800 });
          for (const problem of (await page.evaluate(LOST_TEXT)) as string[]) problems.push(`${name} ${id} at ${width}: ${problem}`);
        }
      }
    }
    expect(problems).toEqual([]);
  }, 240_000);
});
