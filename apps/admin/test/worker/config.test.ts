import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// §9.1 "Unsafe production configuration" for the admin Worker. wrangler.jsonc is plain JSON.
const config = JSON.parse(readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8")) as {
  main: unknown;
  compatibility_date: unknown;
  compatibility_flags?: string[];
  routes: unknown;
  ratelimits: unknown;
  workers_dev: unknown;
  preview_urls: unknown;
  observability: { enabled: unknown; logs: { invocation_logs: unknown } };
  vars: Record<string, string>;
  secrets: { required: string[] };
  assets: unknown;
  r2_buckets: Array<{ binding: string; bucket_name: string }>;
};

/**
 * A13: from compatibility date 2026-08-04 Node.js compatibility is ON by default (and fills process.env
 * with every text binding, secrets included). Cloudflare's way to turn it off is both opt-outs and no
 * positive flag, so leaving the flags out is not "off". The list is pinned exactly, and no flag may start
 * with "nodejs" (nodejs_compat_populate_process_env would fill node:process env again).
 */
function expectNodeCompatOff(flags: string[] | undefined): void {
  expect(flags).toEqual(["no_nodejs_compat", "no_nodejs_compat_v2"]);
  expect(flags?.filter((flag) => flag.startsWith("nodejs"))).toEqual([]);
}

describe("production wrangler.jsonc", () => {
  it("runs as production, behind Access, with the real mailer and a real model provider", () => {
    expect(config.vars["ENVIRONMENT"]).toBe("production");
    expect(config.vars["ADMIN_AUTH_MODE"]).toBe("access");
    expect(config.vars["MAILER"]).toBe("resend");
    expect(config.vars["MODEL_PROVIDER"]).not.toBe("fake");
    expect(JSON.stringify(config)).not.toContain('"dev"');
  });

  it("is built from ./src/worker/index.ts, inside the src/ tree that clock-seam.test.ts checks", () => {
    expect(config.main).toBe("./src/worker/index.ts");
  });

  it("is reachable only on its own route and keeps request logs off", () => {
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.observability.logs.invocation_logs).toBe(false);
  });

  it("is served only on the admin host of its root domain", () => {
    // Pinned against ROOT_DOMAIN: the product's domain replaces asksite.example in both at once (plan Task 27).
    const root = config.vars["ROOT_DOMAIN"];
    expect(root).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
    expect(config.routes).toEqual([{ pattern: `admin.${root}/*`, zone_name: root }]);
  });

  it("limits each admin to 300 requests a minute (ADMIN_RL, design §4.1)", () => {
    expect(config.ratelimits).toEqual([{ name: "ADMIN_RL", namespace_id: "1005", simple: { limit: 300, period: 60 } }]);
  });

  it("runs on the pinned runtime: compatibility date 2026-09-21 with Node.js compatibility turned off (A13)", () => {
    expect(config.compatibility_date).toBe("2026-09-21");
    expectNodeCompatOff(config.compatibility_flags);
  });

  it("ships generation off and 8 model calls a day, the values the app and the generator ship (M1, decision 17)", () => {
    expect(config.vars["GENERATION_ENABLED"]).toBe("false");
    expect(config.vars["DAILY_MODEL_LIMIT"]).toBe("8");
  });

  it("keeps secrets out of vars, and names a plain support address", () => {
    for (const name of ["RESEND_API_KEY", "IP_HASH_KEY", "ANTHROPIC_API_KEY", "OPENAI_COMPAT_API_KEY"]) expect(Object.keys(config.vars)).not.toContain(name);
    expect(config.secrets.required).toEqual(["RESEND_API_KEY"]);
    expect(config.vars["SUPPORT_EMAIL"]).toMatch(/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i);
  });

  it("binds the work, live and media buckets (§0.2)", () => {
    expect(config.r2_buckets.map((b) => [b.binding, b.bucket_name])).toEqual([
      ["WORK", "asksite-work"],
      ["LIVE", "asksite-live"],
      ["MEDIA", "asksite-media"],
    ]);
  });

  it("is the only Worker that publishes: besides it, only the sites Worker, which only reads (Plan 2's own test), binds the live bucket (§0.2)", () => {
    const apps = new URL("../../../", import.meta.url);
    const binders = readdirSync(apps)
      .filter((app) => existsSync(new URL(`${app}/wrangler.jsonc`, apps)))
      .filter((app) => {
        const other = JSON.parse(readFileSync(new URL(`${app}/wrangler.jsonc`, apps), "utf8")) as { r2_buckets?: Array<{ bucket_name: string }> };
        return (other.r2_buckets ?? []).some((bucket) => bucket.bucket_name === "asksite-live");
      });
    expect(binders.filter((app) => app !== "sites")).toEqual(["admin"]);
  });

  it("serves the single-page app for every path except /api/*, which goes to the Worker first", () => {
    expect(config.assets).toEqual({ directory: "./dist/client", not_found_handling: "single-page-application", run_worker_first: ["/api/*"] });
  });
});

describe("test wrangler.test.jsonc", () => {
  const testConfig = JSON.parse(readFileSync(new URL("../wrangler.test.jsonc", import.meta.url), "utf8")) as { compatibility_flags?: string[] };

  it("turns Node.js compatibility off like production (A13)", () => {
    expectNodeCompatOff(testConfig.compatibility_flags);
  });
});
