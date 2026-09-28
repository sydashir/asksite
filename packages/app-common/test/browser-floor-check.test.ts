import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { checkFloor, type FloorReport } from "../scripts/browser-floor/check.ts";

// The floor check (P4-7) run over floor-fixtures/, at the floor of src/browser-floor.ts (16.4; its
// own test pins that value). A fixture line that must fail carries `expect: <kind> <key>`, several
// joined by "; ", and every other line must pass, so a miss and a false alarm both fail here.
const FIXTURES = resolve(import.meta.dirname, "../floor-fixtures");

function expected(file: string): string[] {
  return readFileSync(resolve(FIXTURES, file), "utf8")
    .split("\n")
    .flatMap((text, index) => {
      const marker = /expect: ([^*]+)/.exec(text)?.[1]?.trim();
      return marker ? marker.split("; ").map((one) => `${index + 1} ${one}`) : [];
    });
}

let report: FloorReport;
beforeAll(() => {
  report = checkFloor(resolve(FIXTURES, "tsconfig.json"));
}, 120_000);

function found(file: string): string[] {
  return report.findings
    .filter((finding) => finding.file === resolve(FIXTURES, file))
    .map((finding) => `${finding.line} ${finding.suppressed === undefined ? finding.kind : "suppressed"} ${finding.key}`);
}

describe("browser floor check", () => {
  it.each(["baseline.ts", "aliases.ts", "a-receivers.ts", "b-generics.ts", "c-mixins.ts", "d-partial.ts", "e-suppressions.ts"])("%s: fails exactly the marked uses", (file) => {
    expect(found(file).sort()).toEqual(expected(file).sort());
  });

  it("keeps each floor-ok reason with the finding it accepts", () => {
    const reasons = report.findings
      .filter((finding) => finding.file === resolve(FIXTURES, "e-suppressions.ts") && finding.suppressed !== undefined)
      .map((finding) => `${finding.line} ${finding.suppressed}`);
    expect(reasons.sort()).toEqual([
      "10 only opens same-tab links",
      "11 MDN files it as scrollX's other name",
      "8 the caller tests typeof URL.canParse first",
      "9 same-line reason",
    ]);
  });
});
