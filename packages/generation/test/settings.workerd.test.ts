import type { GenerationRow } from "@asksite/core";
import type { D1Database } from "@cloudflare/workers-types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dailyModelLimit, isGenerationEnabled, modelCallsToday, utcDayStart } from "../src/settings.ts";
import { toGenerationView } from "../src/view.ts";
import { clearTables, insertGeneration, seedOwnerSite, setSetting, startLocalD1 } from "./support/d1.ts";

let db: D1Database;
let close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await startLocalD1()), 120_000);
afterAll(async () => close());
beforeEach(async () => clearTables(db));

describe("isGenerationEnabled", () => {
  it("is on only when the variable is exactly \"true\" and the setting is not \"false\"", async () => {
    expect(await isGenerationEnabled({ DB: db, GENERATION_ENABLED: "true" })).toBe(true);
    expect(await isGenerationEnabled({ DB: db, GENERATION_ENABLED: "TRUE" })).toBe(false);
    expect(await isGenerationEnabled({ DB: db, GENERATION_ENABLED: "false" })).toBe(false);
    await setSetting(db, "generation.enabled", "false");
    expect(await isGenerationEnabled({ DB: db, GENERATION_ENABLED: "true" })).toBe(false);
    await setSetting(db, "generation.enabled", "true");
    expect(await isGenerationEnabled({ DB: db, GENERATION_ENABLED: "false" })).toBe(false);
  });
});

describe("dailyModelLimit", () => {
  it("uses the setting, else the variable, else the default of 30; malformed values are skipped", async () => {
    expect(await dailyModelLimit({ DB: db, DAILY_MODEL_LIMIT: "12" })).toBe(12);
    expect(await dailyModelLimit({ DB: db, DAILY_MODEL_LIMIT: "twelve" })).toBe(30);
    await setSetting(db, "generation.daily_model_limit", "0");
    expect(await dailyModelLimit({ DB: db, DAILY_MODEL_LIMIT: "12" })).toBe(0);
    await setSetting(db, "generation.daily_model_limit", "-1");
    expect(await dailyModelLimit({ DB: db, DAILY_MODEL_LIMIT: "12" })).toBe(12);
  });
});

describe("modelCallsToday", () => {
  it("counts jobs that took a model slot since 00:00 UTC", async () => {
    const now = Date.UTC(2026, 8, 24, 15);
    await seedOwnerSite(db, "o1", "s1");
    await insertGeneration(db, { id: "a", site_id: "s1", owner_id: "o1", status: "succeeded", model_slot: 1, started_at: utcDayStart(now) });
    await insertGeneration(db, { id: "b", site_id: "s1", owner_id: "o1", status: "succeeded", model_slot: 1, started_at: utcDayStart(now) - 1 });
    await insertGeneration(db, { id: "c", site_id: "s1", owner_id: "o1", status: "succeeded", model_slot: 0, started_at: now });
    expect(utcDayStart(now)).toBe(Date.UTC(2026, 8, 24));
    expect(await modelCallsToday(db, now)).toBe(1);
  });
});

describe("toGenerationView", () => {
  const row: GenerationRow = {
    id: "g", site_id: "s", owner_id: "o", kind: "first", status: "succeeded", input_json: "{}", output_json: "{}",
    used_fallback: 1, fallback_reason: "budget", model_slot: 0, provider: null, model: null, attempts: 0,
    input_tokens: 0, output_tokens: 0, cost_microusd: 0, error_code: null, created_at: 5, started_at: 6, finished_at: 7,
  };

  it("maps the row to the owner-facing view", () => {
    expect(toGenerationView(row)).toEqual({ id: "g", kind: "first", status: "succeeded", createdAt: 5, finishedAt: 7, errorCode: null, usedFallback: true, fallbackReason: "budget" });
  });

  it("never passes an unknown value through", () => {
    expect(toGenerationView({ ...row, status: "failed", error_code: "boom", fallback_reason: "x", used_fallback: 0 })).toMatchObject({ errorCode: "internal", fallbackReason: null, usedFallback: false });
    expect(toGenerationView({ ...row, status: "weird" as GenerationRow["status"], kind: "odd" as GenerationRow["kind"] })).toMatchObject({ status: "failed", kind: "first" });
  });
});
