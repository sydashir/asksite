import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { newId } from "@asksite/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSite, sitesHarness, type ToolsEnv } from "./support/harness.ts";

// S1 Part I: form.ts's email count (how many of today's leads had their email tried) must read an index, not
// the whole leads table: D1 bills every row scanned. migration 0007 adds leads_emailed, a partial index, and
// SQLite uses a partial index only when the query's WHERE terms match the index's, so this takes the count's
// SQL out of form.ts itself (a retyped copy could drift) and asks the real database for its plan.

const COUNT_SQL = (() => {
  const source = readFileSync(resolve(import.meta.dirname, "../src/form.ts"), "utf8");
  const found = [...source.matchAll(/\((SELECT COUNT\(\*\) FROM leads WHERE created_at >= \?12[^)]*)\)/g)];
  if (found.length !== 1 || found[0]?.[1] === undefined) throw new Error("form.ts: the email count query was not found exactly once");
  return found[0][1];
})();
const DAY_MS = 86_400_000;

const h = sitesHarness();
let tools: ToolsEnv;
beforeAll(async () => {
  ({ tools } = await h.start());
}, 120_000);
afterAll(async () => {
  await h.server.close();
});

/** The plan's detail lines for the count, binding twelve values because the SQL numbers its parameters up to ?12. */
async function plan(): Promise<string[]> {
  const { results } = await tools.DB.prepare(`EXPLAIN QUERY PLAN ${COUNT_SQL}`).bind(...Array.from({ length: 12 }, (_, i) => (i === 11 ? 0 : null))).all<{ detail: string }>();
  return results.map((row) => row.detail);
}

describe("the email count's query plan (migration 0007)", () => {
  it("takes the SQL from form.ts, with the terms the index must match", () => {
    expect(COUNT_SQL).toBe("SELECT COUNT(*) FROM leads WHERE created_at >= ?12 AND spam = 0 AND email_error IS NOT 'daily_cap'");
  });

  it("uses leads_emailed without statistics", async () => {
    expect(await plan()).toEqual([expect.stringMatching(/USING (COVERING )?INDEX leads_emailed\b/)]);
  });

  it("still uses leads_emailed after ANALYZE, on a table where most rows are not emailed", async () => {
    const site = await seedSite(tools);
    const now = Date.now();
    const rows = Array.from({ length: 300 }, (_, i) => {
      const spam = i % 3 === 0 ? 1 : 0;
      const capped = i % 3 === 1 ? "daily_cap" : null;
      return tools.DB.prepare("INSERT INTO leads (id, site_id, created_at, name, phone, email_status, email_error, spam, ip_hash) VALUES (?, ?, ?, 'n', '5125550100', 'sent', ?, ?, ?)")
        .bind(newId(), site.siteId, now - (i % 5) * DAY_MS, capped, spam, `h${i % 7}`);
    });
    await tools.DB.batch(rows);
    await tools.DB.exec("ANALYZE");
    expect((await tools.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_stat1 WHERE idx = 'leads_emailed'").first<{ n: number }>())?.n).toBe(1);
    expect(await plan()).toEqual([expect.stringMatching(/USING (COVERING )?INDEX leads_emailed\b/)]);
    await tools.DB.batch([tools.DB.prepare("DELETE FROM leads"), tools.DB.prepare("DELETE FROM sqlite_stat1")]);
  });
});
