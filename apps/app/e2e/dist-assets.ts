import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/** The banner every compiled site stylesheet carries (Tailwind 4.3.3): it tells the sheets chunk from every other file. */
export const SHEETS_BANNER = "tailwindcss v4.3.3";

const ASSETS = fileURLToPath(new URL("../dist-e2e/client/assets/", import.meta.url));

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
