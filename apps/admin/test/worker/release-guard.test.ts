import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// F5 (deploy safety): `release` runs release-guard.ts first. It reads a wrangler config's Cloudflare Access settings and
// exits 1 unless the admin could actually sign in. These tests run the script itself, as `release` does, on configs they
// write (and on the repo's real production config), and never let a value reach the output.
const GUARD = new URL("../../release-guard.ts", import.meta.url).pathname;
const PRODUCTION_CONFIG = new URL("../../wrangler.jsonc", import.meta.url).pathname;
// In the admin's own (gitignored) test-results folder, so the test writes nowhere else.
const results = new URL("../../test-results/", import.meta.url).pathname;
mkdirSync(results, { recursive: true });
const dir = mkdtempSync(join(results, "release-guard-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const COMPLETE = {
  ADMIN_AUTH_MODE: "access",
  ACCESS_AUD: "fake-audience-tag-0123456789",
  ACCESS_TEAM_DOMAIN: "https://fake-team.cloudflareaccess.com",
  ADMIN_EMAILS: "boss@fake.example, Second@Fake.example",
  DEV_ADMIN_EMAIL: "",
};

function run(configPath: string): { status: number | null; stderr: string; stdout: string } {
  const { status, stderr, stdout } = spawnSync(process.execPath, [GUARD, configPath], { encoding: "utf8" });
  return { status, stderr, stdout };
}

function guard(vars: Record<string, string> | null): { status: number | null; stderr: string; stdout: string } {
  const config = join(dir, "wrangler.jsonc");
  writeFileSync(config, JSON.stringify(vars === null ? {} : { vars }));
  return run(config);
}

describe("release-guard.ts", () => {
  it("lets a complete Access configuration through", () => {
    expect(guard(COMPLETE)).toEqual({ status: 0, stderr: "", stdout: "" });
  });

  it("stops the release on the repo's current production config, whose Access settings are empty on purpose until Task 27", () => {
    const { status, stderr } = run(PRODUCTION_CONFIG);
    expect(status).toBe(1);
    expect(stderr).toMatch(/must be set before a release/);
  });

  it.each([
    ["dev auth mode", { ADMIN_AUTH_MODE: "dev" }, "ADMIN_AUTH_MODE"],
    ["no auth mode", { ADMIN_AUTH_MODE: "" }, "ADMIN_AUTH_MODE"],
    ["an empty audience", { ACCESS_AUD: "" }, "ACCESS_AUD"],
    ["an empty team domain", { ACCESS_TEAM_DOMAIN: "" }, "ACCESS_TEAM_DOMAIN"],
    ["a team domain over http", { ACCESS_TEAM_DOMAIN: "http://fake-team.cloudflareaccess.com" }, "ACCESS_TEAM_DOMAIN"],
    ["a team domain on another host", { ACCESS_TEAM_DOMAIN: "https://fake-team.cloudflareaccess.com.evil.example" }, "ACCESS_TEAM_DOMAIN"],
    ["a team domain with a path", { ACCESS_TEAM_DOMAIN: "https://fake-team.cloudflareaccess.com/" }, "ACCESS_TEAM_DOMAIN"],
    ["no admin emails", { ADMIN_EMAILS: "" }, "ADMIN_EMAILS"],
    ["only separators in the admin emails", { ADMIN_EMAILS: " , ," }, "ADMIN_EMAILS"],
    ["a dev admin email", { DEV_ADMIN_EMAIL: "dev@fake.example" }, "DEV_ADMIN_EMAIL"],
  ])("stops the release on %s, naming the variable and printing no value", (_what, change, field) => {
    const vars = { ...COMPLETE, ...change };
    const { status, stderr, stdout } = guard(vars);
    expect(status).toBe(1);
    expect(stderr).toContain(field);
    for (const value of Object.values(vars).filter((v) => v !== "" && v !== "access")) {
      expect(stderr + stdout).not.toContain(value);
    }
  });

  it.each(["ADMIN_AUTH_MODE", "ACCESS_AUD", "ACCESS_TEAM_DOMAIN", "ADMIN_EMAILS"])("stops the release when %s is missing from the config", (field) => {
    const { [field as keyof typeof COMPLETE]: _gone, ...vars } = COMPLETE;
    const { status, stderr } = guard(vars);
    expect(status).toBe(1);
    expect(stderr).toContain(field);
  });

  it("stops the release when the config has no vars at all", () => {
    expect(guard(null).status).toBe(1);
  });
});
