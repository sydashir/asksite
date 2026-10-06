import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { builtScripts, SHEETS_BANNER, sheetsChunk } from "./dist-assets.ts";

// Read from the e2e client build the Playwright web server makes first. Files, not browsers: one project is enough.
test.beforeEach(({ browserName }, info) => test.skip(info.project.name !== "chromium-1280", `reads the build output, the same in every project (${browserName})`));

const KIB = 1024;
// Measured on 2026-10-06 at the candidate head (5b3d643), gzip level 9: 137,401 B for every script but the lazy chunk, plus 2 KiB of headroom; growth past this needs the moderator's OK.
const MAIN_BUNDLE_MAX_GZIP = 137_401 + 2 * KIB;
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

test("the main bundle stays within 2 KiB of its size with render in the lazy chunk", () => {
  const chunk = sheetsChunk();
  const main = builtScripts().filter((s) => s.name !== chunk.name);
  const gzip = main.reduce((sum, s) => sum + s.gzipBytes, 0);
  console.log(`main bundle (every script but the lazy chunk): ${gzip} B gzip; lazy chunk: ${chunk.gzipBytes} B gzip`);
  expect(gzip).toBeLessThanOrEqual(MAIN_BUNDLE_MAX_GZIP);
});
