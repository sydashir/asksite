import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LIMITS, newId } from "@asksite/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { insertLead } from "../src/form.ts";
import { holdBatch, metered, writesReturnNoRows } from "./support/d1.ts";
import { at, linesWith, seedSite, settledLeads, sitesHarness, sitesLines, TEST_VARS, type ToolsEnv } from "./support/harness.ts";

// A11c: lead emails have their own cap for the UTC day across ALL sites, LEAD_EMAILS_PER_DAY (40), so
// contact-form spam cannot use up the Resend Free budget (100 a day) that sign-in links need too. Over
// the cap the lead is still saved (the owner sees it in the app) and the visitor still gets the usual
// thank-you page; the lead is stored as failed / daily_cap and is never emailed. The cap counts every
// site's leads in the Worker's D1, so each test empties the leads first, and each value of the variable
// runs its own Worker with its own D1.

type Harness = ReturnType<typeof sitesHarness>;
type Row = Record<string, unknown>;

const PRODUCTION = JSON.parse(readFileSync(resolve(import.meta.dirname, "../wrangler.jsonc"), "utf8")) as { vars: Record<string, string> };
const CAP = Number(TEST_VARS.LEAD_EMAILS_PER_DAY);
const DAY_MS = 86_400_000;
const GOOD = { name: "Dana Price", phone: "(512) 555-0199", email: "dana@example.com", service: "Drain cleaning", message: "Kitchen sink is blocked.", website: "" };
const CONFIG_INVALID = { worker: "asksite-sites", event: "config_invalid", variable: "LEAD_EMAILS_PER_DAY" };

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** 00:00 UTC of the day `now` falls in, worked out here rather than with the code's own helper. */
const dayStart = (now: number) => now - (now % DAY_MS);

/** The cap counts leads since 00:00 UTC: start well clear of midnight, so the test and the Worker see the same day. */
async function clearOfMidnight(): Promise<void> {
  const left = DAY_MS - (Date.now() % DAY_MS);
  if (left < 120_000) await sleep(left + 50);
}

let ipCounter = 0;
/** A visitor posts the contact form. Every call comes from its own IP, so the per-IP rate limit never bites. */
function post(h: Harness, site: { slug: string; siteId: string }, fields: Record<string, string> = {}) {
  ipCounter += 1;
  return h.server.fetch(at(site.slug, `/_f/${site.siteId}`), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": `203.0.${Math.floor(ipCounter / 256)}.${ipCounter % 256}` },
    body: new URLSearchParams({ ...GOOD, ...fields }).toString(),
  });
}

/** Stores `count` leads directly, as they look once the Worker has handled them, each from its own network (A15 counts a network's leads). */
async function fill(tools: ToolsEnv, siteId: string, count: number, row: { createdAt: number; status: string; spam?: 0 | 1; error?: string }): Promise<void> {
  await tools.DB.batch(
    Array.from({ length: count }, () =>
      tools.DB.prepare("INSERT INTO leads (id, site_id, created_at, name, phone, spam, email_status, email_error, ip_hash) VALUES (?, ?, ?, 'n', '5125550100', ?, ?, ?, ?)")
        .bind(newId(), siteId, row.createdAt, row.spam ?? 0, row.status, row.error ?? null, newId()),
    ),
  );
}

/** A site's leads, by visitor name, once their emails have finished. */
async function byName(tools: ToolsEnv, siteId: string): Promise<Record<string, Row>> {
  return Object.fromEntries((await settledLeads(tools, siteId)).map((lead) => [String(lead["name"]), lead]));
}

async function leadEmails(tools: ToolsEnv): Promise<Row[]> {
  return (await tools.DB.prepare("SELECT to_addr, subject FROM dev_outbox WHERE tag = 'lead' ORDER BY id").all<Row>()).results;
}

/** insertLead's answer and the rows its batch read (D1 bills rows read). */
async function insertCounted(db: D1Database, input: Parameters<typeof insertLead>[1]): Promise<{ status: string; rows: number }> {
  const meter = metered(db);
  const status = await insertLead(meter.db, input);
  return { status, rows: meter.rowsRead() };
}

