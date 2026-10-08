import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { newId } from "@asksite/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RETRY_SQL } from "../src/lead-retry.ts";
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
// The whole INSERT that insertLead prepares: the count sits inside it, with the repeat and limit checks beside it.
const INSERT_SQL = (() => {
  const source = readFileSync(resolve(import.meta.dirname, "../src/form.ts"), "utf8");
  const found = [...source.matchAll(/`(INSERT INTO leads \(id, site_id[^`]*)`/g)];
  if (found.length !== 1 || found[0]?.[1] === undefined) throw new Error("form.ts: the lead INSERT was not found exactly once");
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

/** The plan's detail lines for the whole INSERT, binding sixteen values (the SQL numbers its parameters up to ?16). */
async function insertPlan(): Promise<string[]> {
  const { results } = await tools.DB.prepare(`EXPLAIN QUERY PLAN ${INSERT_SQL}`).bind(...Array.from({ length: 16 }, () => 0)).all<{ detail: string }>();
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

  // A comment that quotes the old SQL, or a second subquery that scans leads, would not show in the count's own
  // plan: so the whole statement a lead post runs is explained, and no line of it may scan the table.
  it("scans leads nowhere in the whole INSERT, and reads leads_emailed in it", async () => {
    const lines = await insertPlan();
    expect(lines.filter((line) => /\bSCAN leads\b/.test(line))).toEqual([]);
    expect(lines.filter((line) => /USING (COVERING )?INDEX leads_emailed\b/.test(line))).toHaveLength(1);
  });
});

/** The plan's detail lines for the lead-email retry's read (C1), binding its four values (?1 to ?4). */
async function retryPlan(): Promise<string[]> {
  const { results } = await tools.DB.prepare(`EXPLAIN QUERY PLAN ${RETRY_SQL}`).bind(0, 0, 0, 10).all<{ detail: string }>();
  return results.map((row) => row.detail);
}

// C1: the retry cron reads every 15 minutes. It names the index's terms literally (spam = 0 and email_error IS NOT
// 'daily_cap'), so it reads the same partial index as the count: the last 23 h of tried leads, never the table. Its
// CROSS JOINs keep leads first whatever the statistics say: with statistics from a one-site table (as the 0007 test
// above leaves loaded), a plain JOIN made workerd's SQLite scan sites and owners first and read leads by site
// (measured 2026-10-08, .superpowers/evidence/c1-retry/plans.json).
describe("the lead-email retry's query plan (C1)", () => {
  it("keeps the terms the index needs", () => {
    expect(RETRY_SQL).toContain("l.spam = 0 AND l.email_error IS NOT 'daily_cap'");
  });

  it("reads leads first, through leads_emailed, whatever statistics are loaded", async () => {
    const lines = await retryPlan();
    expect(lines[0]).toMatch(/^SEARCH l USING (COVERING )?INDEX leads_emailed\b/);
    expect(lines.filter((line) => /\bSCAN l\b/.test(line))).toEqual([]);
  });

  it("with statistics like production's (many sites and owners, most leads not retried), finds each site and owner by id and scans no table", async () => {
    const owners = Array.from({ length: 200 }, () => ({ ownerId: newId(), siteId: newId() }));
    await tools.DB.batch(owners.flatMap(({ ownerId, siteId }, i) => [
      tools.DB.prepare("INSERT INTO owners (id, email, created_at) VALUES (?, ?, 1)").bind(ownerId, `plan-${i}@example.com`),
      tools.DB.prepare("INSERT INTO sites (id, owner_id, slug, indexable, created_at, updated_at) VALUES (?, ?, ?, 0, 1, 1)").bind(siteId, ownerId, `plan-${i}-${siteId.slice(0, 6)}`),
    ]));
    const now = Date.now();
    const rows = Array.from({ length: 300 }, (_, i) => {
      const spam = i % 3 === 0 ? 1 : 0;
      const capped = i % 3 === 1 ? "daily_cap" : null;
      return tools.DB.prepare("INSERT INTO leads (id, site_id, created_at, name, phone, email_status, email_error, spam, ip_hash) VALUES (?, ?, ?, 'n', '5125550100', 'sent', ?, ?, ?)")
        .bind(newId(), owners[i % owners.length]?.siteId, now - (i % 5) * DAY_MS, capped, spam, `h${i % 7}`);
    });
    await tools.DB.batch(rows);
    await tools.DB.exec("ANALYZE");
    const lines = await retryPlan();
    expect(lines.filter((line) => /\bSCAN\b/.test(line))).toEqual([]);
    expect(lines.slice(0, 3)).toEqual([
      expect.stringMatching(/^SEARCH l USING (COVERING )?INDEX leads_emailed\b/),
      expect.stringMatching(/^SEARCH s USING (COVERING )?INDEX sqlite_autoindex_sites_1 \(id=\?\)/),
      expect.stringMatching(/^SEARCH o USING (COVERING )?INDEX sqlite_autoindex_owners_1 \(id=\?\)/),
    ]);
    await tools.DB.batch([tools.DB.prepare("DELETE FROM leads"), tools.DB.prepare("DELETE FROM sqlite_stat1")]);
  });
});
