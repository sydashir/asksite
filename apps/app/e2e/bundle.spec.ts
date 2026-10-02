import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { builtScripts, SHEETS_BANNER, sheetsChunk } from "./dist-assets.ts";

// Read from the e2e client build the Playwright web server makes first. Files, not browsers: one project is enough.
test.beforeEach(({ browserName }, info) => test.skip(info.project.name !== "chromium-1280", `reads the build output, the same in every project (${browserName})`));

const KIB = 1024;
// Measured at Task 17: 140,480 B gzip (level 9) for every script but the sheets chunk. 2 KiB of headroom; growth past this needs the moderator's OK.
const MAIN_BUNDLE_MAX_GZIP = 140_480 + 2 * KIB;
const SHEETS_CHUNK_MAX_GZIP = 40 * KIB;

test("the design stylesheets are one lazy chunk of at most 40 KiB gzip, and no other script carries a site sheet", () => {
  const chunk = sheetsChunk(); // throws unless exactly one script holds the banner
  expect(chunk.gzipBytes).toBeLessThanOrEqual(SHEETS_CHUNK_MAX_GZIP);
  const index = readFileSync(fileURLToPath(new URL("../dist-e2e/client/index.html", import.meta.url)), "utf8");
  expect(index).not.toContain(chunk.name); // not loaded with the page: only a dynamic import fetches it
  for (const script of builtScripts().filter((s) => s.name !== chunk.name)) expect(script.text, script.name).not.toContain(SHEETS_BANNER);
});

test("the main bundle stays within 2 KiB of its size when the editor landed", () => {
  const chunk = sheetsChunk();
  const main = builtScripts().filter((s) => s.name !== chunk.name);
  const gzip = main.reduce((sum, s) => sum + s.gzipBytes, 0);
  console.log(`main bundle (every script but the sheets chunk): ${gzip} B gzip; sheets chunk: ${chunk.gzipBytes} B gzip`);
  expect(gzip).toBeLessThanOrEqual(MAIN_BUNDLE_MAX_GZIP);
});
