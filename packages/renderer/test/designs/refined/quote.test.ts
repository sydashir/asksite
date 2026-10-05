// Classic's quote rule (moderator, 2026-10-05): the first screen of every page but Contact (whose first screen is the
// form itself) offers the quote in exactly one label, in every window. The owner's words (copy.ctaText) in the header,
// the hero, the Services box or the closing band, or the call bar's fixed "Get a quote", never both: where the call bar
// carries the quote (phones, and windows under 32rem tall such as a phone held sideways) the page leaves the quote to
// it. Classic has no per-item quote link, so every link to the form counts. Each fixture's whole site, plus an owner
// with one service and questions (the Services box then sits on a phone's first screen), with the real Classic sheet,
// served on the fixtures' origin from memory as in journey.test.ts, in Chromium and WebKit, upright and sideways.
// The pages run no JavaScript; the check is script text, since the renderer's TypeScript program has no DOM types.
import { chromium, webkit, type Browser, type Page } from "@playwright/test";
import { PAGES } from "@asksite/site-schema";
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
let site: RenderedSite | undefined;

/** Phones, tablets, laptops and phones held sideways (the iPhone 13, the Pixel 7, the iPhone Pro Max). */
const WINDOWS = [
  [390, 844],
  [768, 1024],
  [900, 800],
  [1023, 768],
  [1280, 800],
  [844, 390],
  [932, 430],
  [915, 412],
] as const;

/** The distinct labels of the links to the quote form that are drawn (not display:none or hidden) on the first screen. */
const QUOTE_LABELS = `[...new Set([...document.querySelectorAll('a[href="/contact#quote"]')].filter((a) => {
  const box = a.getBoundingClientRect();
  return getComputedStyle(a).visibility === "visible" && box.width > 0 && box.height > 0 &&
    box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth;
}).map((a) => a.textContent.replace(/\\s+/g, " ").trim()))]`;

describe.each([
  ["Chromium", chromium],
  ["WebKit", webkit],
] as const)("Classic's quote on the first screen in %s", (_name, engine) => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await engine.launch();
    const context = await browser.newContext();
    await context.route(/^https?:\/\//, (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const found = url.origin === ORIGIN && request.method() === "GET" ? site?.pages.find((p) => p.path === url.pathname) : undefined;
      if (found !== undefined) return route.fulfill({ body: found.html, contentType: "text/html; charset=utf-8" });
      if (request.resourceType() === "image") return route.fulfill({ body: GRAY_PNG, contentType: "image/png" });
      return route.abort();
    });
    page = await context.newPage();
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
});
