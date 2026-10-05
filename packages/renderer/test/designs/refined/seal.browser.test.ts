// The hero's "Since" seal in a real browser: on the business-card hero it sits over the card's top corner and rises
// 2.5rem above it, so in short desktop windows (where the hero's top padding shrinks) it must still stay inside the
// hero, clear of the sticky header. Laid out by the repo's own Playwright Chromium and WebKit with the real Classic sheet.
import { chromium, webkit, type Browser, type Page } from "@playwright/test";
import type { SiteDocumentInput } from "@asksite/site-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadFixture } from "../../../../../fixtures/index.ts";
import { classicPage } from "./site.ts";

/** Desktop windows, short ones first: laptops are often only 540-800 px tall. */
const WINDOWS = [
  [1024, 600],
  [1024, 768],
  [1100, 700],
  [1279, 800],
  [1280, 600],
  [1440, 650],
  [1920, 1080],
] as const;
/** The seal's ring (3px paper + 1.5px accent box-shadow) and the space it keeps from the hero's top edge. */
const RING = 4.5;
const CLEAR = 8;

const refined = (doc: SiteDocumentInput): SiteDocumentInput => ({ ...doc, theme: { ...doc.theme, design: "refined" } });
const plumber = loadFixture("plumber-austin");
const { heroPhoto: _photo, ...noPhoto } = plumber.facts;
const PAGES = {
  "hvac-phoenix": refined(loadFixture("hvac-phoenix")),
  "plumber-austin without photos": refined({ ...plumber, facts: { ...noPhoto, photos: [] } }),
};

/** How far the seal's ring is below the hero's top edge, in px (negative: it pokes out under the header). */
const CLEARANCE = `(ring) => {
  const seal = document.querySelector(".hm-card .seal");
  if (!seal || getComputedStyle(seal).display === "none") return null;
  return seal.getBoundingClientRect().top - ring - document.querySelector("#top").getBoundingClientRect().top;
}`;

const ENGINES = { chromium, webkit } as const;

describe.each(Object.keys(ENGINES) as Array<keyof typeof ENGINES>)("the Classic business-card seal in %s", (engine) => {
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

  /** Every window where the seal comes closer than CLEAR px to the hero's top edge, as "WxH: clearance". */
  async function tooHigh(doc: SiteDocumentInput, css = ""): Promise<string[]> {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.setContent(classicPage(doc), { waitUntil: "load" });
    if (css) await page.addStyleTag({ content: css });
    const found: string[] = [];
    for (const [width, height] of WINDOWS) {
      await page.setViewportSize({ width, height });
      const clearance = (await page.evaluate(`(${CLEARANCE})(${RING})`)) as number | null;
      if (clearance === null) found.push(`${width}x${height}: no seal`);
      else if (clearance < CLEAR) found.push(`${width}x${height}: ${clearance.toFixed(1)} px`);
    }
    return found;
  }

  it.each(Object.keys(PAGES) as Array<keyof typeof PAGES>)("stays inside the hero, clear of the header, on %s", async (name) => {
    expect(await tooHigh(PAGES[name])).toEqual([]);
  }, 60_000);

  // RED proof: without the sealed card's own top margin, short windows push the seal under the header.
  it("catches a seal that rises out of the hero", async () => {
    expect(await tooHigh(PAGES["hvac-phoenix"], ".hm-sealed{margin-top:0!important}")).not.toEqual([]);
  }, 60_000);
});
