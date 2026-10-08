import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { GenerationRow } from "@asksite/core";
import type { D1Database, Queue } from "@cloudflare/workers-types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";
import { buildPrompt } from "../../../packages/generation/src/prompt.ts";
import { FULL_SNAPSHOT } from "../../../packages/generation/test/support/samples.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
// Local D1 is shared by database id, so the producer uses the generator's own id (placeholder or real).
const GENERATOR = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")) as {
  d1_databases: Array<{ database_id: string }>;
  compatibility_date: string;
  compatibility_flags: string[];
};
const DATABASE = { binding: "DB", database_name: "asksite", database_id: GENERATOR.d1_databases[0]!.database_id, migrations_dir: "./packages/core/migrations" };
const PRODUCER = {
  name: "test-producer",
  main: "./packages/generation/test/support/noop-worker.ts",
  compatibility_date: "2026-09-21",
  compatibility_flags: ["no_nodejs_compat", "no_nodejs_compat_v2"], // A13
  d1_databases: [DATABASE],
  queues: { producers: [{ binding: "GEN_QUEUE", queue: "asksite-generation" }] },
};
// The generator's own module plus one route that answers `typeof process`, under the compatibility date and flags
// of the generator's wrangler.jsonc, read from that file (A13). The harness runs a config file's own `main`, so the
// route lives in this test-only entry point, which imports the real src/index.ts and with it the whole module graph.
const PROBE = {
  name: "generator-probe",
  main: "./apps/generator/test/support/generator-probe-worker.ts",
  compatibility_date: GENERATOR.compatibility_date,
  compatibility_flags: GENERATOR.compatibility_flags,
};

/** Stand-in keys: the fake model never sends them, and no log line may ever hold one (task-12-additions B). */
const KEYS = { ANTHROPIC_API_KEY: "test-anthropic-key-never-logged", OPENAI_COMPAT_API_KEY: "test-compat-key-never-logged" };

// The real apps/generator/wrangler.jsonc, with local test variables, plus a small producer Worker
// that shares its D1 database and sends to its queue, as asksite-app does in production.
const server = createTestHarness({
  root: ROOT,
  workers: [
    {
      configPath: "./apps/generator/wrangler.jsonc",
      vars: { ENVIRONMENT: "development", GENERATION_ENABLED: "true", DAILY_MODEL_LIMIT: "30", MODEL_PROVIDER: "fake", MODEL_ID: "fake-template", FAKE_MODE: "ok" },
      secrets: KEYS,
    },
    { config: PRODUCER },
    { config: PROBE },
  ],
});

let producer: { DB: D1Database; GEN_QUEUE: Queue<unknown> };
beforeAll(async () => {
  await server.listen();
  await server.getWorker().applyD1Migrations("DB");
  producer = (await server.getWorker("test-producer").getEnv()) as typeof producer;
}, 120_000);
afterAll(async () => server.close());
beforeEach(async () => {
  await producer.DB.batch(["generations", "sites", "owners"].map((t) => producer.DB.prepare(`DELETE FROM ${t}`)));
  await producer.DB.batch([
    producer.DB.prepare("INSERT INTO owners (id, email, created_at) VALUES ('o1', 'o1@example.com', 0)"),
    producer.DB.prepare("INSERT INTO sites (id, owner_id, created_at, updated_at) VALUES ('s1', 'o1', 0, 0)"),
  ]);
  server.clearLogs();
});

async function waitForFinal(id: string): Promise<GenerationRow> {
  for (let i = 0; i < 100; i++) {
    const row = await producer.DB.prepare("SELECT * FROM generations WHERE id = ?1").bind(id).first<GenerationRow>();
    if (row !== null && (row.status === "succeeded" || row.status === "failed")) return row;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`generation ${id} did not finish`);
}

type Line = Record<string, unknown> & { event: string };
/** The runtime log messages that are one JSON object with an event: the Worker's own structured lines, in order. */
const eventLines = (): Line[] =>
  server.getLogs().flatMap(({ message }) => {
    try {
      const line: unknown = JSON.parse(message);
      return typeof line === "object" && line !== null && typeof (line as { event?: unknown }).event === "string" ? [line as Line] : [];
    } catch {
      return [];
    }
  });

