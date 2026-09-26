import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EMPTY_EDITS, versionKey } from "@asksite/core";
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
});
