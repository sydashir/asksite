// Classic's real journeys (A16): a visitor on any page reaches every other page from the header (the link row on a
// desktop, the menu on a phone; WCAG 2.4.5), asks for a quote and lands on the form with the Name field in view,
// never under the sticky header, and finds a Call link on the first screen of every page, in the default order and in
// the owner's own (the plumber with every section moved, and roofing-extreme, whose Contact page opens with the
// service area). Each whole site with the real Classic sheet, served on the fixtures' origin from memory (Playwright
// 1.63 BrowserContext.route and Route.fulfill; photos are a gray tile, anything else is aborted), in Chromium at
// 1280x800 and in WebKit's iPhone 13.
// The pages run no JavaScript; the checks are script text, since the renderer's TypeScript program has no DOM types.
import { chromium, devices, webkit, type Browser, type Page } from "@playwright/test";
import { PAGES, type PageId, type SiteDocumentInput } from "@asksite/site-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_SITE_URL, loadFixture } from "../../../../../fixtures/index.ts";
import { classicSite } from "./site.ts";

const ORIGIN = new URL(FIXTURE_SITE_URL).origin;
const GRAY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEUlEQVR42mM4ffUhHDHg5AAASSceDT8mdlEAAAAASUVORK5CYII=", "base64");
const plumber = loadFixture("plumber-austin");
/** The owner's order inside each page: reviews before credentials, the questions before the prices, the service area before the form. */
function reordered(input: SiteDocumentInput): SiteDocumentInput {
  const move = (layout: SiteDocumentInput["layout"], id: string, after: string) => {
    const rest = layout.filter((s) => s.id !== id);
    const at = rest.findIndex((s) => s.id === after) + 1;
    return [...rest.slice(0, at), ...layout.filter((s) => s.id === id), ...rest.slice(at)];
  };
  return { ...input, layout: move(move(move(input.layout, "trust", "testimonials"), "services", "faq"), "contact", "serviceArea") };
}
const SITES = {
  plumber: classicSite(plumber),
  reordered: classicSite(reordered(plumber)),
  roofing: classicSite(loadFixture("roofing-extreme")),
} as const;
let site: (typeof SITES)[keyof typeof SITES] = SITES.plumber;
const IDS: readonly PageId[] = SITES.plumber.pages.map((p) => p.page);

const SETUPS = {
  "Chromium at 1280x800": { engine: chromium, options: { viewport: { width: 1280, height: 800 } }, phone: false },
  "WebKit on an iPhone 13": { engine: webkit, options: { ...devices["iPhone 13"] }, phone: true },
} as const;

/** Where the Name field sits once the page has settled: in the window, and whether anything (the header) covers its centre. */
const NAME_FIELD = `new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => {
  const field = document.querySelector("#contact-name");
  const box = field.getBoundingClientRect();
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  done({ inView: box.top >= 0 && box.bottom <= innerHeight, covered: hit !== field, top: Math.round(box.top) });
})))`;

/** A tel: link wholly on the first screen whose centre is the link itself (not under another element). */
const CALL_ON_FIRST_SCREEN = `[...document.querySelectorAll('a[href^="tel:"]')].some((a) => {
  const box = a.getBoundingClientRect();
  if (box.width === 0 || box.top < 0 || box.bottom > innerHeight) return false;
  return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest("a") === a;
})`;

describe.each(Object.keys(SETUPS) as Array<keyof typeof SETUPS>)("Classic's journeys in %s", (setup) => {
  const { engine, options, phone } = SETUPS[setup];
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await engine.launch();
    const context = await browser.newContext(options);
    await context.route(/^https?:\/\//, (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const found = url.origin === ORIGIN && request.method() === "GET" ? site.pages.find((p) => p.path === url.pathname) : undefined;
      if (found !== undefined) return route.fulfill({ body: found.html, contentType: "text/html; charset=utf-8" });
      if (request.resourceType() === "image") return route.fulfill({ body: GRAY_PNG, contentType: "image/png" });
      return route.abort();
    });
    page = await context.newPage();
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);

  const visit = (id: PageId) => page.goto(ORIGIN + PAGES[id].path, { waitUntil: "load" });

  it("reaches every page from the header of every page", async () => {
    expect(IDS).toEqual(["home", "services", "about", "gallery", "contact"]);
    const missed: string[] = [];
    for (const from of IDS) {
      for (const to of IDS.filter((id) => id !== from)) {
        await visit(from);
        if (phone) await page.locator(".menu summary").click();
        await page.locator(phone ? ".menu" : ".nav-l").getByRole("link", { name: PAGES[to].label, exact: true }).click();
        const arrived = await page.waitForURL(ORIGIN + PAGES[to].path, { timeout: 5_000 }).then(() => true, () => false);
        if (!arrived) missed.push(`${from} -> ${to}: ${page.url()}`);
      }
    }
    expect(missed).toEqual([]);
  }, 120_000);

  it("asks for a quote from every page and lands on the form, the Name field in view and uncovered", async () => {
    const problems: string[] = [];
    for (const from of IDS) {
      await visit(from);
      await page.locator(phone ? 'aside[aria-label="Call us"] a[href="/contact#quote"]' : ".hd-q").click();
      const arrived = await page.waitForURL(`${ORIGIN}/contact#quote`, { timeout: 5_000 }).then(() => true, () => false);
      if (!arrived) {
        problems.push(`${from}: went to ${page.url()}`);
        continue;
      }
      const name = (await page.evaluate(NAME_FIELD)) as { inView: boolean; covered: boolean; top: number };
      if (!name.inView || name.covered) problems.push(`${from}: the Name field at ${name.top} px, ${name.inView ? "covered" : "out of view"}`);
    }
    expect(problems).toEqual([]);
  }, 120_000);

  it("shows a Call link on the first screen of every page, whatever the owner's order", async () => {
    const without: string[] = [];
    for (const [name, each] of Object.entries(SITES)) {
      site = each;
      for (const { page: id } of each.pages) {
        await visit(id);
        if (!(await page.evaluate(CALL_ON_FIRST_SCREEN))) without.push(`${name} ${id}`);
      }
    }
    site = SITES.plumber;
    expect(without).toEqual([]);
  }, 120_000);
});
