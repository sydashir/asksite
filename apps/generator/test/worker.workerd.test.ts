import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { GenerationRow } from "@asksite/core";
import type { D1Database, Queue } from "@cloudflare/workers-types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";
import { FULL_SNAPSHOT } from "../../../packages/generation/test/support/samples.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
// Local D1 is shared by database id, so the producer uses the generator's own id (placeholder or real).
const GENERATOR = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")) as { d1_databases: Array<{ database_id: string }> };
const DATABASE = { binding: "DB", database_name: "asksite", database_id: GENERATOR.d1_databases[0]!.database_id, migrations_dir: "./packages/core/migrations" };

// The real apps/generator/wrangler.jsonc, with local test variables, plus a small producer Worker
// that shares its D1 database and sends to its queue, as asksite-app does in production.
const server = createTestHarness({
  root: ROOT,
  workers: [
    {
      configPath: "./apps/generator/wrangler.jsonc",
      vars: { ENVIRONMENT: "development", GENERATION_ENABLED: "true", DAILY_MODEL_LIMIT: "30", MODEL_PROVIDER: "fake", MODEL_ID: "fake-template", FAKE_MODE: "ok" },
      secrets: { ANTHROPIC_API_KEY: "", OPENAI_COMPAT_API_KEY: "" },
    },
    {
      config: {
        name: "test-producer",
        main: "./packages/generation/test/support/noop-worker.ts",
        compatibility_date: "2026-09-21",
        d1_databases: [DATABASE],
        queues: { producers: [{ binding: "GEN_QUEUE", queue: "asksite-generation" }] },
      },
    },
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
    expect((await producer.DB.prepare("SELECT COUNT(*) AS n FROM generations").first<{ n: number }>())?.n).toBe(0);
  }, 30_000);

  it("sweeps stuck jobs on its cron", async () => {
    const id = crypto.randomUUID();
    await queueRow(id, Date.now() - 7 * 60_000);
    expect(await server.getWorker().scheduled({ cron: "*/5 * * * *", scheduledTime: new Date() })).toMatchObject({ outcome: "ok" });
    expect(await waitForFinal(id)).toMatchObject({ status: "succeeded", used_fallback: 1, fallback_reason: "provider_error" });
  }, 30_000);

  it("logs IDs and codes only, never owner text", async () => {
    const id = crypto.randomUUID();
    await queueRow(id);
    await producer.GEN_QUEUE.send({ v: 1, generationId: id });
    await waitForFinal(id);
    const logs = JSON.stringify(server.getLogs());
    expect(logs).toContain(id);
    for (const secretish of ["Reliable Rooter", "Drain cleaning", "older homes", "Austin"]) expect(logs).not.toContain(secretish);
  }, 30_000);
});
