import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EMPTY_EDITS, LIMITS, newId, versionKey, versionPageKey } from "@asksite/core";
import { approveVersion, createPendingVersion, restore, takeDown } from "@asksite/publishing";
import { PAGE_IDS, PAGES, SiteDocument } from "@asksite/site-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteOldLeads } from "../src/cron.ts";
import { at, ROOT, seedSite, settledLeads, sitesHarness, type ToolsEnv } from "./support/harness.ts";

// Plan 2 end to end: publish (as the app Worker will), approve (as the admin Worker will), then the
// public Worker serves those exact bytes, every page of the site, and accepts the contact form of its Contact page (A16).
const harness = sitesHarness();
let tools: ToolsEnv;
beforeAll(async () => {
  ({ tools } = await harness.start());
}, 120_000);
afterAll(async () => {
  await harness.server.close();
});

const fixture = (name: string) =>
  SiteDocument.parse(JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../fixtures", `${name}.json`), "utf8")));

async function publishAndApprove(fixtureName: string) {
  const site = await seedSite(tools, { live: false });
  const env = { ...tools, ROOT_DOMAIN: ROOT };
  const version = await createPendingVersion(env, { siteId: site.siteId, ownerId: site.ownerId, slug: site.slug, document: fixture(fixtureName), edits: EMPTY_EDITS, generationId: null, now: Date.now() });
  const sha = await tools.DB.prepare("SELECT html_sha256 FROM site_versions WHERE id = ?").bind(version.id).first<{ html_sha256: string }>();
  await approveVersion(env, { versionId: version.id, htmlSha256: String(sha?.html_sha256), reviewer: "admin@example.com", note: null, indexable: true, now: Date.now() });
  return { ...site, versionId: version.id };
}

describe("publish, approve, serve, contact", () => {
  it("serves exactly the approved bytes of every page, and accepts the Contact page's own form", async () => {
    const site = await publishAndApprove("plumber-austin");
    for (const page of PAGE_IDS) {
      const response = await harness.server.fetch(at(site.slug, PAGES[page].path));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(await (await tools.WORK.get(versionPageKey(site.siteId, site.versionId, page)))?.text());
    }
    const home = await (await harness.server.fetch(at(site.slug))).text();
    expect(home).toBe(await (await tools.WORK.get(versionKey(site.siteId, site.versionId)))?.text());
    expect(home).not.toContain("<form"); // the form is on /contact only

    const html = await (await harness.server.fetch(at(site.slug, "/contact"))).text();
    const action = /<form id="quote" action="([^"]+)" method="post">/.exec(html)?.[1];
    expect(action).toBe(`https://${site.slug}.${ROOT}/_f/${site.siteId}`);
    const response = await harness.server.fetch(String(action), {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "198.51.100.99" },
      body: new URLSearchParams({ name: "Pat", phone: "512-555-0123", email: "", service: "Drain cleaning", message: "", website: "" }).toString(),
    });
    expect(response.status).toBe(303);
    const [lead] = await settledLeads(tools, site.siteId);
    expect(lead).toMatchObject({ name: "Pat", service: "Drain cleaning", email_status: "sent" });
  });

  // A15: approveVersion stores the business phone with the LIVE pointer, and the form's "Please call instead"
  // page prints it: the same number and text the approved page already shows.
  it("prints the approved page's own phone link when the form is closed for the day", async () => {
    const site = await publishAndApprove("plumber-austin");
    const html = await (await harness.server.fetch(at(site.slug))).text();
    expect(html).toContain('href="tel:+15125550142"');
    expect(html).toContain("Call (512) 555-0142");
    const now = Date.now();
    await tools.DB.batch(
      Array.from({ length: LIMITS.leadsPerSitePerDay }, () =>
        tools.DB.prepare("INSERT INTO leads (id, site_id, created_at, name, phone, email_status, ip_hash) VALUES (?, ?, ?, 'n', '5125550100', 'sent', ?)").bind(newId(), site.siteId, now, newId()),
      ),
    );
    const response = await harness.server.fetch(at(site.slug, `/_f/${site.siteId}`), {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "198.51.100.98" },
      body: new URLSearchParams({ name: "Pat", phone: "512-555-0123", email: "", service: "", message: "", website: "" }).toString(),
    });
    expect(response.status).toBe(429);
    expect(await response.text()).toContain('<p><a href="tel:+15125550142">Call (512) 555-0142</a></p>');
  });

  // QA-2 RU(2), RU(3): approveVersion stores the business name with the LIVE pointer, so the thank-you page
  // names the business and a wrong path links to its page. A takedown removes both; a restore brings them back.
  it("names the approved page's business on the thank-you and 404 pages until a takedown, and again after a restore", async () => {
    const site = await publishAndApprove("plumber-austin");
    const pages = async () => ({
      sent: await (await harness.server.fetch(at(site.slug, `/_f/${site.siteId}/sent`))).text(),
      missing: await (await harness.server.fetch(at(site.slug, "/old-page"))).text(),
    });
    const live = await pages();
    expect(live.sent).toContain('<h1>Thanks! Your message was sent to Reliable Rooter Plumbing.</h1>\n<p>They will get back to you soon.</p>\n<p><a href="/">Back to Reliable Rooter Plumbing</a></p>');
    expect(live.missing).toContain('<p><a href="/">Go to Reliable Rooter Plumbing\'s page</a></p>');

    const downAt = Date.now();
    await takeDown(tools, { siteId: site.siteId, reviewer: "admin@example.com", reason: "Test", purgeMedia: false, now: downAt });
    const down = await pages();
    expect(down.sent).toContain("<h1>Thanks! Your message was sent.</h1>");
    expect(down.missing).not.toContain("<a ");

    await restore({ ...tools, ROOT_DOMAIN: ROOT }, { siteId: site.siteId, reviewer: "admin@example.com", expectedTakenDownAt: downAt, now: Date.now() });
    expect(await pages()).toEqual(live);
  });

  it("escapes the XSS fixture's business name on the thank-you and 404 pages", async () => {
    const site = await publishAndApprove("electrical-xss");
    const sent = await (await harness.server.fetch(at(site.slug, `/_f/${site.siteId}/sent`))).text();
    const missing = await (await harness.server.fetch(at(site.slug, "/old-page"))).text();
    expect(sent).toContain("<h1>Thanks! Your message was sent to &lt;img src=x onerror=alert(1)&gt;.</h1>");
    expect(missing).toContain("Go to &lt;img src=x onerror=alert(1)&gt;'s page");
    for (const body of [sent, missing]) expect(body).not.toContain("<img");
  });

  // A16 + U2: the pointer names the live version, so a takedown (which deletes it first) stops every page at once,
  // the ones already in the data centre's cache included; a restore writes it back.
  it.each([
    ["plumber-austin", [200, 200, 200, 200, 200]],
    ["cleaning-minimal", [200, 200, 404, 404, 200]], // no about text and no photos: no About and no Gallery page
  ] as const)("%s: a takedown makes every page answer 404, even a cached one; restore brings the site back", async (name, live) => {
    const site = await publishAndApprove(name);
    const answers = async () => Promise.all(PAGE_IDS.map(async (page) => (await harness.server.fetch(at(site.slug, PAGES[page].path))).status));
    expect(await answers()).toEqual(live); // every page is now cached
    expect(await answers()).toEqual(live);

    const downAt = Date.now();
    await takeDown(tools, { siteId: site.siteId, reviewer: "admin@example.com", reason: "Test", purgeMedia: false, now: downAt });
    expect(await answers()).toEqual([404, 404, 404, 404, 404]);
    expect((await tools.LIVE.list({ prefix: site.slug })).objects.map((o) => o.key)).toEqual([]);

    await restore({ ...tools, ROOT_DOMAIN: ROOT }, { siteId: site.siteId, reviewer: "admin@example.com", expectedTakenDownAt: downAt, now: Date.now() });
    expect(await answers()).toEqual(live);
    expect(await (await harness.server.fetch(at(site.slug))).text()).toBe(await (await tools.WORK.get(versionKey(site.siteId, site.versionId)))?.text());
  });
});

