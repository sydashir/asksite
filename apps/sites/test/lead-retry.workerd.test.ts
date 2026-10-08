import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { newId, utcDayStart } from "@asksite/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { RETRY_CRON } from "../src/cron.ts";
import { RETRY_PER_RUN } from "../src/lead-retry.ts";
import { at, linesWith, seedSite, settledLeads, sitesHarness, type ToolsEnv } from "./support/harness.ts";

// C1 (go-live blocker): a lead whose email failed during a Resend outage is emailed again by the sites
// Worker's */15 cron, within 23 h, with the first send's idempotency key and byte-identical body. The real
// Resend mailer runs inside workerd; this Node process answers for api.resend.com and fails on any other
// host, so nothing ever leaves the machine.
const harness = sitesHarness({ vars: { MAILER: "resend", MAIL_FROM: "asksite <leads@mail.asksite.example>" }, secrets: { RESEND_API_KEY: "re_test_not_a_real_key" } });
let tools: ToolsEnv;
const realFetch = globalThis.fetch;
/** Every request the Worker sent to Resend, with its raw body text (byte equality is the point). */
const outbound: Array<{ key: string | null; body: string }> = [];
let resendStatus = 200;
/** A Resend request the test holds unanswered, by idempotency key, until it calls release(). */
let held: { key: string; release: () => void; released: Promise<void> } | null = null;

beforeAll(async () => {
  ({ tools } = await harness.start());
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).host !== "api.resend.com") throw new Error(`Unexpected outbound request to ${request.url}`);
    const key = request.headers.get("idempotency-key");
    outbound.push({ key, body: await request.text() });
    if (held !== null && key === held.key) await held.released;
    return Response.json(resendStatus === 200 ? { id: "email-id-1" } : { message: "outage" }, { status: resendStatus });
  }) as typeof fetch;
}, 120_000);
afterEach(async () => {
  held?.release();
  held = null;
  outbound.length = 0;
  resendStatus = 200;
  await tools.DB.prepare("DELETE FROM leads").run();
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  await harness.server.close();
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** The run's scheduled time for tests that seed their leads (the form is not used, so any time works). */
const NOW = Date.parse("2026-10-08T12:00:00.000Z");

const runRetry = (now: number) => harness.server.getWorker("asksite-sites").scheduled({ cron: RETRY_CRON, scheduledTime: new Date(now) });

const post = (site: { slug: string; siteId: string }, fields: Record<string, string>, ip = "198.51.100.61") =>
  harness.server.fetch(at(site.slug, `/_f/${site.siteId}`), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip },
    body: new URLSearchParams(fields).toString(),
  });

/** A lead stored as the form stores one, in any email state. */
async function seedLead(siteId: string, row: { createdAt: number; status: string; error?: string | null; spam?: 0 | 1; id?: string }): Promise<string> {
  const id = row.id ?? newId();
  await tools.DB.prepare(
    `INSERT INTO leads (id, site_id, created_at, name, phone, email, service, message, spam, email_status, email_error, ip_hash)
     VALUES (?, ?, ?, 'Pat Lee', '512 555 0100', 'pat@example.com', NULL, 'Call after five', ?, ?, ?, 'seeded')`,
  ).bind(id, siteId, row.createdAt, row.spam ?? 0, row.status, row.error ?? null).run();
  return id;
}

const stateOf = async (id: string) => tools.DB.prepare("SELECT email_status, email_error FROM leads WHERE id = ?").bind(id).first();
const sentKeys = () => outbound.map((call) => call.key);

function hold(key: string): void {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  held = { key, release, released };
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400 && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 25));
  if (!check()) throw new Error(`gave up waiting: ${what}`);
}

