import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EMPTY_EDITS, LIMITS, newId, versionKey } from "@asksite/core";
import { approveVersion, createPendingVersion, restore, takeDown } from "@asksite/publishing";
import { SiteDocument } from "@asksite/site-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { at, ROOT, seedSite, settledLeads, sitesHarness, type ToolsEnv } from "./support/harness.ts";

// Plan 2 end to end: publish (as the app Worker will), approve (as the admin Worker will), then the
// public Worker serves those exact bytes and accepts the page's own contact form.
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
  it("serves exactly the approved bytes and accepts the page's own form", async () => {
    const site = await publishAndApprove("plumber-austin");
    const page = await harness.server.fetch(at(site.slug));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toBe(await (await tools.WORK.get(versionKey(site.siteId, site.versionId)))?.text());

    const action = /<form action="([^"]+)" method="post">/.exec(html)?.[1];
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

  // A15: approveVersion stores the business phone with the LIVE object, and the form's "Please call instead"
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

  // QA-2 RU(2), RU(3): approveVersion stores the business name with the LIVE object, so the thank-you page
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

    await takeDown(tools, { siteId: site.siteId, reviewer: "admin@example.com", reason: "Test", purgeMedia: false, now: Date.now() });
    const down = await pages();
    expect(down.sent).toContain("<h1>Thanks! Your message was sent.</h1>");
    expect(down.missing).not.toContain("<a ");

    await restore({ ...tools, ROOT_DOMAIN: ROOT }, { siteId: site.siteId, reviewer: "admin@example.com", now: Date.now() });
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

  it("a takedown stops a page that no data centre has cached; restore brings it back", async () => {
    const site = await publishAndApprove("cleaning-minimal");
    await takeDown(tools, { siteId: site.siteId, reviewer: "admin@example.com", reason: "Test", purgeMedia: false, now: Date.now() });
    expect((await harness.server.fetch(at(site.slug))).status).toBe(404);
    await restore({ ...tools, ROOT_DOMAIN: ROOT }, { siteId: site.siteId, reviewer: "admin@example.com", now: Date.now() });
    expect((await harness.server.fetch(at(site.slug))).status).toBe(200);
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

  // The 180 days apply to every lead the form stores (form.ts), not only emailed ones. Owners never see
  // spam-flagged leads (D6), so a cron that kept them would break the privacy promise unnoticed.
  it("deletes old leads of every kind (spam, pending, sent, failed) and keeps recent ones of every kind", async () => {
    const site = await seedSite(tools);
    const now = Date.parse("2026-09-24T07:00:00.000Z");
    const day = 86_400_000;
    const kinds = [
      { spam: 1, email_status: "skipped" },
      { spam: 0, email_status: "pending" },
      { spam: 0, email_status: "sent" },
      { spam: 0, email_status: "failed" },
    ];
    const old = kinds.map((kind) => ({ id: newId(), ...kind, createdAt: now - 181 * day }));
    const recent = kinds.map((kind) => ({ id: newId(), ...kind, createdAt: now - 1 * day }));
    await tools.DB.batch(
      [...old, ...recent].map((lead) =>
        tools.DB.prepare("INSERT INTO leads (id, site_id, created_at, name, phone, spam, email_status, ip_hash) VALUES (?, ?, ?, 'n', 'p', ?, ?, 'h')").bind(lead.id, site.siteId, lead.createdAt, lead.spam, lead.email_status),
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
});
