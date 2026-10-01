import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// F31 (Turnstile, deploy): `release` runs release-guard.ts first. It reads a wrangler config's TURNSTILE_SITE_KEY and
// exits 1 unless it is a real one. These tests run the script itself, as `release` does, on configs they write.
const GUARD = new URL("../../release-guard.ts", import.meta.url).pathname;
// In the app's own (gitignored) test-results folder, so the test writes nowhere else.
const results = new URL("../../test-results/", import.meta.url).pathname;
mkdirSync(results, { recursive: true });
const dir = mkdtempSync(join(results, "release-guard-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function guard(vars: Record<string, string> | null): { status: number | null; stderr: string } {
  const config = join(dir, "wrangler.jsonc");
  writeFileSync(config, JSON.stringify(vars === null ? {} : { vars }));
  const run = spawnSync(process.execPath, [GUARD, config], { encoding: "utf8" });
  return { status: run.status, stderr: run.stderr };
}

describe("release-guard.ts", () => {
  it("lets a real sitekey through", () => {
    expect(guard({ TURNSTILE_SITE_KEY: "0x4AAAAAAAexampleKeyExample" })).toEqual({ status: 0, stderr: "" });
  });

  it.each([
    ["an empty sitekey", { TURNSTILE_SITE_KEY: "" }],
    ["no sitekey", {}],
    ["no vars at all", null],
    ["a dummy sitekey that always passes", { TURNSTILE_SITE_KEY: "1x00000000000000000000AA" }],
    ["a dummy sitekey that always fails", { TURNSTILE_SITE_KEY: "2x00000000000000000000AB" }],
  ])("stops the release on %s, saying which variable", (_what, vars) => {
    const { status, stderr } = guard(vars);
    expect(status).toBe(1);
    expect(stderr).toMatch(/TURNSTILE_SITE_KEY must be the real Turnstile sitekey/);
  });

  // A config that is not plain JSON (a `//` comment) makes the parser quote the offending line, which holds config
  // values. The guard must print one fixed message instead, never a value, a source line or a stack trace.
  it("stops on a config that is not plain JSON without printing any value from it", () => {
    const config = join(dir, "commented.jsonc");
    writeFileSync(config, '{ "vars": {\n  "TURNSTILE_SITE_KEY": "0x4AAAAAAAfakefakefake", // boss@fake.example\n} }');
    const run = spawnSync(process.execPath, [GUARD, config], { encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(
      "The release guard could not read the wrangler config as JSON; fix the file and run the release again\n",
    );
    expect(run.stdout + run.stderr).not.toMatch(/0x4AAAAAAAfake|boss@fake|SyntaxError|\bat /);
  });
});
