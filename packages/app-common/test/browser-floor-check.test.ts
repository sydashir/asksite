import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { API } from "typescript/unstable/sync";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { checkFloor, projectFor, type FloorReport } from "../scripts/browser-floor/check.ts";
import { main } from "../scripts/browser-floor/cli.ts";

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

function found(checked: FloorReport, file: string): string[] {
  return checked.findings
    .filter((finding) => finding.file === resolve(FIXTURES, file))
    .map((finding) => `${finding.line} ${finding.suppressed === undefined ? finding.kind : "suppressed"} ${finding.key}`);
}

describe("browser floor check", () => {
  it.each(["baseline.ts", "aliases.ts", "a-receivers.ts", "b-generics.ts", "c-mixins.ts", "d-partial.ts", "e-suppressions.ts", "e-suppressions-jsx.tsx", "statics.ts", "destructuring.ts", "forms.ts", "alias-source.ts", "alias-reexport.ts", "alias-import.ts"])("%s: fails exactly the marked uses", (file) => {
    expect(found(report, file).sort()).toEqual(expected(file).sort());
  });

  it("detects each regular expression feature at a floor below its version", () => {
    // Below every feature the check reads from a regular expression (the d flag is 15 in MDN), so each
    // detection has a line that must fail.
    const below = checkFloor(resolve(FIXTURES, "regex/tsconfig.json"), { safari: "14", safari_ios: "14" });
    expect(found(below, "regex/regex.ts").sort()).toEqual(expected("regex/regex.ts").sort());
  }, 120_000);

  it("selects the project of the tsconfig it is given, whatever order the snapshot lists them in", () => {
    // The TypeScript API lists a snapshot's projects in its own order (by path, not by the order they
    // were opened in), so the check selects its project by the config file's path.
    const configs = [resolve(FIXTURES, "clean/tsconfig.json"), resolve(FIXTURES, "broken/tsconfig.json")];
    for (const opened of [configs, configs.toReversed()]) {
      const api = new API({ cwd: FIXTURES });
      try {
        const snapshot = api.updateSnapshot({ openProjects: opened });
        for (const config of configs) expect(projectFor(snapshot, config).configFileName).toBe(config);
      } finally {
        api.close();
      }
    }
  }, 120_000);

  it("refuses a program that does not type-check", () => {
    expect(() => checkFloor(resolve(FIXTURES, "broken/tsconfig.json"))).toThrow(/does not type-check[\s\S]*broken\.ts:2:22 .*Missing/);
  }, 120_000);

  it("keeps each floor-ok reason with the finding it accepts", () => {
    const reasons = (file: string): string[] =>
      report.findings
        .filter((finding) => finding.file === resolve(FIXTURES, file) && finding.suppressed !== undefined)
        .map((finding) => `${finding.line} ${finding.suppressed}`)
        .sort();
    expect(reasons("e-suppressions.ts")).toEqual([
      "10 only opens same-tab links",
      "11 MDN files it as scrollX's other name",
      "21 code stands between two comments",
      "26 one marker accepts every finding on its line",
      "26 one marker accepts every finding on its line",
      "8 the caller tests typeof URL.canParse first",
      "9 same-line reason",
    ]);
    // The JSX form: the reason ends where its comment does.
    expect(reasons("e-suppressions-jsx.tsx")).toEqual([
      "19 the popover is an optional extra",
      "20 same-line reason",
      "21 only opens same-tab links",
      "22 MDN files it as scrollX's other name",
      "25 a note may stand on either side",
      "26 covers its own line only",
      "34 code stands between two notes",
    ]);
  });
});

describe("check-browser-floor command", () => {
  const CLI = resolve(import.meta.dirname, "../scripts/check-browser-floor.ts");
  // A time limit, far above a normal run: a check stuck in one regular expression cannot be
  // interrupted in its own thread, so it then fails with ETIMEDOUT instead of blocking the run.
  const run = (tsconfig: string) => spawnSync(process.execPath, [CLI, tsconfig], { cwd: FIXTURES, encoding: "utf8", timeout: 100_000 });

  it("exits 0 when nothing is above the floor", () => {
    const result = run("clean/tsconfig.json");
    expect(result.stdout).toContain("Browser floor: safari 16.4, safari_ios 16.4 (MDN browser-compat-data 8.1.3, TypeScript 7.0.2)");
    expect(result.stdout).toContain("files: 1, platform API uses: 2, failing: 0, accepted by floor-ok: 0");
    expect(result.status).toBe(0);
  }, 120_000);

  it("exits 1 and lists every failing use with its MDN key and version_added", () => {
    const result = run("tsconfig.json");
    expect(result.stdout).toContain("baseline.ts:11:29  not supported  URL.canParse  api.URL.canParse_static  (safari: 17, safari_ios: 17)");
    expect(result.stdout).toContain("baseline.ts:24:21  not supported  requestIdleCallback  api.Window.requestIdleCallback  (safari: preview, safari_ios: false)");
    expect(result.stdout).toContain("d-partial.ts:6:30  partial support  Window.open  api.Window.open  (safari_ios: partial since 1)");
    expect(result.stdout).toContain("c-mixins.ts:22:27  no MDN key  Window.pageXOffset");
    expect(result.stdout).toContain("e-suppressions.ts:14:40  floor-ok needs a reason");
    expect(result.stdout).toContain("e-suppressions.ts:8:31  accepted  URL.canParse  api.URL.canParse_static  (safari: 17, safari_ios: 17)  floor-ok: the caller tests typeof URL.canParse first");
    expect(result.status).toBe(1);
  }, 120_000);

  it("finishes on a floor-ok line with 200 block comments", () => {
    // Deciding whether a marker stands alone reads the comments beside it. A comment pattern that could
    // run past `*/` backtracks exponentially over such a line, and only run's limit would stop it.
    const result = run("comments/tsconfig.json");
    expect(result.error?.message).toBeUndefined();
    expect(result.stdout).toContain("accepted  URL.canParse  api.URL.canParse_static  (safari: 17, safari_ios: 17)  floor-ok: two hundred comments stand before this code");
    expect(result.status).toBe(0);
  }, 120_000);

  it("exits 2 with its usage unless given exactly one tsconfig", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(main([])).toBe(2);
      expect(main(["a.json", "b.json"])).toBe(2);
      expect(error.mock.calls).toEqual([["Usage: node check-browser-floor.ts <tsconfig.json>"], ["Usage: node check-browser-floor.ts <tsconfig.json>"]]);
    } finally {
      error.mockRestore();
    }
  });

  it("exits 2 when it cannot judge the program", () => {
    const result = run("broken/tsconfig.json");
    expect(result.stderr).toContain("does not type-check");
    expect(result.status).toBe(2);
  }, 120_000);
});
