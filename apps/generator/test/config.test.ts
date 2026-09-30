import { readdirSync, readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { worstCaseJobMicrousd } from "@asksite/generation";

type Config = {
  workers_dev?: boolean;
  preview_urls?: boolean;
  observability?: { enabled?: boolean; logs?: { invocation_logs?: boolean } };
  vars?: Record<string, string>;
  d1_databases?: Array<{ binding: string; database_name?: string; database_id?: string; migrations_dir?: string }>;
  queues?: { consumers?: Array<Record<string, unknown>>; producers?: unknown[] };
  triggers?: { crons?: string[] };
  compatibility_date?: string;
  compatibility_flags?: string[];
};

const APPS = new URL("../../", import.meta.url);
// Every Worker config is plain JSON: Plan 2's `pnpm dev` and `pnpm deploy:check` read them all with
// JSON.parse. worker.workerd.test.ts proves wrangler itself accepts this one.
const parse = (text: string): Config | undefined => {
  try {
    return JSON.parse(text) as Config;
  } catch {
    return undefined;
  }
};
const config = JSON.parse(readFileSync(new URL("generator/wrangler.jsonc", APPS), "utf8")) as Config;
const others = readdirSync(APPS)
  .filter((app) => app !== "generator" && existsSync(new URL(`${app}/wrangler.jsonc`, APPS)))
  .map((app) => ({ app, config: parse(readFileSync(new URL(`${app}/wrangler.jsonc`, APPS), "utf8")) }));
const SECRETS = ["ANTHROPIC_API_KEY", "OPENAI_COMPAT_API_KEY"];
/** Variables every Worker that declares them must agree on: the job decides, the others advise or display. */
const SHARED_VARS = ["GENERATION_ENABLED", "DAILY_MODEL_LIMIT", "MODEL_PROVIDER", "MODEL_ID"];
/** Design §12.4 tells the user "about $10 a day worst case". Raising the shipped limit past this is the user's call. */
const PROMISED_DAILY_WORST_CASE_MICROUSD = 11_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("apps/generator/wrangler.jsonc (production)", () => {
  it("is a production config that can never run the fake model or leak through workers.dev", () => {
    expect(config.vars?.ENVIRONMENT).toBe("production");
    expect(config.vars?.MODEL_PROVIDER).not.toBe("fake");
    expect(["anthropic", "openai-compatible"]).toContain(config.vars?.MODEL_PROVIDER);
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.observability).toEqual({ enabled: true, logs: { invocation_logs: false } });
    expect(config.compatibility_date).toBe("2026-09-21");
    // A13: from compatibility date 2026-08-04 Node.js compatibility is on unless both opt-outs are set, and
    // nodejs_compat_populate_process_env fills process.env with secrets even with them: no flag may start with "nodejs".
    expect(config.compatibility_flags).toEqual(expect.arrayContaining(["no_nodejs_compat", "no_nodejs_compat_v2"]));
    expect((config.compatibility_flags ?? []).filter((flag) => flag.startsWith("nodejs"))).toEqual([]);
  });

  it("keeps secrets and development-only switches out of vars", () => {
    for (const name of [...SECRETS, "FAKE_MODE", "ADMIN_AUTH_MODE", "MAILER"]) expect(Object.keys(config.vars ?? {})).not.toContain(name);
    expect(JSON.stringify(config)).not.toMatch(/sk-ant-|gsk_|hf_|Bearer /);
  });

  it("prices the configured model, and its worst case at the shipped daily limit keeps the design's promise", () => {
    const perJob = worstCaseJobMicrousd(config.vars!.MODEL_PROVIDER!, config.vars!.MODEL_ID!);
    expect(perJob).not.toBeNull();
    expect(Number(config.vars!.DAILY_MODEL_LIMIT) * perJob!).toBeLessThanOrEqual(PROMISED_DAILY_WORST_CASE_MICROUSD);
  });

  it("has the daily limit variable as a whole number", () => {
    expect(config.vars?.DAILY_MODEL_LIMIT).toMatch(/^\d{1,6}$/);
    expect(["true", "false"]).toContain(config.vars?.GENERATION_ENABLED);
  });

  it("consumes the generation queue one message at a time, retries twice, then dead-letters", () => {
    expect(config.queues).toEqual({ consumers: [{ queue: "asksite-generation", max_batch_size: 1, max_retries: 2, dead_letter_queue: "asksite-generation-dlq" }] });
    expect(config.triggers).toEqual({ crons: ["*/5 * * * *"] });
  });

  it("binds only D1 (no AI binding, no R2, no queue producer)", () => {
    const keys = Object.keys(config);
    for (const key of ["ai", "r2_buckets", "kv_namespaces", "services"]) expect(keys).not.toContain(key);
    expect(config.queues?.producers).toBeUndefined();
    expect(config.d1_databases).toEqual([{ binding: "DB", database_name: "asksite", database_id: expect.stringMatching(UUID), migrations_dir: "../../packages/core/migrations" }]);
  });
});

describe("every Worker in apps/ (cross-plan consistency)", () => {
  it("is plain JSON, as Plan 2's pnpm dev and deploy:check read it", () => {
    for (const { app, config: other } of others) expect([app, other !== undefined]).toEqual([app, true]);
  });

  it("uses the same D1 database as the generator", () => {
    for (const { app, config: other } of others) {
      const db = other?.d1_databases?.find((d) => d.binding === "DB");
      if (db === undefined) continue;
      expect([app, db.database_name, db.database_id]).toEqual([app, "asksite", config.d1_databases![0]!.database_id]);
    }
  });

  it("agrees with the generator on the generation switch, the daily limit and the model, which must be priced", () => {
    for (const { app, config: other } of others) {
      const vars = other?.vars ?? {};
      for (const name of SHARED_VARS) if (Object.hasOwn(vars, name)) expect([app, name, vars[name]]).toEqual([app, name, config.vars![name]]);
      if (Object.hasOwn(vars, "MODEL_PROVIDER") || Object.hasOwn(vars, "MODEL_ID"))
        expect([app, worstCaseJobMicrousd(vars.MODEL_PROVIDER ?? "", vars.MODEL_ID ?? "")]).not.toEqual([app, null]);
    }
  });
});

describe("apps/generator/.dev.vars.example", () => {
  const example = readFileSync(new URL("generator/.dev.vars.example", APPS), "utf8");

  it("lists secret names with empty values only", () => {
    for (const secret of SECRETS) expect(example).toMatch(new RegExp(`^${secret}=$`, "m"));
  });

  it("runs the fake model locally", () => {
    expect(example).toMatch(/^MODEL_PROVIDER=fake$/m);
    expect(example).toMatch(/^ENVIRONMENT=development$/m);
  });
});
