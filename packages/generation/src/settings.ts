import { LIMITS } from "@asksite/core";
import type { D1Database } from "@cloudflare/workers-types";

const DAY_MS = 86_400_000;

/** 00:00 UTC of the day that contains `now` (epoch milliseconds). */
export const utcDayStart = (now: number): number => now - (now % DAY_MS);

const setting = async (db: D1Database, key: string): Promise<string | undefined> =>
  (await db.prepare("SELECT value FROM settings WHERE key = ?1").bind(key).first<{ value: string }>())?.value;

/** The kill switch: GENERATION_ENABLED must be exactly "true" and the setting must not be "false" (§6.3). */
export async function isGenerationEnabled(env: { DB: D1Database; GENERATION_ENABLED: string }): Promise<boolean> {
  if (env.GENERATION_ENABLED !== "true") return false;
  return (await setting(env.DB, "generation.enabled")) !== "false";
}

const asLimit = (value: string | undefined): number | undefined => (value !== undefined && /^\d{1,6}$/.test(value) ? Number(value) : undefined);

/** Daily limit in force: the setting, else DAILY_MODEL_LIMIT, else LIMITS.defaultDailyModelLimit. */
export async function dailyModelLimit(env: { DB: D1Database; DAILY_MODEL_LIMIT: string }): Promise<number> {
  return asLimit(await setting(env.DB, "generation.daily_model_limit")) ?? asLimit(env.DAILY_MODEL_LIMIT) ?? LIMITS.defaultDailyModelLimit;
}

/** Jobs that took one of today's model calls (the model_slot claimed in §6.3 step 1). */
export async function modelCallsToday(db: D1Database, now: number): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM generations WHERE model_slot = 1 AND started_at >= ?1").bind(utcDayStart(now)).first<{ n: number }>();
  return row?.n ?? 0;
}
