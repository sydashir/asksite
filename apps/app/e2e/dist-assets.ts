import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/** The banner every compiled site stylesheet carries (Tailwind 4.3.3): it tells the sheets chunk from every other file. */
export const SHEETS_BANNER = "tailwindcss v4.3.3";

const ASSETS = fileURLToPath(new URL("../dist-e2e/client/assets/", import.meta.url));
const INDEX_HTML = fileURLToPath(new URL("../dist-e2e/client/index.html", import.meta.url));

/** Text only the landing page (signed-out "/") holds, its h1: it tells the landing chunk from every other file. */
export const LANDING_MARK = "Your business website, built from a few answers.";

export interface BuiltAsset {
  name: string;
  text: string;
  /** gzip at level 9, the size a CDN could at best send. */
  gzipBytes: number;
}

/** Every JavaScript file of the e2e client build (`vite build --mode e2e`, which the Playwright web server runs first). */
export function builtScripts(): BuiltAsset[] {
  return readdirSync(ASSETS)
    .filter((name) => name.endsWith(".js"))
    .map((name) => {
      const text = readFileSync(`${ASSETS}${name}`, "utf8");
      return { name, text, gzipBytes: gzipSync(text, { level: 9 }).length };
    });
}

/** The one lazy chunk that holds the design stylesheets, found by the banner (never by its hashed name). */
export function sheetsChunk(): BuiltAsset {
  const holders = builtScripts().filter((asset) => asset.text.includes(SHEETS_BANNER));
  if (holders.length !== 1) throw new Error(`expected exactly one script with the stylesheet banner, found ${holders.length}`);
  return holders[0]!;
}

/** The one lazy chunk of the landing page, found by its h1 text (never by its hashed name). */
export function landingChunk(): BuiltAsset {
  const holders = builtScripts().filter((asset) => asset.text.includes(LANDING_MARK));
  if (holders.length !== 1) throw new Error(`expected exactly one script with the landing page's h1, found ${holders.length}`);
  return holders[0]!;
}

/** The one script index.html loads (the entry chunk every page load fetches). */
export function entryScript(): BuiltAsset {
  const names = [...readFileSync(INDEX_HTML, "utf8").matchAll(/<script[^>]*\ssrc="\/assets\/([^"]+\.js)"/g)].map((m) => m[1]);
  if (names.length !== 1) throw new Error(`expected exactly one script loaded by index.html, found ${names.length}`);
  const entry = builtScripts().find((asset) => asset.name === names[0]);
  if (entry === undefined) throw new Error(`index.html loads ${names[0]}, which is not in the build`);
  return entry;
}
