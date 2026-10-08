import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RETENTION_CRON, RETRY_CRON } from "../src/cron.ts";
import type { Env } from "../src/env.ts";

// The production configuration must be safe as committed (design §9.1 "Unsafe production
// configuration"). wrangler.jsonc is kept as plain JSON so tests and `pnpm dev` can JSON.parse it.
const dir = resolve(import.meta.dirname, "..");
const config = JSON.parse(readFileSync(resolve(dir, "wrangler.jsonc"), "utf8"));
const vars: Record<string, string> = config.vars;
const SECRETS = ["RESEND_API_KEY", "IP_HASH_KEY"];

// Every key of Env, checked at compile time by Record<keyof Env, true>.
const ENV_KEYS: Record<keyof Env, true> = {
  DB: true, LIVE: true, MEDIA: true, FORM_RL: true, ENVIRONMENT: true, ROOT_DOMAIN: true, MAILER: true,
  MAIL_FROM: true, SECURITY_TXT_EXPIRES: true, LEAD_EMAILS_PER_DAY: true, RESEND_API_KEY: true, IP_HASH_KEY: true,
};

describe("apps/sites/wrangler.jsonc (production)", () => {
  it("is the production configuration", () => {
    expect(config.name).toBe("asksite-sites");
    expect(vars["ENVIRONMENT"]).toBe("production");
    expect(vars["MAILER"]).toBe("resend");
    expect(config.compatibility_date).toBe("2026-09-21");
    // A13: at this date Node.js compatibility is on by default (and fills process.env with the secrets).
    // The exact list also refuses any other flag, such as nodejs_compat_populate_process_env.
    expect(config.compatibility_flags).toEqual(["no_nodejs_compat", "no_nodejs_compat_v2"]);
  });

  it("is reachable only through its routes, and keeps invocation logs off", () => {
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.observability).toEqual({ enabled: true, logs: { invocation_logs: false } });
    const root = vars["ROOT_DOMAIN"];
    expect(config.routes.map((r: { pattern: string }) => r.pattern)).toEqual([`*.${root}/*`, `${root}/*`]);
    for (const r of config.routes) expect(r.zone_name).toBe(root);
  });

  it("has read-only access to LIVE and MEDIA and no binding to unapproved pages", () => {
    expect(config.r2_buckets).toEqual([
      { binding: "LIVE", bucket_name: "asksite-live" },
      { binding: "MEDIA", bucket_name: "asksite-media" },
    ]);
    expect(JSON.stringify(config)).not.toContain("asksite-work");
    expect(config.d1_databases).toEqual([
      { binding: "DB", database_name: "asksite", database_id: expect.any(String), migrations_dir: "../../packages/core/migrations" },
    ]);
    expect(config.ratelimits).toEqual([{ name: "FORM_RL", namespace_id: "1004", simple: { limit: 5, period: 60 } }]);
    // C1: lead retention once a day, and the lead-email retry every 15 minutes. scheduled() tells them apart by
    // these exact strings (controller.cron), so the config and the code must name the same two.
    expect(config.triggers).toEqual({ crons: [RETENTION_CRON, RETRY_CRON] });
    expect([RETENTION_CRON, RETRY_CRON]).toEqual(["0 7 * * *", "*/15 * * * *"]);
  });

  it("keeps secrets out of vars", () => {
    for (const name of Object.keys(vars)) expect(name).not.toMatch(/KEY|SECRET|TOKEN|PASSWORD/i);
    for (const secret of SECRETS) expect(vars).not.toHaveProperty(secret);
  });

  it("names exactly the bindings, variables and secrets the Env type declares", () => {
    const fromConfig = [
      ...config.d1_databases.map((d: { binding: string }) => d.binding),
      ...config.r2_buckets.map((b: { binding: string }) => b.binding),
      ...config.ratelimits.map((r: { name: string }) => r.name),
      ...Object.keys(vars),
      ...SECRETS,
    ].sort();
    expect(fromConfig).toEqual(Object.keys(ENV_KEYS).sort());
  });

  it("sends at most 40 lead emails a UTC day across all sites (A11c)", () => {
    // Resend Free's 100 a day: sign-in links 40, leads 40, the rest for review alerts and admin emails.
    expect(vars["LEAD_EMAILS_PER_DAY"]).toBe("40");
  });

  it("has a valid security.txt expiry date", () => {
    expect(Number.isNaN(Date.parse(vars["SECURITY_TXT_EXPIRES"] ?? ""))).toBe(false);
  });
});

describe("apps/sites/.dev.vars.example", () => {
  const lines = readFileSync(resolve(dir, ".dev.vars.example"), "utf8").split("\n").filter((l) => l !== "" && !l.startsWith("#"));
  const entries = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

  it("switches everything to local development", () => {
    expect(entries).toMatchObject({ ENVIRONMENT: "development", ROOT_DOMAIN: "localhost:8789", MAILER: "log" });
  });

  it("lists every secret by name and holds no real key", () => {
    for (const secret of SECRETS) expect(entries).toHaveProperty(secret);
    expect(entries["RESEND_API_KEY"]).toBe("");
  });
});
