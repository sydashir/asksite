// Modern's layout in real browsers (Playwright's Chromium and WebKit, the repo's own installed engines), with the real
// compiled sheet: what a unit test of the markup cannot see. It pins the adversarial check's WCAG 1.4.12 finding and
// the build judges' layout must-fixes (A12 Modern build, round 2). No network: every photo is one gray pixel.
import { chromium, webkit, type Browser, type BrowserType, type Page } from "@playwright/test";
import { FONT_IDS, type FontId, type SiteDocumentInput } from "@asksite/site-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DESIGN_CSS, FIXTURE_FORM_ACTION, FIXTURES, inDesign, loadFixture, type FixtureName } from "../../../../../fixtures/index.ts";
import { render } from "../../../src/index.ts";

// The functions handed to tab.evaluate run inside the page. The root tsconfig has no DOM library (only e2e/ has
// one), so this file declares the page globals those functions use, for itself only.
declare const document: any;
declare const getComputedStyle: any;
declare const NodeFilter: any;

const GRAY = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEUlEQVR42mM4ffUhHDHg5AAASSceDT8mdlEAAAAASUVORK5CYII=", "base64");
const ENGINES: ReadonlyArray<readonly [string, BrowserType]> = [
  ["chromium", chromium],
  ["webkit", webkit],
];

const page = (name: FixtureName, font?: FontId): string => {
  const input = inDesign(loadFixture(name), "modern");
  const doc: SiteDocumentInput = font === undefined ? input : { ...input, theme: { ...input.theme, font } };
  return render(doc, { stylesheets: DESIGN_CSS, formAction: FIXTURE_FORM_ACTION }).html;
};

/** WCAG 1.4.12's values: line height 1.5, letter spacing 0.12em, word spacing 0.16em, paragraph spacing 2em. */
const TEXT_SPACING = "* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }";

/**
 * Text a person can see that is cut off by a box that clips, lies past the window's right edge, or runs into other
 * text (WCAG 1.4.12 counts each as lost content); and sideways scroll. The sticky header and call bar sit over the
 * page by design, so their text is left out of the overlap check.
 */
function lostText(): string[] {
  const out: string[] = [];
  const width = document.documentElement.clientWidth;
  const sideways = document.documentElement.scrollWidth - width;
  if (sideways > 0) out.push(`sideways ${sideways}px`);
  const placed: Array<{ text: string; rects: Array<{ left: number; right: number; top: number; bottom: number }> }> = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (parent === null || !(node.textContent ?? "").trim() || parent.closest(".sr-only, .hp, select, option, script, style")) continue;
    if (!parent.checkVisibility({ visibilityProperty: true })) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects: Array<{ left: number; right: number; top: number; bottom: number }> = [...range.getClientRects()].filter((r: { width: number }) => r.width > 0.5);
    const text = (node.textContent ?? "").trim().slice(0, 24);
    for (let box = parent; box !== null && box !== document.body; box = box.parentElement) {
      const style = getComputedStyle(box);
      const clipX = style.overflowX !== "visible";
      const clipY = style.overflowY !== "visible";
      if (!clipX && !clipY) continue;
      const b = box.getBoundingClientRect();
      const cut = rects.some((r) => (clipX && (r.left < b.left - 1 || r.right > b.right + 1)) || (clipY && (r.top < b.top - 1 || r.bottom > b.bottom + 1)));
      if (cut) out.push(`cut "${text}"`);
      break;
    }
    if (rects.some((r) => r.right > width + 1)) out.push(`off the page "${text}"`);
    if (parent.closest("header, aside") === null) placed.push({ text, rects });
  }
  const meet = (a: { left: number; right: number; top: number; bottom: number }, b: typeof a) =>
    Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
  for (const [i, one] of placed.entries()) {
    const other = placed.slice(i + 1).find((two) => one.rects.some((a) => two.rects.some((b) => meet(a, b))));
    if (other !== undefined) out.push(`"${one.text}" runs into "${other.text}"`);
  }
  return [...new Set(out)];
}

