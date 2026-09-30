// Classic's sheet in a real browser, where the cascade decides which rule wins (the pairs test checks tokens, not
// rule order or specificity): hover colours, the rows phones leave out, link underlines, the phone call bar, the
// About title and the header's stacking. Laid out by the repo's own Playwright Chromium and WebKit with the real
// Classic sheet. Each check has a RED proof: a style override that puts the flaw back is caught.
import { chromium, webkit, type Browser, type Page } from "@playwright/test";
import { FONT_IDS, PALETTE_IDS, type SiteDocumentInput } from "@asksite/site-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DESIGN_CSS, FIXTURE_FORM_ACTION, loadFixture } from "../../../../../fixtures/index.ts";
import { render } from "../../../src/render.ts";

const refined = (doc: SiteDocumentInput, theme: Partial<SiteDocumentInput["theme"]> = {}): SiteDocumentInput => ({
  ...doc,
  theme: { ...doc.theme, ...theme, design: "refined" },
});
const plumber = loadFixture("plumber-austin");
const hvac = loadFixture("hvac-phoenix");
const cleaning = loadFixture("cleaning-minimal");

/**
 * Run in the page, so written as script text (the renderer's TypeScript program has no DOM types). The contrast of
 * each element's computed text colour on its computed background, as "selector: ratio" for the ones under `min`.
 */
const LOW_CONTRAST = `([selectors, min]) => {
  const rgb = (c) => (c.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  return selectors.flatMap((selector) => {
    const el = document.querySelector(selector);
    if (!el) return [selector + ": missing"];
    const style = getComputedStyle(el);
    const r = ratio(style.color, style.backgroundColor);
    return r < min ? [selector + ": " + r.toFixed(2) + " (" + style.color + " on " + style.backgroundColor + ")"] : [];
  });
}`;

/** The computed display of every element each selector matches, as "selector=display" pairs in page order. */
const DISPLAYS = `(selectors) => selectors.flatMap((s) => [...document.querySelectorAll(s)].map((el) => s + "=" + getComputedStyle(el).display))`;

/** Each selector's elements whose text is not underlined, as "selector: text". */
const NOT_UNDERLINED = `(selectors) => selectors.flatMap((s) => [...document.querySelectorAll(s)]
  .filter((el) => !getComputedStyle(el).textDecorationLine.includes("underline"))
  .map((el) => s + ": " + el.textContent.trim().slice(0, 30)))`;

/** The call bar's height, and each of its buttons whose visible text runs onto a second line. */
const CALL_BAR = `(() => {
  const bar = document.querySelector("aside");
  const lines = (el) => { const r = document.createRange(); r.selectNodeContents(el); return new Set([...r.getClientRects()].filter((x) => x.width > 2 && x.height > 2).map((x) => Math.round(x.top / 4))).size; };
  const [call, quote] = bar.querySelectorAll("a");
  const label = call.querySelector(".bt-t > span") || call;
  return { height: Math.round(bar.getBoundingClientRect().height), wrapped: [lines(label) > 1 && "call", lines(quote) > 1 && "quote"].filter(Boolean) };
})()`;

const ENGINES = { chromium, webkit } as const;