describe("a lead whose email failed in an outage", () => {
  it("is emailed by the next */15 run with the first send's key and byte-identical body, and becomes sent", async () => {
    const site = await seedSite(tools);
    resendStatus = 500;
    expect((await post(site, { name: "Dana Price", phone: "512 555 0199", email: "dana@example.com", service: "", message: "Leak under the sink\nsince Monday", website: "" })).status).toBe(303);
    const [lead] = await settledLeads(tools, site.siteId);
    expect(lead).toMatchObject({ email_status: "failed", email_error: "unavailable" });
    expect(outbound).toHaveLength(1);

    resendStatus = 200;
    const result = await runRetry(Date.now() + 15 * MINUTE);
    expect(result.outcome).toBe("ok");
    expect(outbound).toHaveLength(2);
    expect(outbound[1]?.key).toBe(`lead:${String(lead?.["id"])}`);
    expect(outbound[1]).toEqual(outbound[0]);
    expect(await stateOf(String(lead?.["id"]))).toEqual({ email_status: "sent", email_error: null });
  });
});

describe("which leads a run sends", () => {
  it("retries failed leads whose error was unavailable or rate_limited", async () => {
    const site = await seedSite(tools);
    const unavailable = await seedLead(site.siteId, { createdAt: NOW - 2 * HOUR, status: "failed", error: "unavailable" });
    const rateLimited = await seedLead(site.siteId, { createdAt: NOW - HOUR, status: "failed", error: "rate_limited" });
    await runRetry(NOW);
    expect(sentKeys()).toEqual([`lead:${unavailable}`, `lead:${rateLimited}`]);
    expect(await stateOf(unavailable)).toEqual({ email_status: "sent", email_error: null });
    expect(await stateOf(rateLimited)).toEqual({ email_status: "sent", email_error: null });
  });

  // A refusal (rejected), a broken setup (misconfigured), an unknown error (internal) and the daily cap are not
  // outages: sending again would fail the same way, or break the cap. Spam is never emailed; sent is done.
  it("never retries rejected, misconfigured, internal or daily_cap leads, spam, or sent ones", async () => {
    const site = await seedSite(tools);
    const rows = [
      { status: "failed", error: "rejected" },
      { status: "failed", error: "misconfigured" },
      { status: "failed", error: "internal" },
      { status: "failed", error: "daily_cap" },
      { status: "skipped", error: null, spam: 1 as const },
      { status: "failed", error: "unavailable", spam: 1 as const },
      { status: "sent", error: null },
    ];
    const ids: string[] = [];
    for (const row of rows) ids.push(await seedLead(site.siteId, { createdAt: NOW - HOUR, ...row }));
    const result = await runRetry(NOW);
    expect(result.outcome).toBe("ok");
    expect(outbound).toEqual([]);
    for (const [i, row] of rows.entries()) expect(await stateOf(String(ids[i]))).toEqual({ email_status: row.status, email_error: row.error });
  });

  // Resend keeps an idempotency key for 24 hours, so a retry inside 23 h can never send the lead twice.
  it("retries a lead created exactly 23 h before the run, and never an older one", async () => {
    const site = await seedSite(tools);
    const edge = await seedLead(site.siteId, { createdAt: NOW - 23 * HOUR, status: "failed", error: "unavailable" });
    const older = await seedLead(site.siteId, { createdAt: NOW - 23 * HOUR - 1, status: "failed", error: "unavailable" });
    await runRetry(NOW);
    expect(sentKeys()).toEqual([`lead:${edge}`]);
    expect(await stateOf(older)).toEqual({ email_status: "failed", email_error: "unavailable" });
  });

  // 'pending' with no error is a lead whose first send (after the 303) died or could not record its result. Its send
  // times out after 10 s, so after 10 minutes it is over; a younger one may still be on its way.
  it("retries a pending lead only once it is more than 10 minutes old", async () => {
    const site = await seedSite(tools);
    const stale = await seedLead(site.siteId, { createdAt: NOW - 10 * MINUTE - 1, status: "pending" });
    const edge = await seedLead(site.siteId, { createdAt: NOW - 10 * MINUTE, status: "pending" });
    const fresh = await seedLead(site.siteId, { createdAt: NOW - MINUTE, status: "pending" });
    await runRetry(NOW);
    expect(sentKeys()).toEqual([`lead:${stale}`]);
    expect(await stateOf(stale)).toEqual({ email_status: "sent", email_error: null });
    expect(await stateOf(edge)).toEqual({ email_status: "pending", email_error: null });
    expect(await stateOf(fresh)).toEqual({ email_status: "pending", email_error: null });
  });

  // A run claims a lead before it sends ('retrying:<its scheduled time>'). A claim more than 20 minutes old belongs
  // to a run that is over (a cron run is stopped after 15 minutes), so its lead is sent again; a younger one may
  // still be sending. RULING 2 (2026-10-08): the lead's age says nothing about when it was claimed.
  it("retries a claimed lead only when its claim is more than 20 minutes old", async () => {
    const site = await seedSite(tools);
    const dead = await seedLead(site.siteId, { createdAt: NOW - 2 * HOUR, status: "pending", error: `retrying:${NOW - 21 * MINUTE}` });
    const edge = await seedLead(site.siteId, { createdAt: NOW - 2 * HOUR + 1, status: "pending", error: `retrying:${NOW - 20 * MINUTE}` });
    const live = await seedLead(site.siteId, { createdAt: NOW - 2 * HOUR + 2, status: "pending", error: `retrying:${NOW - 19 * MINUTE}` });
    await runRetry(NOW);
    expect(sentKeys()).toEqual([`lead:${dead}`]);
    expect(await stateOf(dead)).toEqual({ email_status: "sent", email_error: null });
    expect(await stateOf(edge)).toEqual({ email_status: "pending", email_error: `retrying:${NOW - 20 * MINUTE}` });
    expect(await stateOf(live)).toEqual({ email_status: "pending", email_error: `retrying:${NOW - 19 * MINUTE}` });
  });

  // C1 ruling 2: the lead was accepted while the site was live, and the owner still sees it in the app.
  it("retries the leads of a taken-down site and of a disabled owner", async () => {
    const down = await seedSite(tools, { takenDown: true });
    const disabled = await seedSite(tools);
    await tools.DB.prepare("UPDATE owners SET disabled_at = ? WHERE id = ?").bind(NOW - HOUR, disabled.ownerId).run();
    const a = await seedLead(down.siteId, { createdAt: NOW - 3 * HOUR, status: "failed", error: "unavailable" });
    const b = await seedLead(disabled.siteId, { createdAt: NOW - 2 * HOUR, status: "failed", error: "unavailable" });
    await runRetry(NOW);
    expect(sentKeys()).toEqual([`lead:${a}`, `lead:${b}`]);
  });

  it("never reads a lead whose site has no address", async () => {
    const site = await seedSite(tools);
    const lead = await seedLead(site.siteId, { createdAt: NOW - HOUR, status: "failed", error: "unavailable" });
    await tools.DB.prepare("UPDATE sites SET slug = NULL WHERE id = ?").bind(site.siteId).run();
    const result = await runRetry(NOW);
    expect(result.outcome).toBe("ok");
    expect(outbound).toEqual([]);
    expect(await stateOf(lead)).toEqual({ email_status: "failed", email_error: "unavailable" });
  });

  // No case for a lead whose site or owner row is gone: D1 always enforces foreign keys ("user queries cannot change
  // this", developers.cloudflare.com/d1/sql-api/foreign-keys/), so such a lead cannot exist; deletion removes leads first.

  // Owner deletion can delete a lead and its site at any moment, also while a run is working through it.
  it("skips a lead deleted after the run read it, and goes on when one is deleted during its send", async () => {
    const [a, b, c] = [await seedSite(tools), await seedSite(tools), await seedSite(tools)];
    const first = await seedLead(a.siteId, { createdAt: NOW - 3 * HOUR, status: "failed", error: "unavailable" });
    const second = await seedLead(b.siteId, { createdAt: NOW - 2 * HOUR, status: "failed", error: "unavailable" });
    const third = await seedLead(c.siteId, { createdAt: NOW - HOUR, status: "failed", error: "unavailable" });
    hold(`lead:${first}`);
    harness.server.clearLogs();
    const run = runRetry(NOW);
    await until(() => sentKeys().includes(`lead:${first}`), "the run sending the first lead");
    await tools.DB.batch([
      tools.DB.prepare("DELETE FROM leads WHERE id IN (?, ?)").bind(first, second),
      tools.DB.prepare("DELETE FROM sites WHERE id IN (?, ?)").bind(a.siteId, b.siteId),
    ]);
    held?.release();
    expect((await run).outcome).toBe("ok");
    expect(sentKeys()).toEqual([`lead:${first}`, `lead:${third}`]);
    const [line] = await linesWith(harness, "route", "cron_lead_email_retry", 1);
    expect(line).toMatchObject({ read: 3, claimed: 2, sent: 2, failed: 0, stopped: false });
    expect(await stateOf(first)).toBeNull();
    expect(await stateOf(second)).toBeNull();
    expect(await stateOf(third)).toEqual({ email_status: "sent", email_error: null });
  });
});

