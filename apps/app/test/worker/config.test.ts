import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// §9.1 "Unsafe production configuration": the committed wrangler.jsonc is the production config.
// It is kept as plain JSON (no comments) so this test can read it without a JSONC parser.
const config = JSON.parse(readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8")) as {
  workers_dev: unknown;
  preview_urls: unknown;
  observability: { enabled: unknown; logs: { invocation_logs: unknown } };
  vars: Record<string, string>;
  secrets: { required: string[] };
  assets: unknown;
  r2_buckets: Array<{ binding: string; bucket_name: string }>;
};

const SECRET_NAMES = ["RESEND_API_KEY", "IP_HASH_KEY", "ANTHROPIC_API_KEY", "OPENAI_COMPAT_API_KEY"];

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
    expect(config.secrets.required).toEqual(["RESEND_API_KEY", "IP_HASH_KEY"]);
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
