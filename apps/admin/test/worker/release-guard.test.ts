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

function guard(vars: Record<string, unknown> | null): { status: number | null; stderr: string; stdout: string } {
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
    ["a blank audience", { ACCESS_AUD: " " }, "ACCESS_AUD"],
    ["an audience that is an object", { ACCESS_AUD: { aud: "fake-object-audience-0123" } }, "ACCESS_AUD"],
    ["admin emails that are an object", { ADMIN_EMAILS: { list: "boss@fake.example" } }, "ADMIN_EMAILS"],
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
    for (const value of Object.values(vars).filter((v): v is string => typeof v === "string" && v.trim() !== "" && v !== "access")) {
      expect(stderr + stdout).not.toContain(value);
    }
    expect(stderr + stdout).not.toMatch(/fake-object-audience|\[object/);
  });

  it.each(["ADMIN_AUTH_MODE", "ACCESS_AUD", "ACCESS_TEAM_DOMAIN", "ADMIN_EMAILS"])("stops the release when %s is missing from the config", (field) => {
    const { [field as keyof typeof COMPLETE]: _gone, ...vars } = COMPLETE;
    const { status, stderr } = guard(vars);
    expect(status).toBe(1);
    expect(stderr).toContain(field);
  });

  it.each([
    ["a comment after a value", `{ "vars": {\n"ADMIN_EMAILS": "boss@fake.example", // the owner\n"ACCESS_AUD": "fake-audience-tag-0123456789" } }`],
    ["text that is not JSON", "boss@fake.example fake-audience-tag-0123456789"],
  ])("stops the release on a config with %s, with one plain message and none of the file's text", (_what, text) => {
    const config = join(dir, "broken.jsonc");
    writeFileSync(config, text);
    const { status, stderr, stdout } = run(config);
    expect(status).toBe(1);
    expect(stderr).toMatch(/could not read the wrangler config as JSON/);
    expect(stderr).not.toMatch(/boss@fake|fake-audience|SyntaxError|\bat .*\(/);
    expect(stdout).toBe("");
  });

  it("stops the release when the config file does not exist", () => {
    const { status, stderr } = run(join(dir, "missing.jsonc"));
    expect(status).toBe(1);
    expect(stderr).toMatch(/could not read the wrangler config as JSON/);
    expect(stderr).not.toMatch(/SyntaxError|ENOENT|\bat .*\(/);
  });

  it("stops the release when the config has no vars at all", () => {
    expect(guard(null).status).toBe(1);
  });
});
