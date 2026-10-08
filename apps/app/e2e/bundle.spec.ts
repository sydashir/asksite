import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { builtScripts, entryScript, LANDING_MARK, landingChunk, SHEETS_BANNER, sheetsChunk } from "./dist-assets.ts";

// Read from the e2e client build the Playwright web server makes first. Files, not browsers: one project is enough.
test.beforeEach(({ browserName }, info) => test.skip(info.project.name !== "chromium-1280", `reads the build output, the same in every project (${browserName})`));

const KIB = 1024;
// Measured on 2026-10-06 at the candidate head (5b3d643), gzip level 9: 137,401 B for every script but the lazy chunk, plus 2 KiB of headroom; growth past this needs the moderator's OK.
// Since the landing page (2026-10-08, moderator ruling B) this pin holds the entry script, the one every page load fetches; each lazy chunk has its own pin below.
// Raised (moderator ruling A, 2026-10-08): password accounts, +1,183 B, 2026-10-08. Measured at b1d27ed, gzip level 9: 140,632 B, plus 2 KiB of headroom.
const MAIN_BUNDLE_MAX_GZIP = 140_632 + 2 * KIB;
// Measured on 2026-10-08 at 384592d, gzip level 9: 2,482 B for the landing page's lazy chunk (only signed-out "/" loads it), plus 512 B of headroom (moderator ruling B); growth past this needs the moderator's OK.
const LANDING_CHUNK_MAX_GZIP = 2_482 + 512;
// Measured on 2026-10-06 at the candidate head (5b3d643), gzip level 9: 65,813 B for the one lazy chunk (render, the three designs' code and the three sheets, Bold's inlined font among them), plus 2 KiB of headroom; growth past this needs the moderator's OK.
// It replaces the 40 KiB limit of the sheets alone (P4-20).
const LAZY_CHUNK_MAX_GZIP = 65_813 + 2 * KIB;
// A string only render() writes (the result's stylesheetSha256 field): it tells where render() lives.
const RENDER_MARK = "stylesheetSha256";

test("render and the design stylesheets are one lazy chunk within its pin, and no other script carries a site sheet or render", () => {
  const chunk = sheetsChunk(); // throws unless exactly one script holds the banner
  expect(chunk.gzipBytes).toBeLessThanOrEqual(LAZY_CHUNK_MAX_GZIP);
  expect(chunk.text).toContain(RENDER_MARK);
  const index = readFileSync(fileURLToPath(new URL("../dist-e2e/client/index.html", import.meta.url)), "utf8");
  expect(index).not.toContain(chunk.name); // not loaded with the page: only a dynamic import fetches it
  for (const script of builtScripts().filter((s) => s.name !== chunk.name)) {
    expect(script.text, script.name).not.toContain(SHEETS_BANNER);
    expect(script.text, script.name).not.toContain(RENDER_MARK);
  }
});

test("the entry script stays within its pin, and every other script is a lazy chunk with its own pin", () => {
  const sheets = sheetsChunk();
  const landing = landingChunk();
  const entry = entryScript();
  console.log(`entry script: ${entry.gzipBytes} B gzip; landing chunk: ${landing.gzipBytes} B gzip; sheets chunk: ${sheets.gzipBytes} B gzip`);
  // Nothing escapes the budget: a script that is neither the entry nor a pinned lazy chunk fails here by name.
  const known = new Set([entry.name, sheets.name, landing.name]);
  expect(known.size, "the entry, the sheets chunk and the landing chunk are three different files").toBe(3);
  expect(builtScripts().map((s) => s.name).filter((name) => !known.has(name)), "every script is the entry or a pinned lazy chunk").toEqual([]);
  expect(entry.gzipBytes).toBeLessThanOrEqual(MAIN_BUNDLE_MAX_GZIP);
});

test("the landing page is one lazy chunk within its own pin, and no other script carries it", () => {
  const landing = landingChunk(); // throws unless exactly one script holds the landing page's h1
  expect(landing.gzipBytes).toBeLessThanOrEqual(LANDING_CHUNK_MAX_GZIP);
  const index = readFileSync(fileURLToPath(new URL("../dist-e2e/client/index.html", import.meta.url)), "utf8");
  expect(index).not.toContain(landing.name); // not loaded with the page: only a dynamic import fetches it
  for (const script of builtScripts().filter((s) => s.name !== landing.name)) expect(script.text, script.name).not.toContain(LANDING_MARK);
});
