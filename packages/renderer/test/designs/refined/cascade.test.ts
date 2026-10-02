// Classic's sheet in a real browser, where the cascade decides which rule wins (the pairs test checks tokens, not
// rule order or specificity): hover colours, the rows phones leave out, link underlines, the phone call bar, the
// About title, the header's stacking and its name's line, the gallery's rows on phones and small tablets, the current
// page's mark in the menu, the hours on the Contact page and the eyebrow's line break. Laid out by the repo's own Playwright Chromium and WebKit with the real
// Classic sheet, each check on the page that draws what it checks. No check waits on the clock: transitions are off
// where a state is read.
import { chromium, webkit, type Browser, type Page } from "@playwright/test";
import { FONT_IDS, PALETTE_IDS, type PageId, type SiteDocumentInput } from "@asksite/site-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadFixture } from "../../../../../fixtures/index.ts";
import { classicPage } from "./site.ts";

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

/**
 * The call bar's height and what is wrong in it: the word "Call" not on show (WCAG 2.5.3 keeps it first in the name,
 * and a visitor reads it), the number or the quote label run onto a second line. Below 24rem "Call" may take a line of
 * its own above the number.
 */
const CALL_BAR = `(() => {
  const bar = document.querySelector("aside");
  const lines = (el) => { const r = document.createRange(); r.selectNodeContents(el); return new Set([...r.getClientRects()].filter((x) => x.width > 2 && x.height > 2).map((x) => Math.round(x.top / 4))).size; };
  const [call, quote] = bar.querySelectorAll("a");
  const word = call.querySelector(".cw");
  const number = [...call.querySelector(".bt-t > span").childNodes].find((n) => n.nodeType === 3 && n.textContent.trim() !== "");
  const box = word.getBoundingClientRect();
  return { height: Math.round(bar.getBoundingClientRect().height), wrapped: [!(box.width > 16 && box.height > 8) && "the word Call hidden", lines(number) > 1 && "number", lines(quote) > 1 && "quote"].filter(Boolean) };
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

/**
 * The first eyebrow on the page: whether its shown items (the trade, the town, the year) fit on one row, read with
 * wrapping off for a moment, and on which line (1-based) each sits as laid out.
 */
const EYEBROW = `(() => {
  const dots = document.querySelector("main .eb > .dots");
  const leaves = [...dots.querySelectorAll(".dots-r > span")].filter((el) => !el.querySelector(".dots") && el.getClientRects().length > 0);
  const off = document.createElement("style");
  off.textContent = ".eb .dots-r{flex-wrap:nowrap!important}.eb .dots-r>span{flex:none!important}";
  document.head.append(off);
  const edge = dots.getBoundingClientRect().left + dots.clientWidth - parseFloat(getComputedStyle(dots).paddingRight);
  const fits = leaves[leaves.length - 1].getBoundingClientRect().right <= edge + 0.5;
  off.remove();
  const tops = leaves.map((el) => el.getBoundingClientRect().top);
  const firsts = tops.filter((top, i) => tops.findIndex((other) => Math.abs(other - top) < 4) === i).sort((a, b) => a - b);
  return { fits, items: leaves.map((el, i) => [el.textContent.trim(), firsts.findIndex((top) => Math.abs(top - tops[i]) < 4) + 1]) };
})()`;

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

  async function open(doc: SiteDocumentInput, width: number, css = "", id: PageId = "home"): Promise<void> {
    await page.setViewportSize({ width, height: 900 });
    await page.setContent(classicPage(doc, id), { waitUntil: "load" });
    if (css) await page.addStyleTag({ content: css });
  }

  /** Every outline button's hover state below AA contrast, per palette (a desktop pointer can hover). */
  async function hoverProblems(css = ""): Promise<string[]> {
    const found: string[] = [];
    for (const palette of PALETTE_IDS) {
      await open(refined(plumber, { palette }), 1280, NO_TRANSITIONS + css);
      for (const selector of [".hd-q", ".ha .bt-out", "#get-in-touch .bt-out"]) {
        await page.hover(selector);
        await page.waitForFunction(HOVERED(selector));
        found.push(...((await page.evaluate(`(${LOW_CONTRAST})(${JSON.stringify([[selector], 4.5])})`)) as string[]).map((p) => `${palette} ${p}`));
        await page.mouse.move(0, 0);
      }
    }
    return found;
  }

  it("keeps an outline button's label readable on hover, the closing band's on the dark band included, in every palette", async () => {
    expect(await hoverProblems()).toEqual([]);
  }, 120_000);

  // The hero's outline button has no fill of its own: a hover that loses its fill shows the paper behind it, which
  // must be read as the paper, never as black.
  it("RED: catches a hover fill lost on the fill-less hero button, read against the paper behind it", async () => {
    expect((await hoverProblems(".bt.bt-out:hover{background:none!important}")).join("\n")).toMatch(/ha \.bt-out: 1\.\d\d/);
  }, 120_000);

  /** The rows phones leave out: the business card's email on Home, the hours beside the form in the contact band. */
  async function phoneRows(width: number, css = ""): Promise<string[]> {
    const found: string[] = [];
    for (const [id, selector] of [["home", ".bc-m .bc-e"], ["contact", ".c-list .c-sub"]] as const) {
      await open(refined(hvac), width, css, id);
      found.push(...((await page.evaluate(`(${DISPLAYS})(${JSON.stringify([selector])})`)) as string[]));
    }
    return found;
  }

  it("leaves the card's email and the hours beside the form out on phones, shows them from 60rem, and shows the contact band's license at every width", async () => {
    const phone = await phoneRows(390);
    expect(phone.length).toBeGreaterThanOrEqual(2);
    expect(phone.filter((d) => !d.endsWith("=none"))).toEqual([]);
    expect((await phoneRows(1280)).filter((d) => d.endsWith("=none"))).toEqual([]);
    for (const width of [320, 390, 768, 1280]) {
      await open(refined(hvac), width, "", "contact");
      expect(await page.evaluate(`(${DISPLAYS})(["#contact .c-list li:has(.lic)"])`), `${width} px`).toEqual(["#contact .c-list li:has(.lic)=flex"]);
    }
  }, 60_000);

  it("RED: catches a recap row that shows on phones", async () => {
    expect((await phoneRows(390, ".c-list li{display:flex!important}")).filter((d) => !d.endsWith("=none"))).not.toEqual([]);
  }, 60_000);

  const LINKS = [".bc-m a", ".h247 a", ".c-list a", ".fcall a", ".cl-l a"];

  it("underlines the links in running text: the business card's, the 24/7 box's call link, the contact band's and the closing band's", async () => {
    for (const width of [390, 1280]) {
      for (const id of ["home", "contact", "services"] as const) {
        await open(refined(hvac), width, "", id);
        expect(await page.evaluate(`document.querySelectorAll(".bc-m a, .h247 a, .cl-l a").length`)).toBeGreaterThanOrEqual(1);
        expect(await page.evaluate(`(${NOT_UNDERLINED})(${JSON.stringify(LINKS)})`)).toEqual([]);
      }
    }
  }, 60_000);

  it("RED: catches a link that lost its underline", async () => {
    await open(refined(hvac), 1280, ".h247 a{text-decoration:none!important}", "contact");
    expect(await page.evaluate(`(${NOT_UNDERLINED})(${JSON.stringify(LINKS)})`)).not.toEqual([]);
  }, 60_000);

  /** Every phone width where the call bar hides "Call", wraps the number or the quote label, or changes height, per owner and lettering. */
  async function callBarProblems(css = ""): Promise<string[]> {
    const found: string[] = [];
    for (const font of FONT_IDS) {
      for (const [name, doc] of Object.entries({ plumber, hvac, cleaning })) {
        // Transitions off: a resize would otherwise be read mid-way through the buttons' padding transition.
        await open(refined(doc, { font }), 390, NO_TRANSITIONS + css);
        const heights = new Set<number>();
        for (const width of [320, 340, 360, 375, 384, 390, 412, 430]) {
          await page.setViewportSize({ width, height: 900 });
          const bar = (await page.evaluate(CALL_BAR)) as { height: number; wrapped: string[] };
          heights.add(bar.height);
          if (bar.wrapped.length > 0) found.push(`${font} ${name} ${width}: ${bar.wrapped.join(", ")}`);
        }
        if (heights.size > 1) found.push(`${font} ${name}: heights ${[...heights].join("/")}`);
      }
    }
    return found;
  }

  it("keeps 'Call' on show in the phone call bar, the number and the quote label on one line each, and the bar at one height from 320 to 430 px", async () => {
    expect(await callBarProblems()).toEqual([]);
  }, 120_000);

  it("RED: catches a call bar that hides the word 'Call' on a small phone", async () => {
    expect((await callBarProblems("@media (width < 24rem){.cw{position:absolute!important;width:1px!important;height:1px!important;overflow:hidden!important;clip-path:inset(50%)!important}}")).join("\n")).toMatch(/ 320: the word Call hidden/);
  }, 120_000);

  it("opens About as every inner page opens: its h1 at the Services page's h1 size and left edge, on phones and desktops", async () => {
    const h1 = `(() => { const box = document.querySelector("h1").getBoundingClientRect(); return [parseFloat(getComputedStyle(document.querySelector("h1")).fontSize), Math.round(box.left)]; })()`;
    for (const width of [390, 1280]) {
      await open(refined(plumber), width, "", "services");
      const services = await page.evaluate(h1);
      await open(refined(plumber), width, "", "about");
      expect(await page.evaluate(h1), `${width} px`).toEqual(services);
    }
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
          await sharp.setContent(classicPage(refined(hollis, { font })), { waitUntil: "load" });
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

  /**
   * Where the eyebrow breaks, per lettering, owner, page and phone width: it must stay on one line wherever it fits, and
   * where it does not, the trade takes the first line and the town and the year the second, together.
   */
  async function eyebrowProblems(): Promise<string[]> {
    const found: string[] = [];
    for (const font of FONT_IDS) {
      for (const [name, doc] of Object.entries({ plumber, hvac, cleaning })) {
        for (const id of ["home", "services"] as const) {
          await open(refined(doc, { font }), 390, "", id);
          for (const width of [320, 360, 375, 390, 414, 430, 768]) {
            await page.setViewportSize({ width, height: 900 });
            const { fits, items } = (await page.evaluate(EYEBROW)) as { fits: boolean; items: Array<[string, number]> };
            const lines = items.map(([, line]) => line);
            const wanted = fits ? items.map(() => 1) : items.map((_, i) => (i === 0 ? 1 : 2));
            if (lines.join() !== wanted.join()) found.push(`${font} ${name} ${id} ${width}: ${items.map(([text, line]) => `${text} (line ${line})`).join(", ")}${fits ? ", though it fits on one" : ""}`);
          }
        }
      }
    }
    return found;
  }

  it("keeps the eyebrow on one line wherever it fits, in every lettering, and otherwise breaks it once, the town and the year together", async () => {
    expect(await eyebrowProblems()).toEqual([]);
  }, 120_000);

  const photos = plumber.facts.photos ?? [];

  /** For 1-6 photos at a width, the positions (1-based) of the prints that span the whole row. */
  async function widePrints(width: number): Promise<Record<number, number[]>> {
    const wide: Record<number, number[]> = {};
    for (let count = 1; count <= photos.length; count++) {
      await open(refined({ ...plumber, facts: { ...plumber.facts, photos: photos.slice(0, count) } }), width, "", "gallery");
      wide[count] = (await page.evaluate(WIDE_PRINTS)) as number[];
    }
    return wide;
  }

  it("shows the Gallery page's prints one per row on phones, and two a row from 36rem (small tablets, phones held sideways) with an odd count's first print alone", async () => {
    expect(photos.length).toBe(6);
    const every = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
    expect(await widePrints(390)).toEqual({ 1: every(1), 2: every(2), 3: every(3), 4: every(4), 5: every(5), 6: every(6) });
    const two = { 1: [1], 2: [], 3: [1], 4: [], 5: [1], 6: [] };
    expect(await widePrints(600)).toEqual(two);
    expect(await widePrints(800)).toEqual(two);
  }, 60_000);

  it("keeps the sticky desktop header above the form's Send button (z-index 20)", async () => {
    await open(refined(plumber), 1280, "", "contact");
    const [header, send] = (await page.evaluate(`[".hd", "form button[type=submit]"].map((s) => Number(getComputedStyle(document.querySelector(s)).zIndex))`)) as number[];
    expect(send).toBe(20);
    expect(header).toBeGreaterThan(send ?? Infinity);
  }, 60_000);

  /**
   * How each Main-menu link is drawn on each page of the plumber's site: the links to the current page must be heavier
   * and underlined, every other link plain (WCAG 1.4.1: more than colour). The phone menu is opened to be read.
   */
  async function currentMarks(width: number): Promise<string[]> {
    const found: string[] = [];
    for (const id of ["home", "services", "about", "gallery", "contact"] as const) {
      await open(refined(plumber), width, "", id);
      if (width < 768) await page.evaluate(`document.querySelector(".menu").open = true`);
      const links = (await page.evaluate(`[...document.querySelectorAll('nav[aria-label="Main"] a')].filter((a) => a.getClientRects().length > 0).map((a) => {
        const style = getComputedStyle(a);
        return { current: a.getAttribute("aria-current") === "page", weight: Number(style.fontWeight), underline: style.textDecorationLine.includes("underline") };
      })`)) as Array<{ current: boolean; weight: number; underline: boolean }>;
      if (links.length !== 5) found.push(`${id}: ${links.length} links on show`);
      for (const l of links) {
        if (l.current !== (l.weight >= 600 && l.underline)) found.push(`${id}: a ${l.current ? "current" : "plain"} link at weight ${l.weight}, ${l.underline ? "underlined" : "not underlined"}`);
      }
      if (links.filter((l) => l.current).length !== 1) found.push(`${id}: ${links.filter((l) => l.current).length} current links on show`);
    }
    return found;
  }

  it("marks the current page in the menu by weight and an underline, on phones (menu open) and desktops", async () => {
    expect([...(await currentMarks(390)), ...(await currentMarks(1280))]).toEqual([]);
  }, 60_000);

  it("puts the whole form, Send included, on a desktop's first screen of /contact when the contact band opens the page", async () => {
    const below: string[] = [];
    for (const [name, doc] of Object.entries({ plumber, hvac, cleaning, electrical: loadFixture("electrical-xss") })) {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.setContent(classicPage(refined(doc), "contact"), { waitUntil: "load" });
      const bottom = (await page.evaluate(`document.querySelector("form button[type=submit]").getBoundingClientRect().bottom`)) as number;
      if (bottom > 800) below.push(`${name}: Send ends at ${Math.round(bottom)} px`);
    }
    expect(below).toEqual([]);
  }, 60_000);

  /**
   * The text of the blocks added for the pages (the closing band's panel, the footer's page links with the current one,
   * the one-line area at the foot of the contact band, the light "Need a price?" box, the proof line under the Services
   * page's h1, About's credentials) under AA 4.5:1, per palette and lettering, read where the cascade paints them.
   */
  async function newBlockContrast(): Promise<string[]> {
    const found: string[] = [];
    const { heroPhoto: _photo, ...noPhoto } = plumber.facts;
    const pages: Array<[PageId, SiteDocumentInput, string[], number]> = [
      ["services", plumber, [".cl-k", ".cl-t", ".cl-i", ".cl-l li span", ".cl-l a", ".ft-nav a:not([aria-current])", ".ft-nav [aria-current]", ".svc-mt", ".svc-more p + p", ".sh-pg .proof"], 1280],
      ["services", plumber, [".cl-n a", ".cl-l li span"], 390],
      ["about", plumber, [".letter .tm", ".letter .tsub", ".letter-b"], 1280],
      ["about", { ...plumber, facts: noPhoto }, [".lt-w .tm", ".lt-w .tsub"], 1280],
      ["contact", plumber, [".c-list .c-sub", "#contact .c-list li:has(.lic)"], 1280],
      ["contact", cleaning, [".af .h3r", ".af-l"], 390],
      ["contact", cleaning, [".c-list .c-sub"], 1280],
    ];
    for (const palette of PALETTE_IDS) {
      for (const font of FONT_IDS) {
        for (const [id, doc, selectors, width] of pages) {
          await open(refined(doc, { palette, font }), width, NO_TRANSITIONS, id);
          found.push(...((await page.evaluate(`(${LOW_CONTRAST})(${JSON.stringify([selectors, 4.5])})`)) as string[]).map((p) => `${palette} ${font} ${id} ${p}`));
        }
      }
    }
    return found;
  }

  it("keeps the new blocks' text at AA contrast in every palette and lettering, the footer's current page included", async () => {
    expect(await newBlockContrast()).toEqual([]);
  }, 120_000);

  it("shows the opening hours on the Contact page at every width, for an owner with no photo too (Home's card lists them there)", async () => {
    for (const width of [320, 390, 768, 1024, 1280, 1920]) {
      await open(refined(hvac), width, "", "contact");
      const shown = await page.evaluate(`[...document.querySelectorAll("#service-area .hours > div")].filter((row) => row.getClientRects().length > 0 && getComputedStyle(row).visibility === "visible").length`);
      expect(shown, `${width} px`).toBeGreaterThanOrEqual(2);
    }
  }, 60_000);
});
