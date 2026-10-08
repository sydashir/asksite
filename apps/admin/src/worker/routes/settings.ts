import { auditStatement, readJson } from "@asksite/app-common";
import { SettingsBody } from "@asksite/core";
import { Hono } from "hono";
import type { SettingsView } from "../../settings-view.ts";
import { utcDayStart } from "../db.ts";
import type { AdminDeps } from "../deps.ts";
import type { AdminEnv } from "../types.ts";

/** The AI kill switch, the daily model limit and today's usage (§3.2 step 5). */
export function settingsRoutes(deps: AdminDeps): Hono<AdminEnv> {
  const settings = new Hono<AdminEnv>();

  const read = async (env: Env, now: number): Promise<SettingsView> => {
    const dayStart = utcDayStart(now);
    const [enabled, usage, limit] = await Promise.all([
      env.DB.prepare("SELECT value FROM settings WHERE key = 'generation.enabled'").first<{ value: string }>(),
      env.DB.prepare(
        `SELECT COUNT(*) FILTER (WHERE model_slot = 1) AS calls, COALESCE(SUM(cost_microusd), 0) AS spent,
                COUNT(*) FILTER (WHERE model_slot = 1 AND NOT (status IN ('succeeded', 'failed') AND cost_microusd > 0)) AS unknown
         FROM generations WHERE started_at >= ?`,
      )
        .bind(dayStart)
        .first<{ calls: number; spent: number; unknown: number }>(),
      deps.generation.dailyModelLimit(env),
    ]);
    const perJob = deps.generation.worstCaseJobMicrousd(env.MODEL_PROVIDER, env.MODEL_ID);
    return {
      generationEnabled: enabled?.value !== "false",
      envGenerationEnabled: env.GENERATION_ENABLED === "true",
      dailyModelLimit: limit,
      modelCallsToday: usage?.calls ?? 0,
      spentTodayMicrousd: usage?.spent ?? 0,
      unknownCostJobsToday: usage?.unknown ?? 0,
      worstCaseDailyMicrousd: perJob === null ? null : limit * perJob,
    };
  };

  settings.get("/settings", async (c) => c.json(await read(c.env, Date.now())));

  settings.put("/settings", async (c) => {
    const body = await readJson(c, SettingsBody);
    const admin = c.get("admin");
    const db = c.env.DB;
    const now = Date.now();
    const upsert = (key: string, value: string) =>
      db
        .prepare(
          `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        )
        .bind(key, value, now, admin);
    const statements = [
      ...(body.generationEnabled === undefined ? [] : [upsert("generation.enabled", String(body.generationEnabled))]),
      ...(body.dailyModelLimit === undefined ? [] : [upsert("generation.daily_model_limit", String(body.dailyModelLimit))]),
    ];
    if (statements.length > 0) {
      await db.batch([...statements, auditStatement(db, { at: now, actor: `admin:${admin}`, action: "settings.updated", siteId: null, detail: body })]);
    }
    return c.json(await read(c.env, now));
  });

  return settings;
}