describe.each(Object.keys(ENGINES) as Array<keyof typeof ENGINES>)("Classic's cascade in %s", (engine) => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await ENGINES[engine].launch();
    page = await browser.newPage();
    await page.route(/^https?:\/\//, (route) => route.abort());
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });

  async function open(doc: SiteDocumentInput, width: number, css = ""): Promise<void> {
    await page.setViewportSize({ width, height: 900 });
    await page.setContent(render(doc, { stylesheets: DESIGN_CSS, formAction: FIXTURE_FORM_ACTION }).html, { waitUntil: "load" });
    if (css) await page.addStyleTag({ content: css });
  }

  /** Every outline button's hover state below AA contrast, per palette (a desktop pointer can hover). */
  async function hoverProblems(css = ""): Promise<string[]> {
    const found: string[] = [];
    for (const palette of PALETTE_IDS) {
      await open(refined(plumber, { palette }), 1280, css);
      for (const selector of [".hd-q", ".ha .bt-out", ".cta-row .bt-out"]) {
        await page.hover(selector);
        await page.waitForTimeout(250); // the .15s colour transition
        found.push(...((await page.evaluate(`(${LOW_CONTRAST})(${JSON.stringify([[selector], 4.5])})`)) as string[]).map((p) => `${palette} ${p}`));
        await page.mouse.move(0, 0);
      }
    }
    return found;
  }

  it("keeps an outline button's label readable on hover, the mid-page one included, in every palette", async () => {
    expect(await hoverProblems()).toEqual([]);
  }, 120_000);

  it("RED: catches a later rule that keeps the mid-page button white on hover", async () => {
    expect((await hoverProblems(".cta-row .bt-out{background:var(--aw-refined-surface)!important}")).join("\n")).toMatch(/cta-row .bt-out: 1\.00/);
  }, 120_000);

  const PHONE_ROWS = [".c-list .c-more", ".c-hours.c-more", ".bc-m .bc-e"];

  it("leaves the contact band's recap rows and the card's email out on phones, and shows them from 60rem", async () => {
    await open(refined(hvac), 390);
    const phone = (await page.evaluate(`(${DISPLAYS})(${JSON.stringify(PHONE_ROWS)})`)) as string[];
    expect(phone.length).toBeGreaterThanOrEqual(4);
    expect(phone.filter((d) => !d.endsWith("=none"))).toEqual([]);
    await open(refined(hvac), 1280);
    expect(((await page.evaluate(`(${DISPLAYS})(${JSON.stringify(PHONE_ROWS)})`)) as string[]).filter((d) => d.endsWith("=none"))).toEqual([]);
  }, 60_000);

  it("RED: catches a recap row that shows on phones", async () => {
    await open(refined(hvac), 390, ".c-list li{display:flex!important}");
    expect(((await page.evaluate(`(${DISPLAYS})(${JSON.stringify(PHONE_ROWS)})`)) as string[]).filter((d) => !d.endsWith("=none"))).not.toEqual([]);
  }, 60_000);

  const LINKS = [".bc-m a", ".h247 a", ".c-list a", ".fcall a"];

  it("underlines the links in running text: the business card's, the 24/7 box's call link and the contact band's", async () => {
    for (const width of [390, 1280]) {
      await open(refined(hvac), width);
      expect(await page.evaluate(`document.querySelectorAll(".bc-m a, .h247 a").length`)).toBeGreaterThanOrEqual(2);
      expect(await page.evaluate(`(${NOT_UNDERLINED})(${JSON.stringify(LINKS)})`)).toEqual([]);
    }
  }, 60_000);

  it("RED: catches a link that lost its underline", async () => {
    await open(refined(hvac), 1280, ".h247 a{text-decoration:none!important}");
    expect(await page.evaluate(`(${NOT_UNDERLINED})(${JSON.stringify(LINKS)})`)).not.toEqual([]);
  }, 60_000);

  /** Every phone width where a call-bar button wraps or the bar leaves its one-line height, per page and lettering. */
  async function callBarProblems(css = ""): Promise<string[]> {
    const found: string[] = [];
    for (const font of FONT_IDS) {
      for (const [name, doc] of Object.entries({ plumber, hvac, cleaning })) {
        await open(refined(doc, { font }), 390, css);
        const heights = new Set<number>();
        for (const width of [320, 340, 360, 375, 384, 390, 412, 430]) {
          await page.setViewportSize({ width, height: 900 });
          const bar = (await page.evaluate(CALL_BAR)) as { height: number; wrapped: string[] };
          heights.add(bar.height);
          if (bar.wrapped.length > 0) found.push(`${font} ${name} ${width}: ${bar.wrapped.join(", ")} wraps`);
        }
        if (heights.size > 1) found.push(`${font} ${name}: heights ${[...heights].join("/")}`);
      }
    }
    return found;
  }

  it("keeps the phone call bar's buttons on one line and the bar at one height from 320 to 430 px", async () => {
    expect(await callBarProblems()).toEqual([]);
  }, 120_000);

  it("RED: catches a call bar whose quote button wraps once 'Call' shows again", async () => {
    expect(await callBarProblems(".cw{position:static!important;width:auto!important;height:auto!important;clip-path:none!important}")).not.toEqual([]);
  }, 120_000);

  it("sets the About letter's title quieter than a section title: 40 px on desktops, 28 px on phones", async () => {
    const sizes = `[...document.querySelectorAll("#about .st, #services .st")].map((el) => parseFloat(getComputedStyle(el).fontSize))`;
    await open(refined(plumber, { font: "clean" }), 1280);
    expect(await page.evaluate(sizes)).toEqual([44, 40]);
    await open(refined(plumber, { font: "clean" }), 390);
    const [section, letter] = (await page.evaluate(sizes)) as number[];
    expect(letter).toBe(28);
    expect(section).toBeGreaterThan(28);
  }, 60_000);

  it("keeps the sticky desktop header above the form's Send button (z-index 20)", async () => {
    await open(refined(plumber), 1280);
    const [header, send] = (await page.evaluate(`[".hd", "form button[type=submit]"].map((s) => Number(getComputedStyle(document.querySelector(s)).zIndex))`)) as number[];
    expect(send).toBe(20);
    expect(header).toBeGreaterThan(send ?? Infinity);
  }, 60_000);
});