describe.each(ENGINES)("Modern in %s", (_engine, engine) => {
  let browser: Browser;
  let tab: Page;
  beforeAll(async () => {
    browser = await engine.launch();
    tab = await browser.newPage();
    await tab.route(/^https?:\/\//, (route) => (route.request().resourceType() === "image" ? route.fulfill({ body: GRAY, contentType: "image/png" }) : route.abort()));
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });

  async function open(html: string, width: number, css?: string): Promise<void> {
    await tab.setViewportSize({ width, height: 800 });
    await tab.setContent(html, { waitUntil: "load" });
    if (css !== undefined) await tab.addStyleTag({ content: css });
  }

  // attack1 I-1: the call card's number lost its last digit off the card and the page scrolled sideways, and the hours
  // board cut its time column. Today's page loses nothing on the same documents.
  it("loses no text and never scrolls sideways under WCAG 1.4.12 text spacing, on phones, for every fixture and lettering", async () => {
    const found: string[] = [];
    for (const name of FIXTURES) {
      for (const font of FONT_IDS) {
        await open(page(name, font), 320, TEXT_SPACING);
        for (const width of [320, 360, 390, 768]) {
          await tab.setViewportSize({ width, height: 800 });
          for (const problem of await tab.evaluate(lostText)) found.push(`${name} ${font} ${width}: ${problem}`);
        }
      }
    }
    expect(found).toEqual([]);
  }, 120_000);

  it("keeps each license number in one piece on small phones, in every lettering (judge 3)", async () => {
    const found: string[] = [];
    for (const font of FONT_IDS) {
      await open(page("plumber-austin", font), 320);
      for (const width of [320, 340, 360, 390]) {
        await tab.setViewportSize({ width, height: 800 });
        // The lines the number (the text after "License ") takes, whatever markup holds it.
        const lines = await tab.evaluate(() => {
          const strong = [...document.querySelectorAll("#top .cred strong")].find((el) => el.textContent?.startsWith("License "));
          if (strong === undefined) return -1;
          const range = document.createRange();
          let seen = 0;
          const walker = document.createTreeWalker(strong, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const length = node.textContent?.length ?? 0;
            if (seen + length > "License ".length && seen <= "License ".length) range.setStart(node, "License ".length - seen);
            range.setEnd(node, length);
            seen += length;
          }
          return new Set([...range.getClientRects()].filter((r) => r.width > 0.5).map((r) => Math.round(r.top))).size;
        });
        if (lines !== 1) found.push(`${font} ${width}: ${lines} lines`);
      }
    }
    expect(found).toEqual([]);
  }, 60_000);

  it("puts every price on its own line under its service's name, at every width (judge 1)", async () => {
    const found: string[] = [];
    for (const name of ["plumber-austin", "hvac-phoenix"] as const) {
      await open(page(name), 390);
      for (const width of [390, 768, 1024, 1280]) {
        await tab.setViewportSize({ width, height: 800 });
        const wrong = await tab.evaluate(() =>
          [...document.querySelectorAll("#services .card:not(.ask)")].flatMap((card) => {
            const title = card.querySelector("h3")?.getBoundingClientRect();
            const price = card.querySelector(".price")?.getBoundingClientRect();
            return title !== undefined && price !== undefined && (price.top < title.bottom - 1 || Math.abs(price.left - title.left) > 1) ? [card.querySelector("h3")?.textContent ?? ""] : [];
          }),
        );
        for (const title of wrong) found.push(`${name} ${width}: ${title}`);
      }
    }
    expect(found).toEqual([]);
  }, 60_000);

  it("fills the services grid's last row: the call-to-action card ends level with the grid's right edge (judges 1-3)", async () => {
    const found: string[] = [];
    // Every fixture, and 1 to 9 services in both variants (each place the card can land in rows of 2, 3 and 4).
    const roofing = inDesign(loadFixture("roofing-extreme"), "modern");
    const counts = [1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((count) =>
      (["cards", "compact"] as const).map((variant): [string, string] => [
        `${count} ${variant}`,
        render(
          {
            ...roofing,
            facts: { ...roofing.facts, services: roofing.facts.services.slice(0, count) },
            copy: { ...roofing.copy, serviceDescriptions: roofing.copy.serviceDescriptions.slice(0, count) },
            layout: roofing.layout.map((s) => (s.id === "services" ? { id: "services", variant } : s)),
          } as SiteDocumentInput,
          { stylesheets: DESIGN_CSS, formAction: FIXTURE_FORM_ACTION },
        ).html,
      ]),
    );
    for (const [name, html] of [...FIXTURES.map((fixture): [string, string] => [fixture, page(fixture)]), ...counts]) {
      await open(html, 390);
      for (const width of [390, 700, 1024, 1280, 1920]) {
        await tab.setViewportSize({ width, height: 800 });
        const gap = await tab.evaluate(() => {
          const list = document.querySelector("#services .cards")?.getBoundingClientRect();
          const last = document.querySelector("#services .cards > li:last-child")?.getBoundingClientRect();
          return list === undefined || last === undefined ? -1 : Math.round(list.right - last.right);
        });
        if (Math.abs(gap) > 1) found.push(`${name} ${width}: ${gap}px short`);
      }
    }
    expect(found).toEqual([]);
  }, 60_000);

  it("gives the hero's two buttons one width when they stack (judge 2)", async () => {
    const found: string[] = [];
    for (const name of FIXTURES) {
      await open(page(name), 768);
      for (const width of [768, 1024, 1100, 1280]) {
        await tab.setViewportSize({ width, height: 800 });
        const [a, b] = await tab.evaluate((): Array<{ top: number; width: number }> => [...document.querySelectorAll("#top .hero-actions > a")].map((el) => el.getBoundingClientRect().toJSON()));
        if (a !== undefined && b !== undefined && Math.abs(a.top - b.top) > 1 && Math.abs(a.width - b.width) > 1) found.push(`${name} ${width}: ${Math.round(a.width)} vs ${Math.round(b.width)}`);
      }
    }
    expect(found).toEqual([]);
  }, 60_000);
});