describe(`LEAD_EMAILS_PER_DAY = ${CAP}, the production value`, () => {
  const h = sitesHarness();
  let tools: ToolsEnv;
  beforeAll(async () => {
    ({ tools } = await h.start());
  }, 120_000);
  afterAll(async () => {
    await h.server.close();
  });
  beforeEach(async () => {
    await tools.DB.batch([tools.DB.prepare("DELETE FROM leads"), tools.DB.prepare("DELETE FROM dev_outbox")]);
    await clearOfMidnight();
    h.server.clearLogs();
  });

  it(`sends the ${CAP}th lead email of the UTC day across all sites, then saves the next lead unemailed and still thanks its visitor`, async () => {
    expect(CAP).toBe(40);
    expect(TEST_VARS.LEAD_EMAILS_PER_DAY).toBe(PRODUCTION.vars["LEAD_EMAILS_PER_DAY"]);
    const a = await seedSite(tools);
    const b = await seedSite(tools);
    const c = await seedSite(tools);
    const today = dayStart(Date.now());
    // 39 lead emails already tried today on two other sites: sent, refused by Resend, and one still sending.
    await fill(tools, a.siteId, 20, { createdAt: today, status: "sent" });
    await fill(tools, b.siteId, 18, { createdAt: today + 1, status: "failed", error: "rejected" });
    await fill(tools, b.siteId, 1, { createdAt: today + 2, status: "pending" });

    expect((await post(h, c, { name: "Last Sent" })).status).toBe(303);
    const over = await post(h, c, { name: "Over Cap" });
    expect(over.status).toBe(303);
    expect(over.headers.get("location")).toBe(`/_f/${c.siteId}/sent`);

    const leads = await byName(tools, c.siteId);
    expect(leads["Last Sent"]).toMatchObject({ spam: 0, email_status: "sent", email_error: null });
    expect(leads["Over Cap"]).toMatchObject({
      name: "Over Cap", phone: "(512) 555-0199", email: "dana@example.com", service: "Drain cleaning", message: "Kitchen sink is blocked.",
      spam: 0, email_status: "failed", email_error: "daily_cap",
    });
    expect(await leadEmails(tools)).toEqual([{ to_addr: c.ownerEmail, subject: "New request from your website: Last Sent" }]);

    // One line for the capped lead: the request's own line, with codes and ids only.
    expect(await linesWith(h, "code", "lead_email_cap_reached", 1)).toEqual([
      { worker: "asksite-sites", route: "form", status: 303, ms: expect.any(Number), siteId: c.siteId, code: "lead_email_cap_reached" },
    ]);
    const log = JSON.stringify(sitesLines(h));
    for (const personal of ["Over Cap", "Dana", "(512) 555-0199", "dana@example.com", c.ownerEmail, "Kitchen", "203.0."]) expect(log).not.toContain(personal);
    expect(sitesLines(h).filter((line) => line["event"] === "config_invalid")).toEqual([]);
  });

  it("counts only today's leads that are not spam and whose email was tried: yesterday's, spam and capped leads do not count, one at 00:00 UTC does", async () => {
    const a = await seedSite(tools);
    const c = await seedSite(tools);
    const today = dayStart(Date.now());
    await fill(tools, a.siteId, 50, { createdAt: today - 1, status: "sent" });
    await fill(tools, a.siteId, 50, { createdAt: today, spam: 1, status: "skipped" });
    await fill(tools, a.siteId, 50, { createdAt: today, status: "failed", error: "daily_cap" });
    await fill(tools, a.siteId, CAP - 1, { createdAt: today, status: "sent" });

    expect((await post(h, c, { name: "Last Sent" })).status).toBe(303);
    expect((await post(h, c, { name: "Over Cap" })).status).toBe(303);
    const leads = await byName(tools, c.siteId);
    expect(leads["Last Sent"]).toMatchObject({ email_status: "sent", email_error: null });
    expect(leads["Over Cap"]).toMatchObject({ email_status: "failed", email_error: "daily_cap" });
  });

  it("keeps a spam lead over the cap as spam: skipped, never capped", async () => {
    const a = await seedSite(tools);
    const c = await seedSite(tools);
    await fill(tools, a.siteId, CAP, { createdAt: dayStart(Date.now()), status: "sent" });
    expect((await post(h, c, { message: "http://a http://b https://c http://d" })).status).toBe(303);
    expect(await settledLeads(tools, c.siteId)).toMatchObject([{ spam: 1, email_status: "skipped", email_error: null }]);
    expect(await linesWith(h, "code", "spam", 1)).toHaveLength(1);
    expect(sitesLines(h).filter((line) => line["code"] === "lead_email_cap_reached")).toEqual([]);
    expect(await leadEmails(tools)).toEqual([]);
  });

  it("stays exact when visitors post at the same time with 1 email left: exactly one is emailed, every visitor is thanked", async () => {
    const filler = await seedSite(tools);
    const sites = [await seedSite(tools), await seedSite(tools), await seedSite(tools)];
    await fill(tools, filler.siteId, CAP - 1, { createdAt: dayStart(Date.now()), status: "sent" });

    const responses = await Promise.all(sites.flatMap((site) => [post(h, site), post(h, site)]));
    expect(responses.map((response) => response.status)).toEqual([303, 303, 303, 303, 303, 303]);
    const posted = (await Promise.all(sites.map((site) => settledLeads(tools, site.siteId)))).flat();
    expect(posted.map((lead) => `${lead["email_status"]}/${lead["email_error"]}`).sort()).toEqual([
      "failed/daily_cap", "failed/daily_cap", "failed/daily_cap", "failed/daily_cap", "failed/daily_cap", "sent/null",
    ]);
    expect(await leadEmails(tools)).toHaveLength(1);
  });

  // The test above cannot force two requests to interleave, so a version that counts first and inserts
  // later would pass it too. Here the order is fixed: a lead that started before the 40th but is written
  // after it must be capped, because the count happens when the lead is written.
  it("decides the email when the lead is written, in the same statement: a lead written after the 40th is capped", async () => {
    const filler = await seedSite(tools);
    const site = await seedSite(tools);
    const now = Date.now();
    await fill(tools, filler.siteId, CAP - 1, { createdAt: dayStart(now), status: "sent" });
    const input = (name: string) => ({
      leadId: newId(), siteId: site.siteId, now, spam: false, ipHash: "h", emailsPerDay: CAP,
      lead: { name, phone: "5125550199", email: null, service: null, message: null },
    });

    const production = writesReturnNoRows(tools.DB);
    const held = holdBatch(production);
    const late = insertLead(held.db, input("Late"));
    await Promise.race([held.reached, late]);
    expect(await insertLead(production, input("Fortieth"))).toBe("pending");
    held.release();
    expect(await late).toBe("failed");
    const stored = await tools.DB.prepare("SELECT name, email_status, email_error FROM leads WHERE site_id = ? ORDER BY name").bind(site.siteId).all();
    expect(stored.results).toEqual([
      { name: "Fortieth", email_status: "pending", email_error: null },
      { name: "Late", email_status: "failed", email_error: "daily_cap" },
    ]);
  });

  // D1 bills every row a statement scans, and the day's email count scans every lead (A11c adds no
  // index). Only a lead that is stored and not spam may run it: spam and posts the site's own cap refuses
  // are held back only by the per-IP rate limit, so they read just the site's rows for today (at most
  // LIMITS.leadsPerSitePerDay, through the leads_site index), the network's rows for today (A15, through
  // the leads_network index) and a few for the insert and the read-back.
  it("reads only the site's rows for today for spam and for a post the site's cap refuses, however many leads the table holds", async () => {
    const history = await seedSite(tools);
    const open = await seedSite(tools);
    const full = await seedSite(tools);
    const now = Date.now();
    const today = dayStart(now);
    const HISTORY = 2_000;
    // Earlier days' leads, which retention keeps for 180 days: one statement, since a batch of 2,000 is slow.
    await tools.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
       INSERT INTO leads (id, site_id, created_at, name, phone, spam, email_status, ip_hash) SELECT 'old-' || i, ?2, ?3, 'n', '5125550100', 0, 'sent', 'h' FROM n`,
    ).bind(HISTORY, history.siteId, today - DAY_MS).run();
    await fill(tools, full.siteId, LIMITS.leadsPerSitePerDay, { createdAt: today, status: "sent" });
    // The meter works: counting the whole table reads every row.
    const [scan] = await tools.DB.batch([tools.DB.prepare("SELECT COUNT(*) AS n FROM leads")]);
    expect(scan?.meta.rows_read).toBeGreaterThanOrEqual(HISTORY);

    const input = (site: { siteId: string }, spam: boolean) => ({
      leadId: newId(), siteId: site.siteId, now, spam, ipHash: "h", emailsPerDay: CAP,
      lead: { name: "Dana Price", phone: "5125550199", email: null, service: null, message: null },
    });
    const posts = {
      spam: await insertCounted(tools.DB, input(open, true)),
      siteCapped: await insertCounted(tools.DB, input(full, false)),
      spamSiteCapped: await insertCounted(tools.DB, input(full, true)),
    };
    expect(posts).toEqual({
      spam: { status: "skipped", rows: expect.any(Number) },
      siteCapped: { status: "site_daily_cap", rows: expect.any(Number) },
      spamSiteCapped: { status: "site_daily_cap", rows: expect.any(Number) },
    });
    const tooMany = Object.entries(posts).filter(([, post]) => post.rows > LIMITS.leadsPerSitePerDay + 10);
    expect(tooMany.map(([kind, post]) => `${kind} read ${post.rows} rows`)).toEqual([]);
  });

  it(`holds a flood to the cap: 50 + 50 + 1 posts on three sites are all saved and thanked, and only ${CAP} are emailed`, async () => {
    const sites = [await seedSite(tools), await seedSite(tools), await seedSite(tools)];
    const posts = [50, 50, 1];
    const statuses: number[] = [];
    for (const [index, site] of sites.entries()) {
      for (let i = 0; i < (posts[index] ?? 0); i++) statuses.push((await post(h, site)).status);
    }
    expect(statuses).toEqual(Array.from({ length: 101 }, () => 303));

    const leads = (await Promise.all(sites.map((site) => settledLeads(tools, site.siteId)))).flat();
    const outcomes: Record<string, number> = {};
    for (const lead of leads) {
      const outcome = `${lead["email_status"]}/${lead["email_error"]}`;
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    }
    expect(outcomes).toEqual({ "sent/null": CAP, "failed/daily_cap": 101 - CAP });
    expect(await leadEmails(tools)).toHaveLength(CAP);
    expect(await linesWith(h, "code", "lead_email_cap_reached", 101 - CAP)).toHaveLength(101 - CAP);
  }, 120_000);
});

describe("a valid LEAD_EMAILS_PER_DAY other than the default", () => {
  const h = sitesHarness({ vars: { LEAD_EMAILS_PER_DAY: "2" } });
  let tools: ToolsEnv;
  beforeAll(async () => {
    ({ tools } = await h.start());
  }, 120_000);
  afterAll(async () => {
    await h.server.close();
  });

  it("is the day's cap for all sites, with nothing logged about the value", async () => {
    await clearOfMidnight();
    const a = await seedSite(tools);
    const b = await seedSite(tools);
    h.server.clearLogs();
    expect((await post(h, a, { name: "First" })).status).toBe(303);
    expect((await post(h, b, { name: "Second" })).status).toBe(303);
    expect((await post(h, b, { name: "Third" })).status).toBe(303);
    const leads = { ...(await byName(tools, a.siteId)), ...(await byName(tools, b.siteId)) };
    expect(Object.fromEntries(Object.entries(leads).map(([name, lead]) => [name, lead["email_error"] ?? lead["email_status"]]))).toEqual({
      First: "sent", Second: "sent", Third: "daily_cap",
    });
    expect(await leadEmails(tools)).toHaveLength(2);
    expect(await linesWith(h, "code", "lead_email_cap_reached", 1)).toHaveLength(1);
    expect(sitesLines(h).filter((line) => line["event"] === "config_invalid")).toEqual([]);
  });
});

describe("an invalid LEAD_EMAILS_PER_DAY", () => {
  const h = sitesHarness({ vars: { LEAD_EMAILS_PER_DAY: "0" } });
  let tools: ToolsEnv;
  beforeAll(async () => {
    ({ tools } = await h.start());
  }, 120_000);
  afterAll(async () => {
    await h.server.close();
  });

  it("is logged as config_invalid, never its value, and the default of 40 a day applies", async () => {
    await clearOfMidnight();
    const a = await seedSite(tools);
    const c = await seedSite(tools);
    await fill(tools, a.siteId, 39, { createdAt: dayStart(Date.now()), status: "sent" });
    h.server.clearLogs();
    expect((await post(h, c, { name: "Last Sent" })).status).toBe(303);
    expect((await post(h, c, { name: "Over Cap" })).status).toBe(303);
    const leads = await byName(tools, c.siteId);
    expect(leads["Last Sent"]).toMatchObject({ email_status: "sent", email_error: null });
    expect(leads["Over Cap"]).toMatchObject({ email_status: "failed", email_error: "daily_cap" });
    expect(await linesWith(h, "event", "config_invalid", 2)).toEqual([CONFIG_INVALID, CONFIG_INVALID]);
  });
});
