// Classic's sheet in a real browser, where the cascade decides which rule wins (the pairs test checks tokens, not
// rule order or specificity): hover colours, the rows phones leave out, link underlines, the phone call bar, the
// About title, the header's stacking and its name's line, and the phone gallery's rows. Laid out by the repo's own
// Playwright Chromium and WebKit with the real Classic sheet. Each check has a RED proof: a style override that puts
// the flaw back is caught. No check waits on the clock: transitions are off where a state is read.
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
 * each element's computed text colour on the colour painted behind it, as "selector: ratio" for the ones under `min`.
 * A transparent or see-through background shows what is under it, so the element's background is laid over its
 * ancestors' up to the first opaque one (the white canvas if none is). A colour this cannot read, or a background
 * image on the way, is reported rather than guessed.
 */
const LOW_CONTRAST = `([selectors, min]) => {
  const parse = (c) => { const m = /^rgba?\\(([^)]*)\\)$/.exec(c); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[\\s,\\/]+/).map(Number); return [r, g, b, a].some(Number.isNaN) ? null : [r, g, b, a]; };
  const over = ([r, g, b, a], [R, G, B]) => [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a)];
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const behind = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const style = getComputedStyle(e);
      const c = parse(style.backgroundColor);
      if (!c) return "an unreadable background " + style.backgroundColor;
      if (style.backgroundImage !== "none") return "a background image behind";
      if (c[3] > 0) layers.push(c);
      if (c[3] >= 1) break;
    }
    return layers.reverse().reduce((under, layer) => over(layer, under), [255, 255, 255]);
  };
  return selectors.flatMap((selector) => {
    const el = document.querySelector(selector);
    if (!el) return [selector + ": missing"];
    const back = behind(el);
    if (typeof back === "string") return [selector + ": " + back];
    const text = parse(getComputedStyle(el).color);
    if (!text) return [selector + ": an unreadable colour " + getComputedStyle(el).color];
    const r = ratio(over(text, back), back);
    return r < min ? [selector + ": " + r.toFixed(2) + " (" + getComputedStyle(el).color + " on rgb(" + back.map(Math.round).join(", ") + "))"] : [];
  });
}`;

/** Whether the element a selector names is under the pointer: the hover state is read only once it applies. */
const HOVERED = (selector: string) => `document.querySelector(${JSON.stringify(selector)}).matches(":hover")`;
/** Transitions off, so a computed colour is the state's own, never a frame on the way to it. */
const NO_TRANSITIONS = "*,::before,::after{transition:none!important}";

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

/** A short name that opens with a flat-topped, flat-footed capital, so its first letter's ink is the cap height. */
const hollis: SiteDocumentInput = { ...plumber, facts: { ...plumber.facts, businessName: "Hollis Heating" } };

/**
 * The header name's first letter, left half (its stem, clear of the next letter), over the name's own box, whole CSS
 * px; and the centre line of the button the row centres beside it: the menu's on phones, Call's from 48rem.
 */
const BRAND_BOX = `(() => {
  const brand = document.querySelector(".brand");
  const range = document.createRange();
  range.setStart(brand.firstChild, 0);
  range.setEnd(brand.firstChild, 1);
  const letter = range.getBoundingClientRect();
  const box = brand.getBoundingClientRect();
  const button = [...document.querySelectorAll(".menu summary, .hd-c")].map((el) => el.getBoundingClientRect()).find((r) => r.width > 0);
  const y = Math.floor(box.top);
  return { x: Math.floor(letter.left), y, width: Math.max(1, Math.floor(letter.width / 2)), height: Math.ceil(box.bottom) - y, centre: (button.top + button.bottom) / 2 };
})()`;

/**
 * The first and last rows (CSS px from the image top) that hold ink in a PNG of text on a flat background, decoded
 * in the page: a pixel is ink when its luminance is more than halfway from the background's (the top-left pixel) to
 * the darkest or lightest pixel, so an anti-aliased edge counts at half cover.
 */
const INK_ROWS = `async ([base64, scale]) => {
  const image = new Image();
  image.src = "data:image/png;base64," + base64;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
  const lum = (i) => 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  const paper = lum(0);
  let far = 0;
  for (let i = 0; i < data.length; i += 4) far = Math.max(far, Math.abs(lum(i) - paper));
  const rows = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (Math.abs(lum((y * width + x) * 4) - paper) > far / 2) { rows.push(y); break; }
  return rows.length === 0 ? null : [rows[0] / scale, (rows[rows.length - 1] + 1) / scale];
}`;