async function waitForLine(match: (line: Line) => boolean): Promise<Line> {
  for (let i = 0; i < 100; i++) {
    const line = eventLines().find(match);
    if (line !== undefined) return line;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the log line never came");
}

/** Everything the runtime logged, as written and with each JSON line's strings decoded, for the never-logged check. */
function logText(): string {
  const strings = (value: unknown): string[] =>
    typeof value === "string" ? [value] : typeof value === "object" && value !== null ? Object.values(value).flatMap(strings) : [];
  return server
    .getLogs()
    .flatMap(({ message }) => {
      try {
        return [message, ...strings(JSON.parse(message))];
      } catch {
        return [message];
      }
    })
    .join("\n");
}

const PROMPT = buildPrompt(FULL_SNAPSHOT);
/** Owner text, keys and prompt text that must never reach a log line (design §1.2). */
const NEVER_LOGGED = [
  // FULL_SNAPSHOT's owner facts and brief (samples.ts). Its digit-only ZIP codes are left out: a random id can hold them.
  ...["Reliable Rooter", "Drain cleaning", "Leak repair", "Austin", "Round Rock", "Within 25 miles", "+15125550142", "office@reliable.example.com"],
  ...["100 Congress Ave", "Texas master plumber", "M-40123", "burst pipe", "Dana P.", "show up when we say", "older homes", "Water heaters"],
  KEYS.ANTHROPIC_API_KEY,
  KEYS.OPENAI_COMPAT_API_KEY,
  // Every line of the job's prompt that is 20 characters or longer, the business data line included.
  ...`${PROMPT.system}\n${PROMPT.user}`.split("\n").filter((line) => line.length >= 20),
];

const queueRow = (id: string, createdAt = Date.now()) =>
  producer.DB.prepare("INSERT INTO generations (id, site_id, owner_id, kind, status, input_json, created_at) VALUES (?1, 's1', 'o1', 'first', 'queued', ?2, ?3)").bind(id, JSON.stringify(FULL_SNAPSHOT), createdAt).run();

describe("asksite-generator", () => {
  it("consumes { v: 1, generationId } from the queue and finishes the job with the fake model", async () => {
    const id = crypto.randomUUID();
    await queueRow(id);
    await producer.GEN_QUEUE.send({ v: 1, generationId: id });
    expect(await waitForFinal(id)).toMatchObject({ status: "succeeded", used_fallback: 0, provider: "fake", attempts: 1, model_slot: 1 });
  }, 30_000);

  it("acknowledges a malformed message without touching the database", async () => {
    await producer.GEN_QUEUE.send({ v: 2, generationId: "not-an-id" });
    let logged = false;
    for (let i = 0; i < 100 && !logged; i++) {
      logged = JSON.stringify(server.getLogs()).includes("generation.bad_message");
      if (!logged) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(logged).toBe(true);
    expect(eventLines().filter((line) => line.event === "generation.bad_message")).toEqual([{ event: "generation.bad_message", messageId: expect.any(String) }]);
    expect((await producer.DB.prepare("SELECT COUNT(*) AS n FROM generations").first<{ n: number }>())?.n).toBe(0);
  }, 30_000);

  it("sweeps stuck jobs on its cron", async () => {
    const id = crypto.randomUUID();
    await queueRow(id, Date.now() - 7 * 60_000);
    expect(await server.getWorker().scheduled({ cron: "*/5 * * * *", scheduledTime: new Date() })).toMatchObject({ outcome: "ok" });
    expect(await waitForFinal(id)).toMatchObject({ status: "succeeded", used_fallback: 1, fallback_reason: "provider_error" });
    expect(await waitForLine((line) => line.event === "generation.sweep")).toEqual({ event: "generation.sweep", fallback: 1, failed: 0, errors: 0 });
  }, 30_000);

  it("clears the inputs of generations finished more than 30 days ago on its daily cron, and logs the count only", async () => {
    const old = crypto.randomUUID();
    const recent = crypto.randomUUID();
    await producer.DB.batch([
      producer.DB.prepare("INSERT INTO sites (id, owner_id, created_at, updated_at) VALUES ('s2', 'o1', 0, 0)"),
      producer.DB.prepare("INSERT INTO generations (id, site_id, owner_id, kind, status, input_json, output_json, created_at, finished_at) VALUES (?1, 's1', 'o1', 'first', 'succeeded', ?2, '{\"kept\":1}', 0, ?3)").bind(old, JSON.stringify(FULL_SNAPSHOT), Date.now() - 31 * 86_400_000),
      producer.DB.prepare("INSERT INTO generations (id, site_id, owner_id, kind, status, input_json, output_json, created_at, finished_at) VALUES (?1, 's2', 'o1', 'first', 'succeeded', ?2, '{\"kept\":1}', 0, ?3)").bind(recent, JSON.stringify(FULL_SNAPSHOT), Date.now() - 29 * 86_400_000),
    ]);
    expect(await server.getWorker().scheduled({ cron: "17 3 * * *", scheduledTime: new Date() })).toMatchObject({ outcome: "ok" });
    expect(await waitForLine((line) => line.event === "generation.trim")).toEqual({ event: "generation.trim", cleared: 1, limited: false });
    expect(await producer.DB.prepare("SELECT id, input_json, output_json FROM generations ORDER BY finished_at").all()).toMatchObject({
      results: [{ id: old, input_json: "{}", output_json: '{"kept":1}' }, { id: recent, input_json: JSON.stringify(FULL_SNAPSHOT), output_json: '{"kept":1}' }],
    });
  }, 30_000);

  it("logs IDs and codes only, never owner text", async () => {
    const id = crypto.randomUUID();
    await queueRow(id);
    await producer.GEN_QUEUE.send({ v: 1, generationId: id });
    const row = await waitForFinal(id);
    await waitForLine((line) => line.event === "generation.job" && line.generationId === id);
    // A later job's line arrives after every line of this one: miniflare reads workerd's output in order, line by line
    // (miniflare dist/src/index.js:106047-106071), and the Worker logs one job's lines one after another with no await.
    const next = crypto.randomUUID();
    await queueRow(next);
    await producer.GEN_QUEUE.send({ v: 1, generationId: next });
    await waitForLine((line) => line.event === "generation.job" && line.generationId === next);
    // One line and no usage_missing or generation.internal line; its flags are booleans; its model is the stored one.
    expect(eventLines().filter((line) => line.generationId === id)).toEqual([
      {
        event: "generation.job",
        outcome: "succeeded",
        generationId: id,
        attempts: 1,
        usedFallback: false,
        errorCode: null,
        fallbackReason: null,
        providerErrorKind: null,
        attemptOutcomes: ["valid"],
        usageMissing: false,
        inputBoundRefused: false,
        costUnknown: false,
        durationMs: expect.any(Number),
        provider: "fake",
        model: row.model,
      },
    ]);
    expect(row.model).toBe("fake-template");
    const logs = logText();
    expect(logs).toContain(id);
    for (const secretish of NEVER_LOGGED) expect(logs).not.toContain(secretish);
  }, 30_000);
});

describe("Node.js compatibility (A13)", () => {
  it("is off in the test producer: both opt-outs, and no flag starting with nodejs", () => {
    expect(PRODUCER.compatibility_flags).toEqual(expect.arrayContaining(["no_nodejs_compat", "no_nodejs_compat_v2"]));
    expect(PRODUCER.compatibility_flags.filter((flag) => flag.startsWith("nodejs"))).toEqual([]);
  });

  it("is off where the generator's code runs: no Node.js process under its wrangler.jsonc settings", async () => {
    expect(await (await server.getWorker("generator-probe").fetch("http://probe.localhost/process")).text()).toBe("undefined");
  });
});
