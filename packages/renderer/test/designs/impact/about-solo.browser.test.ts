// Bold's About with the story alone (about--solo: no photo, no founding year, no credentials), measured in real
// browsers at desktop widths (64rem and up): the story fills the one column. RED proof in the same run: the page with
// the rule as it was before the fix (no grid area named) puts the story in an implicit column, and this check fails.
// Served from memory (Playwright 1.63 BrowserContext.route + Route.fulfill); the page runs no JavaScript.
import { chromium, webkit, type Browser } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DESIGN_CSS } from "../../../../../fixtures/index.ts";
import { render } from "../../../src/render.ts";
import { SOLO_DOC } from "./about-solo-doc.ts";

const FIXED = '.about--solo{grid-template:"body"/minmax(0,1fr)}';
const BEFORE = ".about--solo{grid-template-rows:auto;grid-template-columns:minmax(0,1fr)}";
const ORIGIN = "https://solo.bold.invalid";
const about = render(SOLO_DOC, { stylesheets: DESIGN_CSS, formAction: "https://forms.example.com/submit", siteUrl: `${ORIGIN}/` }).pages.find((p) => p.page === "about")?.html ?? "";

const ENGINES = { Chromium: chromium, WebKit: webkit } as const;
const browsers = new Map<string, Browser>();
beforeAll(async () => {
  for (const [label, engine] of Object.entries(ENGINES)) browsers.set(label, await engine.launch());
}, 60_000);
afterAll(async () => {
  for (const browser of browsers.values()) await browser.close();
}, 60_000);

/** The story's box against the grid's content box: how far its left edge and its width are off, in CSS px. */
async function storyOffset(engine: string, width: number, html: string): Promise<{ left: number; width: number }> {
  const browser = browsers.get(engine);
  if (browser === undefined) throw new Error(`${engine} did not start`);
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  try {
    await context.route(/^https?:\/\//, (route) => (route.request().url() === `${ORIGIN}/about` ? route.fulfill({ body: html, contentType: "text/html; charset=utf-8" }) : route.abort()));
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/about`, { waitUntil: "load" });
    return await page.evaluate<{ left: number; width: number }>(`(() => {
      const grid = document.querySelector(".about--solo");
      const body = grid.querySelector(".about-body");
      const g = grid.getBoundingClientRect(), b = body.getBoundingClientRect(), s = getComputedStyle(grid);
      const left = g.left + parseFloat(s.paddingLeft), inner = g.width - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
      return { left: Math.abs(b.left - left), width: Math.abs(b.width - inner) };
    })()`);
  } finally {
    await context.close();
  }
}

describe.each(Object.keys(ENGINES))("Bold about--solo in %s", (engine) => {
  it("serves the solo layout with the fixed rule", () => {
    expect(about).toContain('class="wrap about about--solo"');
    expect(about).toContain(FIXED);
  });

  it.each([1024, 1280, 1600])("puts the story in the one column at %i px", async (width) => {
    const offset = await storyOffset(engine, width, about);
    expect(offset.left).toBeLessThanOrEqual(1);
    expect(offset.width).toBeLessThanOrEqual(1);
  });

  it("RED proof: the rule as it was before the fix fails the same check at 1280 px", async () => {
    const before = about.replace(FIXED, BEFORE);
    expect(before).not.toBe(about);
    const offset = await storyOffset(engine, 1280, before);
    expect(offset.left > 1 || offset.width > 1).toBe(true);
  });
});