describe("one run", () => {
  it(`sends at most ${RETRY_PER_RUN}, oldest first (ties by id), and leaves the rest for the next run`, async () => {
    const site = await seedSite(tools);
    const rows = Array.from({ length: RETRY_PER_RUN + 2 }, (_, i) => ({ id: newId(), createdAt: NOW - 5 * HOUR + Math.floor(i / 2) * MINUTE }));
    // Inserted newest first, so neither insert order nor rowid can pass for the oldest-first order.
    for (const row of [...rows].reverse()) await seedLead(site.siteId, { ...row, status: "failed", error: "unavailable" });
    const order = [...rows].sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : 1)).map((row) => row.id);
    expect(RETRY_PER_RUN).toBe(10);
    await runRetry(NOW);
    expect(sentKeys()).toEqual(order.slice(0, RETRY_PER_RUN).map((id) => `lead:${id}`));
    for (const id of order.slice(RETRY_PER_RUN)) expect(await stateOf(id)).toEqual({ email_status: "failed", email_error: "unavailable" });
    await runRetry(NOW + 15 * MINUTE);
    expect(sentKeys().slice(RETRY_PER_RUN)).toEqual(order.slice(RETRY_PER_RUN).map((id) => `lead:${id}`));
  });

  // An outage or Resend's daily quota answers every lead the same way: one try per run, not ten.
  for (const [status, code, others] of [[429, "rate_limited", "unavailable"], [500, "unavailable", "rate_limited"]] as const) {
    it(`stops at the first ${status} and leaves the other leads untouched`, async () => {
      const site = await seedSite(tools);
      const first = await seedLead(site.siteId, { createdAt: NOW - 3 * HOUR, status: "failed", error: others });
      const second = await seedLead(site.siteId, { createdAt: NOW - 2 * HOUR, status: "failed", error: others });
      const third = await seedLead(site.siteId, { createdAt: NOW - HOUR, status: "pending" });
      resendStatus = status;
      harness.server.clearLogs();
      await runRetry(NOW);
      expect(sentKeys()).toEqual([`lead:${first}`]);
      expect(await stateOf(first)).toEqual({ email_status: "failed", email_error: code });
      expect(await stateOf(second)).toEqual({ email_status: "failed", email_error: others });
      expect(await stateOf(third)).toEqual({ email_status: "pending", email_error: null });
      const [line] = await linesWith(harness, "route", "cron_lead_email_retry", 1);
      expect(line).toEqual({ worker: "asksite-sites", route: "cron_lead_email_retry", ms: expect.any(Number), read: 3, claimed: 1, sent: 0, failed: 1, stopped: true, code: `email_${code}` });
    });
  }

  it("logs one line with codes and counts only, never the lead or the owner", async () => {
    const site = await seedSite(tools);
    await seedLead(site.siteId, { createdAt: NOW - 2 * HOUR, status: "failed", error: "unavailable" });
    await seedLead(site.siteId, { createdAt: NOW - HOUR, status: "failed", error: "rate_limited" });
    harness.server.clearLogs();
    await runRetry(NOW);
    const lines = await linesWith(harness, "route", "cron_lead_email_retry", 1);
    expect(lines).toEqual([{ worker: "asksite-sites", route: "cron_lead_email_retry", ms: expect.any(Number), read: 2, claimed: 2, sent: 2, failed: 0, stopped: false }]);
    const text = harness.server.getLogs().map((entry) => entry.message).join("\n");
    for (const personal of ["Pat Lee", "512 555 0100", "pat@example.com", "Call after five", site.ownerEmail, site.slug]) expect(text).not.toContain(personal);
  });
});

