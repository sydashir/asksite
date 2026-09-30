import { newId, sha256Hex, TTL, utcDayStart } from "@asksite/core";
import { beforeEach, describe, expect, it } from "vitest";
import type { SignInEmailsView } from "../../src/settings-view.ts";
import { json, useAdminHarness } from "../support/harness.ts";

// A11b items 1 and 2: the admin sees how many sign-in emails went out today (without sending one), and can send
// one owner a sign-in link that ignores the global and the per-owner caps.

const h = useAdminHarness();

/** A fixed moment in the middle of a UTC day, sent as X-Test-Now so "today" is the same for the test and the Worker. */
const NOW = Date.UTC(2031, 0, 15, 13, 45, 0);
const DAY_START = utcDayStart(NOW);
const AT_NOW = { "X-Test-Now": String(NOW) };
const CAP = 40;

async function seedTokens(ownerId: string, times: number[]): Promise<void> {
  const db = await h.db();
  for (const [i, createdAt] of times.entries()) {
    await db.prepare("INSERT INTO login_tokens (token_hash, owner_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(`seed-${createdAt}-${i}`, ownerId, createdAt, createdAt + TTL.loginTokenMs).run();
  }
}

const tokenCount = async (ownerId: string): Promise<number> =>
  (await (await h.db()).prepare("SELECT COUNT(*) AS n FROM login_tokens WHERE owner_id = ?").bind(ownerId).first<{ n: number }>())?.n ?? 0;

const auditRows = async (action: string) =>
  (await (await h.db()).prepare("SELECT actor, site_id, detail_json FROM audit_log WHERE action = ? ORDER BY id").bind(action).all<{ actor: string; site_id: string | null; detail_json: string }>()).results;

beforeEach(async () => {
  await (await h.db()).prepare("DELETE FROM login_tokens").bind().run();
});

describe("today's sign-in emails (A11b item 1)", () => {
  it("counts the links made since 00:00 UTC against the day's cap, and says when the cap was reached", async () => {
    const site = await h.pendingSite();
    const stats = async () => json<SignInEmailsView>(await h.call("GET", "/api/admin/sign-in-emails", { headers: AT_NOW }));
    expect(await stats()).toEqual({ sentToday: 0, dailyCap: CAP, capReachedAt: null });

    // Yesterday's last millisecond does not count; the day's first millisecond does.
    await seedTokens(site.ownerId, [DAY_START - 1, DAY_START, DAY_START + 60_000]);
    expect(await stats()).toEqual({ sentToday: 2, dailyCap: CAP, capReachedAt: null });

    // 40 today: the 40th link (by time) is when the cap was reached, however many came after it.
    await seedTokens(site.ownerId, Array.from({ length: 40 }, (_, i) => DAY_START + 120_000 + i * 60_000));
    const full = await stats();
    expect(full.sentToday).toBe(42);
    expect(full.capReachedAt).toBe(DAY_START + 120_000 + 37 * 60_000);
  });

  it("needs no email to be sent (nothing is written to the outbox)", async () => {
    const before = (await (await h.db()).prepare("SELECT COUNT(*) AS n FROM dev_outbox").bind().first<{ n: number }>())?.n;
    expect((await h.call("GET", "/api/admin/sign-in-emails", { headers: AT_NOW })).status).toBe(200);
    expect((await (await h.db()).prepare("SELECT COUNT(*) AS n FROM dev_outbox").bind().first<{ n: number }>())?.n).toBe(before);
  });
});

describe("Send sign-in link (A11b item 2)", () => {
  it("records a token, emails the owner-app link, audits it, and works past every cap", async () => {
    const site = await h.pendingSite();
    // Past the global cap (40) and both per-owner caps (5 an hour, 10 a day), which the app would refuse.
    await seedTokens(site.ownerId, Array.from({ length: CAP }, (_, i) => NOW - 1000 - i));
    const res = await h.call("POST", `/api/admin/owners/${site.ownerId}/sign-in-link`, { body: {}, headers: AT_NOW });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(await tokenCount(site.ownerId)).toBe(CAP + 1);
    const [mail] = (await h.outbox(site.email)).filter((m) => m.tag === "magic_link");
    const token = /https:\/\/app\.localhost:8787\/login#([A-Za-z0-9_-]{43})/.exec(mail?.text ?? "")?.[1] ?? "";
    expect(token).toHaveLength(43);
    const stored = await (await h.db()).prepare("SELECT owner_id, created_at, expires_at, used_at FROM login_tokens WHERE token_hash = ?").bind(await sha256Hex(token)).first();
    expect(stored).toEqual({ owner_id: site.ownerId, created_at: NOW, expires_at: NOW + TTL.loginTokenMs, used_at: null });
    const audit = (await auditRows("admin.login_link_sent")).filter((a) => a.detail_json.includes(site.ownerId));
    expect(audit).toEqual([{ actor: "admin:admin@example.com", site_id: null, detail_json: JSON.stringify({ ownerId: site.ownerId }) }]);
    // It counts toward today's total, for the banner.
    expect((await json<SignInEmailsView>(await h.call("GET", "/api/admin/sign-in-emails", { headers: AT_NOW }))).sentToday).toBe(CAP + 1);
  });

  it("is refused for a disabled owner: no token, no email, no audit row", async () => {
    const site = await h.pendingSite();
    await h.call("POST", `/api/admin/owners/${site.ownerId}/disable`, { body: { reason: "Abuse" } });
    const res = await h.call("POST", `/api/admin/owners/${site.ownerId}/sign-in-link`, { body: {} });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("owner_disabled");
    expect(await tokenCount(site.ownerId)).toBe(0);
    expect((await (await h.db()).prepare("SELECT COUNT(*) AS n FROM dev_outbox WHERE to_addr = ?").bind(site.email).first<{ n: number }>())?.n).toBe(0);
    expect((await auditRows("admin.login_link_sent")).filter((a) => a.detail_json.includes(site.ownerId))).toEqual([]);
  });

  // The two checks overlap on purpose, so each has its own test that the other cannot pass for it.
  it("refuses a disabled owner before anything is started: no waitUntil, however the token insert would answer (the read check alone)", async () => {
    const site = await h.pendingSite();
    await h.call("POST", `/api/admin/owners/${site.ownerId}/disable`, { body: { reason: "Abuse" } });
    const path = `/api/admin/owners/${site.ownerId}/sign-in-link`;
    const before = await h.waitUntilCount(path);
    expect((await h.call("POST", path, { body: {} })).status).toBe(403);
    expect(await h.waitUntilCount(path)).toBe(before);
  });

  it("refuses an owner who is disabled after the route read them, at the token insert: no token, no email, no audit row (the insert condition alone)", async () => {
    const site = await h.pendingSite();
    const path = `/api/admin/owners/${site.ownerId}/sign-in-link`;
    const res = await h.call("POST", path, { body: {}, headers: { "X-Test-Disable-Owner-Before-Token": site.ownerId } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("owner_disabled");
    await h.backgroundDone(path);
    // The owner really was disabled in between (the seam ran), and still nothing was made for them.
    expect((await (await h.db()).prepare("SELECT disabled_at FROM owners WHERE id = ?").bind(site.ownerId).first<{ disabled_at: number | null }>())?.disabled_at).not.toBeNull();
    expect(await tokenCount(site.ownerId)).toBe(0);
    expect((await (await h.db()).prepare("SELECT COUNT(*) AS n FROM dev_outbox WHERE to_addr = ?").bind(site.email).first<{ n: number }>())?.n).toBe(0);
    expect((await auditRows("admin.login_link_sent")).filter((a) => a.detail_json.includes(site.ownerId))).toEqual([]);
  });

  it("answers 404 for an unknown owner and writes nothing", async () => {
    const unknown = newId();
    expect((await h.call("POST", `/api/admin/owners/${unknown}/sign-in-link`, { body: {} })).status).toBe(404);
    expect((await h.call("POST", "/api/admin/owners/not-an-id/sign-in-link", { body: {} })).status).toBe(404);
    expect((await auditRows("admin.login_link_sent")).filter((a) => a.detail_json.includes(unknown))).toEqual([]);
  });

  it("refuses a body with anything in it", async () => {
    const site = await h.pendingSite();
    expect((await h.call("POST", `/api/admin/owners/${site.ownerId}/sign-in-link`, { body: { extra: 1 } })).status).toBe(422);
    expect(await tokenCount(site.ownerId)).toBe(0);
  });

  // The shape of Task 20's invites and the ruling of 2026-09-30: a send that fails is a 502 email_failed, the token is
  // taken back (so it does not count toward the day), no audit row is written, and the log names the mailer's code, never the address.
  it("undoes the token and answers 502 when the email cannot be sent, logging only the code", async () => {
    const site = await h.pendingSite();
    await (await h.db()).prepare("UPDATE owners SET email = ? WHERE id = ?").bind("owner@mail-fails.example", site.ownerId).run();
    h.server.clearLogs();
    const res = await h.call("POST", `/api/admin/owners/${site.ownerId}/sign-in-link`, { body: {} });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { code: "email_failed", message: "Email could not be sent, try again" } });
    expect(await tokenCount(site.ownerId)).toBe(0);
    expect((await auditRows("admin.login_link_sent")).filter((a) => a.detail_json.includes(site.ownerId))).toEqual([]);
    expect(h.logLines()).toEqual([
      { event: "email_failed", tag: "magic_link", error: "rejected" },
      { route: "POST /api/admin/owners/:ownerId/sign-in-link", status: 502, ms: expect.any(Number), error: "rejected", code: "email_failed" },
    ]);
  });

  it("hands the whole sequence to waitUntil (one promise), so a client that goes away cannot stop it halfway", async () => {
    const site = await h.pendingSite();
    const path = `/api/admin/owners/${site.ownerId}/sign-in-link`;
    const before = await h.waitUntilCount(path);
    expect((await h.call("POST", path, { body: {} })).status).toBe(200);
    expect((await h.waitUntilCount(path)) - before).toBe(1);
    const refused = `/api/admin/owners/${newId()}/sign-in-link`;
    expect((await h.call("POST", refused, { body: {} })).status).toBe(404);
    expect(await h.waitUntilCount(refused)).toBe(0);
    await h.backgroundDone(path);
  });
});
