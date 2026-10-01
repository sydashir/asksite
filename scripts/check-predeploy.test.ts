import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { APPS, type Builder, formatReport, nodeImports, predeployProblems } from "./check-predeploy.ts";

// Strict area: deploy safety. The check runs on a COMPLETE fake config set in a scratch folder (GREEN), then on that
// set with exactly one placeholder planted (RED, one case each). Every RED case also proves that the report never
// carries the planted value. The fake set is the real wrangler.jsonc files with the placeholders filled in, so it
// follows the real files' shape.

const REPO = join(import.meta.dirname, "..");
const SCRATCH = mkdtempSync(join(REPO, "node_modules", ".predeploy-test-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

const NOW = Date.parse("2026-10-01T00:00:00.000Z");
const DB_ID = "11111111-2222-4333-8444-555555555555";
type Config = { routes?: Array<{ pattern: string; zone_name: string }>; vars: Record<string, string>; d1_databases: Array<{ database_id: string }> };

/** The real file with its placeholders filled in. */
function completeConfig(app: string): Config {
  const text = readFileSync(join(REPO, "apps", app, "wrangler.jsonc"), "utf8")
    .replaceAll("asksite.example", "shop.test")
    .replace("00000000-0000-0000-0000-000000000000", DB_ID);
  const config = JSON.parse(text) as Config;
  const set = (name: string, value: string) => {
    if (name in config.vars) config.vars[name] = value;
  };
  set("ADMIN_NOTIFY_EMAILS", "boss@shop.test");
  set("TURNSTILE_SITE_KEY", "0x4AAAAAAAfakeSiteKey0");
  set("ACCESS_TEAM_DOMAIN", "https://shop-team.cloudflareaccess.com");
  set("ACCESS_AUD", "fake-aud-tag-0001");
  set("ADMIN_EMAILS", "boss@shop.test");
  set("SECURITY_TXT_EXPIRES", new Date(NOW + 200 * 86_400_000).toISOString());
  set("MAIL_FROM", config.vars["MAIL_FROM"]?.replace(/^[^<]*</, "Shop Team <") ?? "");
  return config;
}

const GOOD_BUNDLE = 'import { Hono } from "hono";\nexport default { fetch() { return new Response("node:fs is only a word here"); } };\n';
const okBuilder = (): Builder => ({ production: () => true, restoreLocal: () => true });

interface Fixture {
  root: string;
  dist: Record<string, string>;
}
let counter = 0;
/** Writes a config set (with `change` applied) and a fake build output; returns where they are. */
function fixture(change?: (configs: Record<string, Config>) => void, rawOverride?: { app: string; text: string }): Fixture {
  const root = join(SCRATCH, `set-${counter++}`);
  const configs = Object.fromEntries(APPS.map((app) => [app, completeConfig(app)]));
  change?.(configs);
  const dist: Record<string, string> = {};
  for (const app of APPS) {
    mkdirSync(join(root, "apps", app), { recursive: true });
    writeFileSync(join(root, "apps", app, "wrangler.jsonc"), rawOverride?.app === app ? rawOverride.text : JSON.stringify(configs[app], null, 2));
    if (app === "app" || app === "admin") {
      dist[app] = join(root, "dist", app);
      mkdirSync(join(dist[app], "asksite_worker"), { recursive: true });
      mkdirSync(join(dist[app], "client"), { recursive: true });
      writeFileSync(join(dist[app], "asksite_worker", "index.js"), GOOD_BUNDLE);
      writeFileSync(join(dist[app], "wrangler.json"), "{}");
    }
  }
  return { root, dist };
}
const run = (f: Fixture, builder: Builder = okBuilder()) => predeployProblems({ root: f.root, repoRoot: REPO, now: NOW, builder, distDir: (app) => f.dist[app] ?? "" });

describe("check:predeploy", () => {
  it("passes a complete fake config set, and prints nothing from it", () => {
    const f = fixture();
    expect(run(f)).toEqual([]);
    expect(formatReport([])).toBe("check:predeploy: ready");
  });

  // [name, plant, expected line, planted value that must never appear in the report]
  const RED: Array<[string, (c: Record<string, Config>) => void, string, string]> = [
    ["app route on the placeholder domain", (c) => void (c["app"]!.routes![0]!.pattern = "app.asksite.example/*"), "apps/app: routes[0].pattern holds the placeholder domain", "asksite.example"],
    ["admin route on the placeholder domain", (c) => void (c["admin"]!.routes![0]!.pattern = "admin.asksite.example/*"), "apps/admin: routes[0].pattern holds the placeholder domain", "asksite.example"],
    ["sites wildcard route on the placeholder domain", (c) => void (c["sites"]!.routes![0]!.pattern = "*.asksite.example/*"), "apps/sites: routes[0].pattern holds the placeholder domain", "asksite.example"],
    ["app SUPPORT_EMAIL on the placeholder domain", (c) => void (c["app"]!.vars["SUPPORT_EMAIL"] = "help@asksite.example"), "apps/app: vars.SUPPORT_EMAIL holds the placeholder domain", "help@asksite.example"],
    ["admin SUPPORT_EMAIL on the placeholder domain", (c) => void (c["admin"]!.vars["SUPPORT_EMAIL"] = "help@asksite.example"), "apps/admin: vars.SUPPORT_EMAIL holds the placeholder domain", "help@asksite.example"],
    ["app database id is the all-zero placeholder", (c) => void (c["app"]!.d1_databases[0]!.database_id = "00000000-0000-0000-0000-000000000000"), "apps/app: d1_databases[0].database_id is the all-zero placeholder", "00000000-0000"],
    ["admin database id is the all-zero placeholder", (c) => void (c["admin"]!.d1_databases[0]!.database_id = "00000000-0000-0000-0000-000000000000"), "apps/admin: d1_databases[0].database_id is the all-zero placeholder", "00000000-0000"],
    ["sites database id is the all-zero placeholder", (c) => void (c["sites"]!.d1_databases[0]!.database_id = "00000000-0000-0000-0000-000000000000"), "apps/sites: d1_databases[0].database_id is the all-zero placeholder", "00000000-0000"],
    ["generator database id is the all-zero placeholder", (c) => void (c["generator"]!.d1_databases[0]!.database_id = "00000000-0000-0000-0000-000000000000"), "apps/generator: d1_databases[0].database_id is the all-zero placeholder", "00000000-0000"],
    ["databases differ between Workers", (c) => void (c["sites"]!.d1_databases[0]!.database_id = "99999999-8888-4777-8666-555555555550"), "d1_databases[0].database_id is not the same in every Worker", "99999999-8888"],
    ["ACCESS_TEAM_DOMAIN empty", (c) => void (c["admin"]!.vars["ACCESS_TEAM_DOMAIN"] = ""), "apps/admin: vars.ACCESS_TEAM_DOMAIN is empty", "shop-team"],
    ["ACCESS_AUD empty", (c) => void (c["admin"]!.vars["ACCESS_AUD"] = ""), "apps/admin: vars.ACCESS_AUD is empty", "fake-aud-tag"],
    ["ADMIN_EMAILS empty", (c) => void (c["admin"]!.vars["ADMIN_EMAILS"] = ""), "apps/admin: vars.ADMIN_EMAILS is empty", "boss@shop.test"],
    ["ADMIN_NOTIFY_EMAILS empty", (c) => void (c["app"]!.vars["ADMIN_NOTIFY_EMAILS"] = ""), "apps/app: vars.ADMIN_NOTIFY_EMAILS is empty", "boss@shop.test"],
    ["TURNSTILE_SITE_KEY empty", (c) => void (c["app"]!.vars["TURNSTILE_SITE_KEY"] = ""), "apps/app: vars.TURNSTILE_SITE_KEY is empty", "0x4AAAAAAAfake"],
    ["TURNSTILE_SITE_KEY is a Cloudflare dummy key (the app's release guard)", (c) => void (c["app"]!.vars["TURNSTILE_SITE_KEY"] = "1x00000000000000000000AA"), "release guard (app) refused", "1x00000000000000000000AA"],
    ["ACCESS_TEAM_DOMAIN of the wrong shape (the admin's release guard)", (c) => void (c["admin"]!.vars["ACCESS_TEAM_DOMAIN"] = "http://marker-wrong-shape.test"), "release guard (admin) refused", "marker-wrong-shape"],
    ["DEV_ADMIN_EMAIL set (the admin's release guard)", (c) => void (c["admin"]!.vars["DEV_ADMIN_EMAIL"] = "marker-dev@shop.test"), "release guard (admin) refused", "marker-dev"],
    // Decided 2026-10-01: a value with whitespace around it is refused, never trimmed (the guards refuse the same).
    ["ADMIN_NOTIFY_EMAILS padded", (c) => void (c["app"]!.vars["ADMIN_NOTIFY_EMAILS"] = " boss@shop.test"), "apps/app: vars.ADMIN_NOTIFY_EMAILS has whitespace around it", "boss@shop.test"],
    ["SUPPORT_EMAIL padded on the right", (c) => void (c["admin"]!.vars["SUPPORT_EMAIL"] = "help@shop.test\n"), "apps/admin: vars.SUPPORT_EMAIL has whitespace around it", "help@shop.test"],
    ["TURNSTILE_SITE_KEY padded", (c) => void (c["app"]!.vars["TURNSTILE_SITE_KEY"] = " 0x4AAAAAAApaddedSiteKey "), "apps/app: vars.TURNSTILE_SITE_KEY has whitespace around it", "0x4AAAAAAApadded"],
    ["ACCESS_AUD padded", (c) => void (c["admin"]!.vars["ACCESS_AUD"] = " fake-padded-aud-0002"), "apps/admin: vars.ACCESS_AUD has whitespace around it", "fake-padded-aud"],
    ["MAIL_FROM sender names differ", (c) => void (c["sites"]!.vars["MAIL_FROM"] = "Marker Brand <leads@mail.shop.test>"), "vars.MAIL_FROM sender name is not the same in app, admin and sites", "Marker Brand"],
    ["SECURITY_TXT_EXPIRES too close", (c) => void (c["sites"]!.vars["SECURITY_TXT_EXPIRES"] = new Date(NOW + 5 * 86_400_000).toISOString()), "apps/sites: vars.SECURITY_TXT_EXPIRES is not 30 to 366 days ahead", "2026-10-06"],
  ];
  it.each(RED)("RED: %s", (_name, plant, expected, planted) => {
    const problems = run(fixture(plant));
    expect(problems.some((line) => line === expected || line.startsWith(`${expected}:`))).toBe(true);
    expect(problems.some((line) => line.includes(planted))).toBe(false);
    expect(formatReport(problems)).not.toContain(planted);
  });

  it("RED: a config that is not plain JSON gives one fixed line and none of its text", () => {
    const f = fixture(undefined, { app: "app", text: '{ // marker-comment-text\n "vars": {} }' });
    const problems = run(f);
    expect(problems).toContain("apps/app: wrangler.jsonc is not plain JSON");
    expect(formatReport(problems)).not.toContain("marker-comment-text");
  });

  it("RED: a node: import in a Worker bundle", () => {
    const f = fixture();
    writeFileSync(join(f.dist["admin"]!, "asksite_worker", "index.js"), 'import fs from "node:fs";\nexport default {};\n');
    const problems = run(f);
    expect(problems).toContain("apps/admin: the production Worker bundle imports node:fs (built without nodejs_compat)");
  });

  it("RED: a .dev.vars file in the build output", () => {
    const f = fixture();
    writeFileSync(join(f.dist["app"]!, "asksite_worker", ".dev.vars"), "RESEND_API_KEY=marker-secret-value\n");
    const problems = run(f);
    expect(problems).toContain("apps/app: the build output holds a .dev.vars file");
    expect(formatReport(problems)).not.toContain("marker-secret-value");
  });

  it("RED: a production build that fails, and a local build that cannot be restored", () => {
    const f = fixture();
    expect(run(f, { production: () => false, restoreLocal: () => true })).toContain("apps/app: the production build failed (run: pnpm --filter @asksite/app run build:production)");
    expect(run(f, { production: () => true, restoreLocal: () => false })).toContain("apps/admin: could not leave a local-only build behind (run: pnpm --filter @asksite/admin run build)");
  });

  it("finds node: imports by import syntax only", () => {
    expect(nodeImports('import a from "node:fs";\nimport("node:crypto");\nconst b = require("node:path");\nexport * from "node:url";')).toEqual(["node:crypto", "node:fs", "node:path", "node:url"]);
    expect(nodeImports('const word = "node:fs"; // node:path in a comment\n')).toEqual([]);
  });
});
