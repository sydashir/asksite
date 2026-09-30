import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The test Worker's clock seam (withClock and its X-Test-Now header, in test/support/clock.ts, used only by
// test/support/test-worker.ts) was ratified on one condition: it can never reach production. Production is built
// only from src/ (wrangler.jsonc main: ./src/worker/index.ts, which Task 24 writes; config.test.ts pins it), so
// this checks every file under src/, at the source level.
const ADMIN = fileURLToPath(new URL("../../", import.meta.url));
const SRC = join(ADMIN, "src");
const SEAM = ["test/support/test-worker.ts", "test/support/clock.ts"].map((path) => join(ADMIN, path));

// What the bundlers try for an import written without its extension (esbuild's default, used by wrangler, and
// Vite's resolve.extensions default); a folder name also reaches its index file.
const EXTENSIONS = [".tsx", ".ts", ".mts", ".jsx", ".js", ".mjs", ".css", ".json"];

// An import written with a JavaScript extension also opens its TypeScript source when that file is missing:
// ".js" opens .ts or .tsx and ".jsx" opens .tsx (esbuild 0.28.1 and Vite 8.3.0), ".jsx" also .ts (esbuild),
// ".mjs" opens .mts and ".cjs" .cts (both).
const TYPESCRIPT_SOURCES: Record<string, string[]> = { ".js": [".ts", ".tsx"], ".jsx": [".ts", ".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };

const isFile = (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() === true;
const sourceFiles = readdirSync(SRC, { encoding: "utf8", recursive: true }).map((path) => join(SRC, path)).filter(isFile);
const named = (files: Iterable<string>) => [...files].map((file) => relative(ADMIN, file)).sort();

/** The specifiers a file imports or re-exports: static, side-effect, dynamic (a literal) and require. */
function specifiers(text: string): string[] {
  return [...text.matchAll(/\b(?:from|import|require)\s*\(?\s*["'`]([^"'`]+)["'`]/g)].map((match) => match[1]!);
}

function resolveImport(importer: string, specifier: string): string | undefined {
  const base = resolve(dirname(importer), specifier);
  const written = extname(base);
  const sources = (TYPESCRIPT_SOURCES[written.toLowerCase()] ?? []).map((ext) => base.slice(0, -written.length) + ext);
  return [base, ...sources, ...EXTENSIONS.map((ext) => base + ext), ...EXTENSIONS.map((ext) => join(base, `index${ext}`))].find(isFile);
}

/** The file and every file it reaches through relative imports. Package imports are not followed. */
function reachable(file: string): Set<string> {
  const seen = new Set<string>();
  const queue = [file];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    if (seen.has(next)) continue;
    seen.add(next);
    for (const specifier of specifiers(readFileSync(next, "utf8"))) {
      const target = specifier.startsWith(".") ? resolveImport(next, specifier) : undefined;
      if (target !== undefined) queue.push(target);
    }
  }
  return seen;
}

// A path that differs only in letter case still opens the file on macOS, so paths are compared without case.
const reachesSeam = (file: string) => [...reachable(file)].some((path) => SEAM.some((seam) => path.toLowerCase() === seam.toLowerCase()));

describe("the test Worker's clock seam never reaches production", () => {
  it("scans every production source file and follows their imports (an empty scan would prove nothing)", () => {
    expect(named(sourceFiles)).toEqual(expect.arrayContaining(["src/worker/worker.ts", "src/worker/routes/invites.ts"]));
    expect(named(reachable(join(SRC, "worker/worker.ts")))).toEqual(expect.arrayContaining(["src/worker/app.ts", "src/worker/routes/invites.ts", "src/worker/db.ts"]));
  });

  it("no production source file names the X-Test-Now header", () => {
    expect(named(sourceFiles.filter((file) => /x-test-now/i.test(readFileSync(file, "utf8"))))).toEqual([]);
  });

  it("no production source file imports test/support/test-worker.ts or test/support/clock.ts, directly or through the files it imports", () => {
    expect(named(sourceFiles.filter((file) => /test-worker/i.test(readFileSync(file, "utf8")) || reachesSeam(file)))).toEqual([]);
  });
});