/** The gallery prints (1-based) that span the whole row: wider than nine tenths of the list. */
const WIDE_PRINTS = `[...document.querySelectorAll(".gal > li")].flatMap((li, i) => li.getBoundingClientRect().width > 0.9 * li.parentElement.getBoundingClientRect().width ? [i + 1] : [])`;

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
  }, 60_000);

  async function open(doc: SiteDocumentInput, width: number, css = ""): Promise<void> {
    await page.setViewportSize({ width, height: 900 });
    await page.setContent(render(doc, { stylesheets: DESIGN_CSS, formAction: FIXTURE_FORM_ACTION }).html, { waitUntil: "load" });
    if (css) await page.addStyleTag({ content: css });
  }

  /** Every outline button's hover state below AA contrast, per palette (a desktop pointer can hover). */
  async function hoverProblems(css = ""): Promise<string[]> {
    const found: string[] = [];
    for (const palette of PALETTE_IDS) {
      await open(refined(plumber, { palette }), 1280, NO_TRANSITIONS + css);
      for (const selector of [".hd-q", ".ha .bt-out", ".cta-row .bt-out"]) {
        await page.hover(selector);
        await page.waitForFunction(HOVERED(selector));
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

  // The hero's outline button has no fill of its own: a hover that loses its fill shows the paper behind it, which
  // must be read as the paper, never as black.
  it("RED: catches a hover fill lost on the fill-less hero button, read against the paper behind it", async () => {
    expect((await hoverProblems(".bt.bt-out:hover{background:none!important}")).join("\n")).toMatch(/ha \.bt-out: 1\.\d\d/);
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

  /**
   * How far the header name's capitals sit from the header row's centre line, per lettering and window, where it is
   * more than 1 px: the ink of its first letter (an H: flat top, flat foot) against the menu button's centre on
   * phones and the Call button's from 48rem, which the row centres. Read from a 2x screenshot, since a font's line
   * box alone does not say where its capitals are drawn (the build judges measured Sturdy's name 3.7-5 px high).
   */
  async function brandOffsets(css = ""): Promise<string[]> {
    const sharp = await browser.newPage({ deviceScaleFactor: 2 });
    try {
      await sharp.route(/^https?:\/\//, (route) => route.abort());
      const found: string[] = [];
      for (const font of FONT_IDS) {
        for (const [width, height] of [[390, 844], [1024, 768], [1280, 800]] as const) {
          await sharp.setViewportSize({ width, height });
          await sharp.setContent(render(refined(hollis, { font }), { stylesheets: DESIGN_CSS, formAction: FIXTURE_FORM_ACTION }).html, { waitUntil: "load" });
          if (css) await sharp.addStyleTag({ content: css });
          const box = (await sharp.evaluate(BRAND_BOX)) as { x: number; y: number; width: number; height: number; centre: number };
          const png = await sharp.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
          const ink = (await sharp.evaluate(`(${INK_ROWS})(${JSON.stringify([png.toString("base64"), 2])})`)) as [number, number] | null;
          if (ink === null || ink[1] - ink[0] < 8) {
            found.push(`${font} ${width}: no capital found`);
            continue;
          }
          const offset = box.y + (ink[0] + ink[1]) / 2 - box.centre;
          if (Math.abs(offset) > 1) found.push(`${font} ${width}: ${offset.toFixed(1)} px`);
        }
      }
      return found;
    } finally {
      await sharp.close();
    }
  }

  it("centres the header name's capitals on the header row in every lettering, on phones and desktops", async () => {
    expect(await brandOffsets()).toEqual([]);
  }, 120_000);

  it("RED: catches a name set by its line box, which puts Sturdy's capitals high", async () => {
    expect((await brandOffsets(".brand{text-box:normal!important}")).join("\n")).toMatch(/^sturdy /m);
  }, 120_000);

  /** For 1-6 photos on a phone, the positions (1-based) of the prints that span the whole row. */
  async function widePrints(css = ""): Promise<Record<number, number[]>> {
    const wide: Record<number, number[]> = {};
    for (let count = 1; count <= plumber.facts.photos.length; count++) {
      await open(refined({ ...plumber, facts: { ...plumber.facts, photos: plumber.facts.photos.slice(0, count) } }), 390, css);
      wide[count] = (await page.evaluate(WIDE_PRINTS)) as number[];
    }
    return wide;
  }

  it("sets the phone gallery in pairs, with the first print alone only when the count is odd (the approved mockup)", async () => {
    expect(plumber.facts.photos.length).toBe(6);
    expect(await widePrints()).toEqual({ 1: [1], 2: [], 3: [1], 4: [], 5: [1], 6: [] });
  }, 60_000);

  // RED proof: round 2's rule (the first print always alone, and an even count's last one too) is caught.
  it("RED: catches a phone gallery that spans prints across the row with an even count", async () => {
    const wide = await widePrints("@media (width < 48rem){.gal>li:first-child,.gal>li:last-child:nth-child(even){grid-column:1/-1!important}}");
    expect([wide[2], wide[4], wide[6]]).toEqual([[1, 2], [1, 4], [1, 6]]);
  }, 60_000);

  it("keeps the sticky desktop header above the form's Send button (z-index 20)", async () => {
    await open(refined(plumber), 1280);
    const [header, send] = (await page.evaluate(`[".hd", "form button[type=submit]"].map((s) => Number(getComputedStyle(document.querySelector(s)).zIndex))`)) as number[];
    expect(send).toBe(20);
    expect(header).toBeGreaterThan(send ?? Infinity);
  }, 60_000);
});