describe("daily cron", () => {
  it("deletes leads older than 180 days and keeps newer ones", async () => {
    const site = await seedSite(tools);
    const now = Date.parse("2026-09-24T07:00:00.000Z");
    const day = 86_400_000;
    const insert = (id: string, createdAt: number) =>
      tools.DB.prepare("INSERT INTO leads (id, site_id, created_at, name, phone, email_status, ip_hash) VALUES (?, ?, ?, 'n', 'p', 'sent', 'h')").bind(id, site.siteId, createdAt);
    await tools.DB.batch([
      insert("aaaaaaaa-0000-4000-8000-000000000001", now - 181 * day),
      insert("aaaaaaaa-0000-4000-8000-000000000002", now - 180 * day),
      insert("aaaaaaaa-0000-4000-8000-000000000003", now - 1 * day),
    ]);
    const result = await harness.server.getWorker("asksite-sites").scheduled({ cron: "0 7 * * *", scheduledTime: new Date(now) });
    expect(result.outcome).toBe("ok");
    const { results } = await tools.DB.prepare("SELECT id FROM leads WHERE site_id = ? ORDER BY created_at").bind(site.siteId).all<{ id: string }>();
    expect(results.map((r) => r.id)).toEqual(["aaaaaaaa-0000-4000-8000-000000000002", "aaaaaaaa-0000-4000-8000-000000000003"]);
  });

  // The 180 days apply to every lead the form stores (form.ts), not only emailed ones; only spam-flagged leads,
  // which owners never see (D6), go sooner, after 30 days. A cron that kept spam would break the privacy promise unnoticed.
  it("deletes old leads of every kind (spam, pending, sent, failed) and keeps recent ones of every kind", async () => {
    const site = await seedSite(tools);
    const now = Date.parse("2026-09-24T07:00:00.000Z");
    const day = 86_400_000;
    const kinds = [
      { spam: 1, email_status: "skipped", email_error: null },
      { spam: 0, email_status: "pending", email_error: null },
      { spam: 0, email_status: "sent", email_error: null },
      { spam: 0, email_status: "failed", email_error: null },
      { spam: 0, email_status: "failed", email_error: "daily_cap" },
    ];
    const old = kinds.map((kind) => ({ id: newId(), ...kind, createdAt: now - 181 * day }));
    const recent = kinds.map((kind) => ({ id: newId(), ...kind, createdAt: now - 1 * day }));
    await tools.DB.batch(
      [...old, ...recent].map((lead) =>
        tools.DB.prepare("INSERT INTO leads (id, site_id, created_at, name, phone, spam, email_status, email_error, ip_hash) VALUES (?, ?, ?, 'n', 'p', ?, ?, ?, 'h')").bind(lead.id, site.siteId, lead.createdAt, lead.spam, lead.email_status, lead.email_error),
      ),
    );
    const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const rows = (leads: typeof old) => leads.map(({ id, spam, email_status }) => ({ id, spam, email_status })).sort(byId);
    const stored = async () =>
      (await tools.DB.prepare("SELECT id, spam, email_status FROM leads WHERE site_id = ?").bind(site.siteId).all<{ id: string; spam: number; email_status: string }>()).results.sort(byId);
    expect(await stored()).toEqual(rows([...old, ...recent]));

    const result = await harness.server.getWorker("asksite-sites").scheduled({ cron: "0 7 * * *", scheduledTime: new Date(now) });
    expect(result.outcome).toBe("ok");
    expect(await stored()).toEqual(rows(recent));
  });

  // Spam-flagged leads (spam = 1) go after 30 days; EVERY other lead keeps the full 180, the daily_cap ones
  // included (real leads whose email was held back). The shorter rule must never reach a spam = 0 row.
  describe("spam retention (30 days, spam = 1 only)", () => {
    const day = 86_400_000;
    const now = Date.parse("2026-09-24T07:00:00.000Z");
    const kinds = [
      { name: "spam", spam: 1, email_status: "skipped", email_error: null },
      { name: "pending", spam: 0, email_status: "pending", email_error: null },
      { name: "sent", spam: 0, email_status: "sent", email_error: null },
      { name: "failed", spam: 0, email_status: "failed", email_error: null },
      { name: "daily_cap", spam: 0, email_status: "failed", email_error: "daily_cap" },
    ];
    // Seeds one lead of every kind at `age` (ms) and returns the names of the kinds still stored after the cron ran.
    const survivors = async (age: number): Promise<string[]> => {
      const site = await seedSite(tools);
      const leads = kinds.map((kind) => ({ ...kind, id: newId() }));
      await tools.DB.batch(
        leads.map((lead) =>
          tools.DB.prepare("INSERT INTO leads (id, site_id, created_at, name, phone, spam, email_status, email_error, ip_hash) VALUES (?, ?, ?, 'n', 'p', ?, ?, ?, 'h')").bind(
            lead.id, site.siteId, now - age, lead.spam, lead.email_status, lead.email_error,
          ),
        ),
      );
      const result = await harness.server.getWorker("asksite-sites").scheduled({ cron: "0 7 * * *", scheduledTime: new Date(now) });
      expect(result.outcome).toBe("ok");
      const kept = new Set((await tools.DB.prepare("SELECT id FROM leads WHERE site_id = ?").bind(site.siteId).all<{ id: string }>()).results.map((r) => r.id));
      return leads.filter((lead) => kept.has(lead.id)).map((lead) => lead.name);
    };
    const all = kinds.map((k) => k.name);
    const real = all.filter((n) => n !== "spam");

    it("at 31 days deletes only the spam lead: a normal, pending, failed and daily_cap lead are kept", async () => {
      expect(await survivors(31 * day)).toEqual(real);
    });
    it("at 29 days deletes nothing", async () => {
      expect(await survivors(29 * day)).toEqual(all);
    });
    it("at exactly 30 days keeps the spam lead (a lead is deleted only when older than the cutoff, as at 180 days)", async () => {
      expect(await survivors(30 * day)).toEqual(all);
    });
    it("one millisecond past 30 days deletes the spam lead", async () => {
      expect(await survivors(30 * day + 1)).toEqual(real);
    });
    it("at 179 days still keeps every non-spam lead", async () => {
      expect(await survivors(179 * day)).toEqual(real);
    });
    it("at exactly 180 days keeps every non-spam lead", async () => {
      expect(await survivors(180 * day)).toEqual(real);
    });
    it("at 181 days deletes every kind", async () => {
      expect(await survivors(181 * day)).toEqual([]);
    });

    // `expired` counts every lead over 180 days (spam included, the 180-day rule runs first); `spam` counts the spam leads
    // aged 30 to 180 days. Same `now` as above, so the rows the other tests left (never past a cutoff at this `now`) stay out.
    it("returns the exact count per rule on the real D1, and the database size", async () => {
      const site = await seedSite(tools);
      const seeds = [
        [200, 1, null], [200, 0, null], [200, 0, "daily_cap"], // over 180 days: all three counted as expired
        [31, 1, null], [31, 1, null], [31, 0, null], [31, 0, "daily_cap"], // spam over 30 days: 2 counted as spam; the others stay
      ] as const;
      await tools.DB.batch(
        seeds.map(([age, spam, error]) =>
          tools.DB.prepare("INSERT INTO leads (id, site_id, created_at, name, phone, spam, email_status, email_error, ip_hash) VALUES (?, ?, ?, 'n', 'p', ?, 'failed', ?, 'h')").bind(
            newId(), site.siteId, now - age * day, spam, error,
          ),
        ),
      );
      const result = await deleteOldLeads(tools.DB, now);
      expect({ spam: result.spam, expired: result.expired, deleted: result.deleted }).toEqual({ spam: 2, expired: 3, deleted: 5 });
      expect(typeof result.sizeAfter).toBe("number");
      expect((await tools.DB.prepare("SELECT COUNT(*) AS n FROM leads WHERE site_id = ?").bind(site.siteId).first<{ n: number }>())?.n).toBe(2);
    });
  });
});