describe("overlapping runs", () => {
  // Cloudflare's docs do not say whether one cron event can be delivered twice; if it is, both runs have the same
  // scheduled time. Run B holds its first lead in the send while run A runs: A reads after B's claim on that lead
  // (and must leave it alone), and B read A's lead before A claimed it (B's claim must change no row).
  it("a duplicate delivery of one run sends each lead once, whichever run read first", async () => {
    const site = await seedSite(tools);
    const first = await seedLead(site.siteId, { createdAt: NOW - 3 * HOUR, status: "failed", error: "unavailable" });
    const second = await seedLead(site.siteId, { createdAt: NOW - 2 * HOUR, status: "failed", error: "unavailable" });
    hold(`lead:${first}`);
    const runB = runRetry(NOW);
    await until(() => sentKeys().includes(`lead:${first}`), "run B sending the first lead");
    harness.server.clearLogs();
    await runRetry(NOW);
    const [lineA] = await linesWith(harness, "route", "cron_lead_email_retry", 1);
    expect(lineA).toMatchObject({ read: 1, claimed: 1, sent: 1 });
    expect(sentKeys()).toEqual([`lead:${first}`, `lead:${second}`]);
    held?.release();
    expect((await runB).outcome).toBe("ok");
    const lines = await linesWith(harness, "route", "cron_lead_email_retry", 2);
    expect(lines[1]).toMatchObject({ read: 2, claimed: 1, sent: 1, failed: 0, stopped: false });
    expect(sentKeys()).toEqual([`lead:${first}`, `lead:${second}`]);
    expect(await stateOf(first)).toEqual({ email_status: "sent", email_error: null });
    expect(await stateOf(second)).toEqual({ email_status: "sent", email_error: null });
  });

  // The hole RULING 2 closed: a lead created hours ago looks stale by its age alone, but the run that claimed it
  // 15 minutes ago is still sending it. A second request with the same key would get Resend's 409
  // concurrent_idempotent_requests, recorded as 'rejected', and the lead would show as failed though it was sent.
  it("a run 15 minutes later leaves alone a lead the earlier run is still sending", async () => {
    const site = await seedSite(tools);
    const lead = await seedLead(site.siteId, { createdAt: NOW - 3 * HOUR, status: "failed", error: "unavailable" });
    hold(`lead:${lead}`);
    const earlier = runRetry(NOW);
    await until(() => sentKeys().includes(`lead:${lead}`), "the earlier run sending the lead");
    harness.server.clearLogs();
    expect((await runRetry(NOW + 15 * MINUTE)).outcome).toBe("ok");
    const [later] = await linesWith(harness, "route", "cron_lead_email_retry", 1);
    expect(later).toMatchObject({ read: 0, claimed: 0, sent: 0 });
    expect(await stateOf(lead)).toEqual({ email_status: "pending", email_error: `retrying:${NOW}` });
    held?.release();
    expect((await earlier).outcome).toBe("ok");
    expect(sentKeys()).toEqual([`lead:${lead}`]);
    expect(await stateOf(lead)).toEqual({ email_status: "sent", email_error: null });
  });

  // A run's result lands only over its own claim: once a later run holds the lead, the earlier run's late answer
  // must not overwrite the later run's claim (whichever answer is written last would otherwise win).
  it("writes a run's result only over its own claim", async () => {
    const site = await seedSite(tools);
    const lead = await seedLead(site.siteId, { createdAt: NOW - 3 * HOUR, status: "failed", error: "unavailable" });
    hold(`lead:${lead}`);
    resendStatus = 500;
    const earlier = runRetry(NOW);
    await until(() => sentKeys().includes(`lead:${lead}`), "the earlier run sending the lead");
    const later = `retrying:${NOW + 21 * MINUTE}`;
    await tools.DB.prepare("UPDATE leads SET email_error = ? WHERE id = ?").bind(later, lead).run();
    held?.release();
    expect((await earlier).outcome).toBe("ok");
    expect(await stateOf(lead)).toEqual({ email_status: "pending", email_error: later });
  });
});

