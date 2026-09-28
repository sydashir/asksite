import { hashIp, LIMITS, newId } from "@asksite/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { insertLead } from "../src/form.ts";
import { holdBatch, metered, writesReturnNoRows } from "./support/d1.ts";
import { at, linesWith, seedSite, settledLeads, sitesHarness, sitesLines, TEST_SECRETS, type ToolsEnv } from "./support/harness.ts";

// A15: one network may leave at most 3 leads a UTC day on one site and 5 across all sites, spam
// included, so one visitor can no longer close a business's form for the day or use up the day's lead
// emails. The network is the one the rate limit uses (ipRateKey): an IPv4 address whole, an IPv6 /64.
// Beyond either limit nothing is stored, emailed or counted, and the visitor gets the 429 "Please call
// instead" page. Each test empties the leads first, so no test depends on another's rows.

const PER_SITE = 3;
const ALL_SITES = 5;
const DAY_MS = 86_400_000;
const GOOD = { name: "Dana Price", phone: "(512) 555-0199", email: "dana@example.com", service: "Drain cleaning", message: "Kitchen sink is blocked.", website: "" };
const SPAM = { ...GOOD, message: "http://a http://b https://c http://d" };

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
  // The limits count leads since 00:00 UTC: start well clear of midnight (inside the 120 s hook timeout).
  const left = DAY_MS - (Date.now() % DAY_MS);
  if (left < 60_000) await new Promise((resolve) => setTimeout(resolve, left + 50));
  h.server.clearLogs();
});

/** 00:00 UTC of the day `now` falls in, worked out here rather than with the code's own helper. */
const dayStart = (now: number) => now - (now % DAY_MS);

function post(site: { slug: string; siteId: string }, ip: string, fields: Record<string, string> = {}) {
  return h.server.fetch(at(site.slug, `/_f/${site.siteId}`), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip },
    body: new URLSearchParams({ ...GOOD, ...fields }).toString(),
  });
}

const leadsOf = async (siteId: string) =>
  (await tools.DB.prepare("SELECT name, spam, email_status, ip_hash FROM leads WHERE site_id = ? ORDER BY created_at, name").bind(siteId).all<Record<string, unknown>>()).results;

const leadEmailsTo = async (to: string) => (await tools.DB.prepare("SELECT subject FROM dev_outbox WHERE to_addr = ? AND tag = 'lead'").bind(to).all()).results;

/** The network's hash, as the lead row stores it: hashIp of the IPv4 address, or of the IPv6 /64 written out here. */
const networkHash = (network: string) => hashIp(TEST_SECRETS.IP_HASH_KEY, network);

/** Stores leads directly, as the Worker would have stored them from `ipHash`'s network. */
async function fill(siteId: string, count: number, row: { createdAt: number; ipHash: string; spam?: 0 | 1 }): Promise<void> {
  await tools.DB.batch(
    Array.from({ length: count }, () =>
      tools.DB.prepare("INSERT INTO leads (id, site_id, created_at, name, phone, spam, email_status, ip_hash) VALUES (?, ?, ?, 'n', '5125550100', ?, ?, ?)")
        .bind(newId(), siteId, row.createdAt, row.spam ?? 0, row.spam === 1 ? "skipped" : "sent", row.ipHash),
    ),
  );
}

/** insertLead's input. The day's email cap (A11c, tested in lead-cap.workerd.test.ts) is set out of reach here. */
const input = (site: { siteId: string }, ipHash: string, extra: { now?: number; spam?: boolean } = {}) => ({
  leadId: newId(), siteId: site.siteId, now: extra.now ?? Date.now(), spam: extra.spam ?? false, ipHash, emailsPerDay: 1_000_000,
  lead: { name: "Dana Price", phone: "5125550199", email: null, service: null, message: null },
});

