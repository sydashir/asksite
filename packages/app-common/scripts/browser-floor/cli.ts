import { createRequire } from "node:module";
import { relative } from "node:path";
import { bcd } from "./bcd.ts";
import { checkFloor, type Finding, type FindingKind } from "./check.ts";

const LABEL: Record<FindingKind, string> = {
  unsupported: "not supported",
  partial: "partial support",
  unmapped: "no MDN key",
  "bad-suppression": "floor-ok needs a reason",
};

function line(f: Finding): string {
  const where = `${relative(process.cwd(), f.file)}:${f.line}:${f.column}`;
  const what = f.kind === "bad-suppression" ? [] : f.key === f.api ? [f.api] : [f.api, f.key];
  const gaps = f.gaps.map((g) => `${g.browser}: ${g.partial ? "partial since " : ""}${g.added}`).join(", ");
  const parts = [where, f.suppressed === undefined ? LABEL[f.kind] : "accepted", ...what];
  if (gaps) parts.push(`(${gaps})`);
  if (f.suppressed !== undefined) parts.push(`floor-ok: ${f.suppressed}`);
  return parts.join("  ");
}

/** Runs the floor check on one tsconfig and prints the result. Returns the exit code. */
export function main(args: readonly string[]): number {
  const tsconfig = args[0];
  if (tsconfig === undefined || args.length !== 1) {
    console.error("Usage: node check-browser-floor.ts <tsconfig.json>");
    return 2;
  }
  try {
    const report = checkFloor(tsconfig);
    const failing = report.findings.filter((f) => f.suppressed === undefined);
    const floor = Object.entries(report.floor).map(([browser, version]) => `${browser} ${version}`).join(", ");
    const typescript = (createRequire(import.meta.url)("typescript/package.json") as { version: string }).version;
    console.log(`Browser floor: ${floor} (MDN browser-compat-data ${bcd.__meta.version}, TypeScript ${typescript})`);
    console.log(
      `files: ${report.files}, platform API uses: ${report.sites}, failing: ${failing.length}, accepted by floor-ok: ${report.findings.length - failing.length}`,
    );
    const sorted = report.findings.toSorted((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
    for (const f of sorted) console.log(line(f));
    return failing.length > 0 ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
