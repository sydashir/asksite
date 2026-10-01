// Render fixtures to standalone .html files for eyeballing in a browser, in every page design.
// Usage: pnpm render                    (all fixtures)
//        pnpm render plumber-austin     (one or more by name)
// Output: out/<design>/<name>/<page>.html, one file per page of the site (gitignored). Run `pnpm build:css` first; `pnpm render` does it for you.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DESIGN_IDS } from "@asksite/site-schema";
import { DESIGN_CSS, FIXTURES, renderFixture, type FixtureName } from "../fixtures/index.ts";

const isFixture = (name: string): name is FixtureName => (FIXTURES as readonly string[]).includes(name);

/** Writes one .html file per design, fixture and page into `outDir`/<design>/<fixture>/ and returns the file paths. */
export function renderFixturesToDir(names: readonly string[], outDir: URL): string[] {
  const unknown = names.filter((name) => !isFixture(name));
  if (unknown.length > 0) throw new Error(`Unknown fixture: ${unknown.join(", ")}. Known: ${FIXTURES.join(", ")}`);
  const selected = names.length > 0 ? names.filter(isFixture) : [...FIXTURES];
  return DESIGN_IDS.flatMap((design) =>
    selected.flatMap((name) => {
      const dir = new URL(`${design}/${name}/`, outDir);
      mkdirSync(dir, { recursive: true });
      return renderFixture(name, DESIGN_CSS, design).map(({ page, html }) => {
        const file = new URL(`${page}.html`, dir);
        writeFileSync(file, html);
        return fileURLToPath(file);
      });
    }),
  );
}

if (import.meta.main) {
  const files = renderFixturesToDir(process.argv.slice(2), new URL("../out/", import.meta.url));
  for (const file of files) console.log(`wrote ${file}`);
}
