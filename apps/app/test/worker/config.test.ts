import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TURNSTILE_TEST_SECRET, TURNSTILE_TEST_SITE_KEY } from "../support/turnstile.ts";

// §9.1 "Unsafe production configuration": the committed wrangler.jsonc is the production config.
// It is kept as plain JSON (no comments) so this test can read it without a JSONC parser.
const config = JSON.parse(readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8")) as {
  compatibility_date: unknown;
  compatibility_flags?: string[];
  routes: unknown;
  triggers: unknown;
  ratelimits: unknown;
  workers_dev: unknown;
  preview_urls: unknown;
  observability: { enabled: unknown; logs: { invocation_logs: unknown } };
  vars: Record<string, string>;
  secrets: { required: string[] };
  assets: unknown;
  r2_buckets: Array<{ binding: string; bucket_name: string }>;
};

const SECRET_NAMES = ["RESEND_API_KEY", "IP_HASH_KEY", "TURNSTILE_SECRET_KEY", "ANTHROPIC_API_KEY", "OPENAI_COMPAT_API_KEY"];

/** Cloudflare's Turnstile test sitekeys: 1x/2x/3x, twenty zeros, then AA, AB, BB or FF. */
const TEST_SITE_KEY = /^[123]x0{20}[A-F]{2}$/;

/**
 * A13: from compatibility date 2026-08-04 Node.js compatibility is ON by default (and fills process.env
 * with every text binding, secrets included). Cloudflare's way to turn it off: no positive flag, and both
 * opt-outs. Leaving the flags out is therefore not "off".
 */
function expectNodeCompatOff(flags: string[] | undefined): void {
  expect(flags).toEqual(expect.arrayContaining(["no_nodejs_compat", "no_nodejs_compat_v2"]));
  expect(flags?.filter((flag) => flag.startsWith("nodejs"))).toEqual([]);
}

describe("production wrangler.jsonc", () => {
  it("runs as production with the real mailer", () => {
    expect(config.vars["ENVIRONMENT"]).toBe("production");
    expect(config.vars["MAILER"]).toBe("resend");
    expect(config.vars["MODEL_PROVIDER"]).not.toBe("fake");
    expect(config.vars["ADMIN_AUTH_MODE"]).not.toBe("dev");
  });

  it("is reachable only on its own route: no workers.dev and no preview URLs", () => {
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
  });

  it("keeps request logs off (they could hold cookies and IPs) but observability on", () => {
    expect(config.observability.enabled).toBe(true);
    expect(config.observability.logs.invocation_logs).toBe(false);
  });

  it("never puts a secret in vars, and declares the ones it needs", () => {
    for (const name of SECRET_NAMES) expect(Object.keys(config.vars)).not.toContain(name);
    expect(config.secrets.required).toEqual(["RESEND_API_KEY", "IP_HASH_KEY", "TURNSTILE_SECRET_KEY"]);
  });

  it("runs on the pinned runtime: compatibility date 2026-09-21 with Node.js compatibility turned off (A13)", () => {
    expect(config.compatibility_date).toBe("2026-09-21");
    expectNodeCompatOff(config.compatibility_flags);
  });

  it("is served on its route, with the daily cleanup at 06:00 UTC", () => {
    expect(config.routes).toEqual([{ pattern: "app.asksite.example/*", zone_name: "asksite.example" }]);
    expect(config.triggers).toEqual({ crons: ["0 6 * * *"] });
  });

  it("pins the rate limits: AUTH_RL 10, API_RL 120 and UPLOAD_RL 20 a minute", () => {
    expect(config.ratelimits).toEqual([
      { name: "AUTH_RL", namespace_id: "1001", simple: { limit: 10, period: 60 } },
      { name: "API_RL", namespace_id: "1002", simple: { limit: 120, period: 60 } },
      { name: "UPLOAD_RL", namespace_id: "1003", simple: { limit: 20, period: 60 } },
    ]);
  });

  it("sends at most 40 sign-in emails a day, and never uses a Turnstile test sitekey (A11)", () => {
    expect(config.vars["LOGIN_EMAILS_PER_DAY"]).toBe("40");
    expect(typeof config.vars["TURNSTILE_SITE_KEY"]).toBe("string");
    expect(config.vars["TURNSTILE_SITE_KEY"]).not.toMatch(TEST_SITE_KEY);
  });

  it("uses https origins and a plain support address", () => {
    expect(config.vars["APP_ORIGIN"]).toMatch(/^https:\/\/app\./);
    expect(config.vars["SUPPORT_EMAIL"]).toMatch(/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i);
  });

  it("binds the work and media buckets only, never the live one: only the admin publishes (§0.2)", () => {
    expect(config.r2_buckets.map((b) => [b.binding, b.bucket_name])).toEqual([
      ["WORK", "asksite-work"],
      ["MEDIA", "asksite-media"],
    ]);
  });

  it("serves the single-page app for every path except /api/*, which goes to the Worker first", () => {
    expect(config.assets).toEqual({ directory: "./dist/client", not_found_handling: "single-page-application", run_worker_first: ["/api/*"] });
  });
});

describe("test wrangler.test.jsonc", () => {
  const testConfig = JSON.parse(readFileSync(new URL("../wrangler.test.jsonc", import.meta.url), "utf8")) as {
    name: string;
    compatibility_flags?: string[];
    vars: Record<string, string>;
  };

  it("turns Node.js compatibility off like production, so the tests run the runtime production runs (A13)", () => {
    expectNodeCompatOff(testConfig.compatibility_flags);
  });

  it("uses Cloudflare's documented always-pass Turnstile test keys and the production daily cap", () => {
    expect(testConfig.name).toBe("asksite-app-test");
    expect(testConfig.vars["TURNSTILE_SITE_KEY"]).toBe(TURNSTILE_TEST_SITE_KEY);
    expect(testConfig.vars["TURNSTILE_SECRET_KEY"]).toBe(TURNSTILE_TEST_SECRET);
    expect(testConfig.vars["TURNSTILE_SITE_KEY"]).toMatch(TEST_SITE_KEY);
    expect(testConfig.vars["LOGIN_EMAILS_PER_DAY"]).toBe(config.vars["LOGIN_EMAILS_PER_DAY"]);
  });
});