// form.ts counts today's leads whose email was tried (A11c): spam = 0 and email_error IS NOT 'daily_cap'. A retry
// must neither add to that count nor take a lead out of it, at any step.
const COUNT_SQL = (() => {
  const source = readFileSync(resolve(import.meta.dirname, "../src/form.ts"), "utf8");
  const found = [...source.matchAll(/\((SELECT COUNT\(\*\) FROM leads WHERE created_at >= \?12[^)]*)\)/g)];
  if (found.length !== 1 || found[0]?.[1] === undefined) throw new Error("form.ts: the email count query was not found exactly once");
  return found[0][1];
})();

describe("the daily lead-email cap (form.ts)", () => {
  const tried = async (dayStart: number) =>
    (await tools.DB.prepare(COUNT_SQL.replace("?12", "?1")).bind(dayStart).first<{ "COUNT(*)": number }>())?.["COUNT(*)"];

  it("counts a retried lead once: the same before, during and after the retry", async () => {
    const site = await seedSite(tools);
    const now = Date.now();
    const lead = await seedLead(site.siteId, { createdAt: now - 1000, status: "failed", error: "unavailable" });
    await seedLead(site.siteId, { createdAt: now - 1000, status: "sent" });
    const dayStart = utcDayStart(now);
    expect(await tried(dayStart)).toBe(2);
    hold(`lead:${lead}`);
    const run = runRetry(now + MINUTE);
    await until(() => sentKeys().includes(`lead:${lead}`), "the run sending the lead");
    expect(await stateOf(lead)).toEqual({ email_status: "pending", email_error: `retrying:${now + MINUTE}` });
    expect(await tried(dayStart)).toBe(2);
    held?.release();
    await run;
    expect(await stateOf(lead)).toEqual({ email_status: "sent", email_error: null });
    expect(await tried(dayStart)).toBe(2);
  });

  // The claim marker starts 'retrying:', never 'daily_cap': with 39 tried leads and one claimed today, the
  // next post is the 41st and is capped, as it would be with the claimed lead still failed.
  it("counts a claimed lead as tried, so it still uses up one of the day's lead emails", async () => {
    const seeded = await seedSite(tools);
    const now = Date.now();
    for (let i = 0; i < 39; i++) await seedLead(seeded.siteId, { createdAt: now - 1000, status: "sent" });
    await seedLead(seeded.siteId, { createdAt: now - 1000, status: "pending", error: `retrying:${now - 1000}` });
    const site = await seedSite(tools);
    expect((await post(site, { name: "Sam Ortiz", phone: "512 555 0123", email: "", service: "", message: "", website: "" }, "198.51.100.62")).status).toBe(303);
    const [lead] = await settledLeads(tools, site.siteId);
    expect(lead).toMatchObject({ email_status: "failed", email_error: "daily_cap" });
    expect(outbound).toEqual([]);
  });
});