describe("A15 per-network daily limits", () => {
  it(`are ${PER_SITE} leads per site and ${ALL_SITES} across all sites (core LIMITS)`, () => {
    expect({ perSite: LIMITS.leadsPerNetworkPerSitePerDay, allSites: LIMITS.leadsPerNetworkPerDay }).toEqual({ perSite: PER_SITE, allSites: ALL_SITES });
  });

  it(`stores ${PER_SITE} leads a UTC day from one network on one site; the next is not stored, emailed or counted, and gets "Please call instead"`, async () => {
    const site = await seedSite(tools);
    const statuses: number[] = [];
    for (let i = 1; i <= PER_SITE; i++) statuses.push((await post(site, "192.0.2.10", { name: `Visitor ${i}` })).status);
    const before = Date.now();
    const refused = await post(site, "192.0.2.10", { name: "Visitor 4" });
    const after = Date.now();
    expect([...statuses, refused.status]).toEqual([303, 303, 303, 429]);
    // Retry when the limits start again, at the next 00:00 UTC.
    const secondsLeft = (t: number) => Math.ceil((dayStart(t) + DAY_MS - t) / 1000);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(secondsLeft(after));
    expect(Number(refused.headers.get("retry-after"))).toBeLessThanOrEqual(secondsLeft(before));
    expect(refused.headers.get("x-robots-tag")).toBe("noindex");
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect(await refused.text()).toContain("<h1>Please call instead</h1>");

    const leads = await settledLeads(tools, site.siteId);
    expect(leads.map((lead) => lead["name"])).toEqual(["Visitor 1", "Visitor 2", "Visitor 3"]);
    expect(leads.every((lead) => lead["email_status"] === "sent")).toBe(true);
    expect(await leadEmailsTo(site.ownerEmail)).toHaveLength(PER_SITE);

    // The form stays open for everyone else: the refused post did not count toward the site's 50.
    expect((await post(site, "192.0.2.11", { name: "Neighbour" })).status).toBe(303);
    expect(await settledLeads(tools, site.siteId)).toHaveLength(PER_SITE + 1);

    expect(await linesWith(h, "code", "network_daily_limit", 1)).toEqual([
      { worker: "asksite-sites", route: "form", status: 429, ms: expect.any(Number), siteId: site.siteId, code: "network_daily_limit" },
    ]);
    const log = JSON.stringify(sitesLines(h));
    for (const personal of ["Visitor", "Dana", "555-0199", "dana@example.com", site.ownerEmail, "192.0.2."]) expect(log).not.toContain(personal);
  });

  it(`stores ${ALL_SITES} leads a UTC day from one network across all sites; the next, on a site it never used, is refused`, async () => {
    const [a, b, c, d] = [await seedSite(tools), await seedSite(tools), await seedSite(tools), await seedSite(tools)];
    const statuses: number[] = [];
    for (const site of [a, a, b, b, c]) statuses.push((await post(site, "192.0.2.20")).status);
    expect(statuses).toEqual([303, 303, 303, 303, 303]);
    expect((await post(d, "192.0.2.20")).status).toBe(429);
    expect(await leadsOf(d.siteId)).toEqual([]);
    expect(await leadEmailsTo(d.ownerEmail)).toEqual([]);
    expect((await post(d, "192.0.2.21")).status).toBe(303);
    expect(await linesWith(h, "code", "network_daily_limit", 1)).toHaveLength(1);
  });

  it("counts spam: the network's spam uses up its leads on a site and across sites, and its next post, spam or not, is refused and not stored", async () => {
    const [site, second, third] = [await seedSite(tools), await seedSite(tools), await seedSite(tools)];
    for (let i = 0; i < PER_SITE; i++) expect((await post(site, "192.0.2.30", SPAM)).status).toBe(303);
    expect((await post(site, "192.0.2.30")).status).toBe(429);
    expect((await post(site, "192.0.2.30", SPAM)).status).toBe(429);
    expect((await leadsOf(site.siteId)).map((lead) => `${lead["spam"]}/${lead["email_status"]}`)).toEqual(["1/skipped", "1/skipped", "1/skipped"]);
    expect(await leadEmailsTo(site.ownerEmail)).toEqual([]);
    // 3 + 2 spam leads use up the network's 5 for all sites.
    for (let i = 0; i < ALL_SITES - PER_SITE; i++) expect((await post(second, "192.0.2.30", SPAM)).status).toBe(303);
    expect((await post(third, "192.0.2.30")).status).toBe(429);
    expect(await leadsOf(third.siteId)).toEqual([]);
  });

  it("keys an IPv6 visitor on its /64: other addresses in that /64 share the limit, another /64 does not, and ip_hash is the /64's", async () => {
    const site = await seedSite(tools);
    const statuses: number[] = [];
    for (const ip of ["2001:db8:a:1::1", "2001:db8:a:1::2", "2001:db8:a:1:ffff:ffff:ffff:fffe", "2001:DB8:A:1::9"]) statuses.push((await post(site, ip)).status);
    expect(statuses).toEqual([303, 303, 303, 429]);
    expect((await post(site, "2001:db8:a:2::1")).status).toBe(303);
    const hashes = (await leadsOf(site.siteId)).map((lead) => lead["ip_hash"]);
    const net1 = await networkHash("2001:db8:a:1::/64");
    expect(hashes.sort()).toEqual([net1, net1, net1, await networkHash("2001:db8:a:2::/64")].sort());
    expect(hashes).not.toContain(await networkHash("2001:db8:a:1::1"));
  });

  it("counts only today's leads: the network's leads before 00:00 UTC do not count, one at 00:00 UTC does", async () => {
    const site = await seedSite(tools);
    const other = await seedSite(tools);
    const ipHash = await networkHash("192.0.2.40");
    const today = dayStart(Date.now());
    await fill(site.siteId, 10, { createdAt: today - 1, ipHash });
    await fill(other.siteId, 10, { createdAt: today - 1, ipHash });
    await fill(site.siteId, PER_SITE - 1, { createdAt: today, ipHash });
    expect((await post(site, "192.0.2.40")).status).toBe(303);
    expect((await post(site, "192.0.2.40")).status).toBe(429);
  });

  // Worker-level posts cannot be made to interleave (local requests run one at a time), so a version that
  // counted first and inserted later would pass the tests above. Here the order is fixed: a lead that
  // started before the network's last allowed lead but is written after it must be refused.
  it.each([
    ["on one site", PER_SITE - 1, true],
    ["across all sites", ALL_SITES - 1, false],
  ])("decides when the lead is written, in the same statement: %s", async (_, earlier, sameSite) => {
    const site = await seedSite(tools);
    const elsewhere = await seedSite(tools);
    const ipHash = `race-${newId()}`;
    const now = Date.now();
    for (let i = 0; i < earlier; i++) await fill(sameSite ? site.siteId : (await seedSite(tools)).siteId, 1, { createdAt: dayStart(now), ipHash });
    const target = sameSite ? site : elsewhere;

    const production = writesReturnNoRows(tools.DB);
    const held = holdBatch(production);
    const late = insertLead(held.db, input(site, ipHash, { now }));
    await Promise.race([held.reached, late]);
    expect(await insertLead(production, input(target, ipHash, { now }))).toBe("pending");
    held.release();
    expect(await late).toBe("network_daily_limit");
    expect(await leadsOf(site.siteId)).toHaveLength(sameSite ? PER_SITE : 0);
  });

  it("learns which limit refused a lead from a SELECT in the same batch (production D1 returns no rows for the INSERT)", async () => {
    const production = writesReturnNoRows(tools.DB);
    const today = dayStart(Date.now());
    const open = await seedSite(tools);
    const full = await seedSite(tools);
    for (let i = 0; i < LIMITS.leadsPerSitePerDay; i++) await fill(full.siteId, 1, { createdAt: today, ipHash: newId() });
    const busySite = `busy-${newId()}`;
    await fill(open.siteId, PER_SITE, { createdAt: today, ipHash: busySite });
    const busyEverywhere = `busy-${newId()}`;
    for (let i = 0; i < ALL_SITES; i++) await fill((await seedSite(tools)).siteId, 1, { createdAt: today, ipHash: busyEverywhere });
    // Within both of its limits here: 3 leads today on other sites, none on the full site.
    const busyElsewhere = `busy-${newId()}`;
    for (let i = 0; i < PER_SITE; i++) await fill((await seedSite(tools)).siteId, 1, { createdAt: today, ipHash: busyElsewhere });

    expect({
      siteFull: await insertLead(production, input(full, newId())),
      siteFullNetworkUsedElsewhere: await insertLead(production, input(full, busyElsewhere)),
      networkAtSiteLimit: await insertLead(production, input(open, busySite)),
      networkAtAllSitesLimit: await insertLead(production, input(open, busyEverywhere)),
      networkAtLimitOnFullSite: await insertLead(production, input(full, busyEverywhere)),
      fresh: await insertLead(production, input(open, newId())),
    }).toEqual({
      siteFull: "site_daily_cap",
      siteFullNetworkUsedElsewhere: "site_daily_cap",
      networkAtSiteLimit: "network_daily_limit",
      networkAtAllSitesLimit: "network_daily_limit",
      networkAtLimitOnFullSite: "network_daily_limit",
      fresh: "pending",
    });
    expect(await leadsOf(full.siteId)).toHaveLength(LIMITS.leadsPerSitePerDay);
    expect(await leadsOf(open.siteId)).toHaveLength(PER_SITE + 1);
  });

  // D1 bills every row a statement scans. A refused post is held back only by the rate limit (5 a minute
  // per site and network), so its counts must read only the site's rows for today (at most
  // LIMITS.leadsPerSitePerDay, through leads_site) and the network's rows for today (a few, through
  // leads_network), never the whole table or the whole day.
  it("reads only the site's and the network's rows for today for a post a network limit refuses, however many leads the table holds", async () => {
    const now = Date.now();
    const today = dayStart(now);
    const SITES = 40;
    const x = `net-${newId()}`;
    const tag = newId();
    // 40 sites at the day's cap (2,000 leads today from 2,000 other networks), and 2,000 earlier-day
    // leads from network x: either set alone is too many rows for a bounded count to read.
    await tools.DB.batch([
      tools.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
         INSERT INTO owners (id, email, created_at) SELECT ?2 || '-o' || i, ?2 || '-' || i || '@example.com', 1 FROM n`,
      ).bind(SITES, tag),
      tools.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
         INSERT INTO sites (id, owner_id, created_at, updated_at) SELECT ?2 || '-s' || i, ?2 || '-o' || i, 1, 1 FROM n`,
      ).bind(SITES, tag),
      tools.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
         INSERT INTO leads (id, site_id, created_at, name, phone, spam, email_status, ip_hash)
         SELECT ?2 || '-t' || i, ?2 || '-s' || CAST((i + ?3 - 1) / ?3 AS INTEGER), ?4, 'n', '5125550100', 0, 'sent', ?2 || '-n' || i FROM n`,
      ).bind(SITES * LIMITS.leadsPerSitePerDay, tag, LIMITS.leadsPerSitePerDay, today),
      tools.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
         INSERT INTO leads (id, site_id, created_at, name, phone, spam, email_status, ip_hash)
         SELECT ?2 || '-h' || i, ?2 || '-s1', ?3, 'n', '5125550100', 0, 'sent', ?4 FROM n`,
      ).bind(SITES * LIMITS.leadsPerSitePerDay, tag, today - DAY_MS, x),
    ]);
    const [scan] = await tools.DB.batch([tools.DB.prepare("SELECT COUNT(*) AS n FROM leads")]);
    expect(scan?.meta.rows_read).toBeGreaterThanOrEqual(2 * SITES * LIMITS.leadsPerSitePerDay);

    const open = await seedSite(tools);
    const fullSite = { siteId: `${tag}-s1` };
    const y = `net-${newId()}`;
    await fill(open.siteId, PER_SITE, { createdAt: today, ipHash: y });
    for (let i = 0; i < ALL_SITES; i++) await fill((await seedSite(tools)).siteId, 1, { createdAt: today, ipHash: x });

    const counted = async (site: { siteId: string }, ipHash: string, spam: boolean) => {
      const meter = metered(tools.DB);
      const status = await insertLead(meter.db, input(site, ipHash, { now, spam }));
      return { status, rows: meter.rowsRead() };
    };
    const posts = {
      allSitesLimit: await counted(open, x, false),
      allSitesLimitSpam: await counted(open, x, true),
      siteLimit: await counted(open, y, false),
      allSitesLimitOnFullSite: await counted(fullSite, x, false),
      freshNetworkOnFullSite: await counted(fullSite, newId(), false),
    };
    expect(Object.fromEntries(Object.entries(posts).map(([kind, post]) => [kind, post.status]))).toEqual({
      allSitesLimit: "network_daily_limit",
      allSitesLimitSpam: "network_daily_limit",
      siteLimit: "network_daily_limit",
      allSitesLimitOnFullSite: "network_daily_limit",
      freshNetworkOnFullSite: "site_daily_cap",
    });
    // The site's rows once, the network's rows for each count in the insert and the read-back, and a few more.
    const bound = LIMITS.leadsPerSitePerDay + 4 * ALL_SITES + 10;
    const tooMany = Object.entries(posts).filter(([, post]) => post.rows > bound);
    expect(tooMany.map(([kind, post]) => `${kind} read ${post.rows} rows`)).toEqual([]);
  });
});
