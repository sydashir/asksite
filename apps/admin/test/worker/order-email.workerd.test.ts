import { describe, expect, it } from "vitest";
import { json, useAdminHarness } from "../support/harness.ts";

// The client's order address (pages lane proposal 1.8; strict tier: customer data). Staff type it; it is confirmed only
// when the client reads back, on a staff phone call, the 8-digit code emailed to it. A shop takes orders only while its
// address is confirmed (the sites Worker's insertOrder), so a typo never sends buyers' details to a stranger. Every write
// of the address bumps its revision and clears the confirmation and any code, so a code sent to an earlier address never
// confirms a later one. Only a salted hash of the code is stored; the code is never logged, audited or answered.

const h = useAdminHarness();

const db = async () => h.db();
const row = async (siteId: string) =>
  (await db()).prepare("SELECT order_email, order_email_rev, order_email_confirmed_at, order_email_confirmed_by, order_email_code_hash, order_email_code_expires_at, order_email_code_tries FROM sites WHERE id = ?").bind(siteId).first<Record<string, unknown>>();
const audits = async (siteId: string, action: string) =>
  (await (await db()).prepare("SELECT actor, detail_json FROM audit_log WHERE site_id = ? AND action = ? ORDER BY id").bind(siteId, action).all<Record<string, unknown>>()).results;

const setEmail = (siteId: string, email: unknown) => h.call("PUT", `/api/admin/sites/${siteId}/order-email`, { body: { email } });
const sendCode = (siteId: string) => h.call("POST", `/api/admin/sites/${siteId}/order-email/code`);
const confirm = (siteId: string, code: string, rev: number) => h.call("POST", `/api/admin/sites/${siteId}/order-email/confirm`, { body: { code, rev } });

/** The code in the newest email sent to `to` (8 digits, shown as "1234 5678"). */
async function codeSentTo(to: string): Promise<string> {
  const mails = await h.outbox(to);
  const match = /\b(\d{4}) (\d{4})\b/.exec(mails.at(-1)?.text ?? "");
  if (match === null) throw new Error("no code in the email");
  return `${match[1]}${match[2]}`;
}

let n = 0;
const address = () => `client${++n}-${Math.random().toString(36).slice(2, 8)}@example.com`;

describe("PUT /api/admin/sites/:siteId/order-email", () => {
  it("sets the address (trimmed, lower-cased), bumps the revision, leaves it unconfirmed, and audits it", async () => {
    const site = await h.pendingSite();
    const email = address();
    const res = await setEmail(site.siteId, `  ${email.toUpperCase()} `);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ orderEmail: email, orderEmailRev: 1 });
    expect(await row(site.siteId)).toMatchObject({ order_email: email, order_email_rev: 1, order_email_confirmed_at: null, order_email_code_hash: null });
    expect(await audits(site.siteId, "site.order_email_set")).toHaveLength(1);
  });

  it("clears a confirmation and a pending code when the address changes; the same address again changes nothing", async () => {
    const site = await h.pendingSite();
    const first = address();
    await setEmail(site.siteId, first);
    await sendCode(site.siteId);
    expect((await confirm(site.siteId, await codeSentTo(first), 1)).status).toBe(200);
    expect((await setEmail(site.siteId, first)).status).toBe(200);
    expect(await row(site.siteId)).toMatchObject({ order_email_rev: 1, order_email_confirmed_at: expect.any(Number) });
    const second = address();
    expect(await json(await setEmail(site.siteId, second))).toEqual({ orderEmail: second, orderEmailRev: 2 });
    expect(await row(site.siteId)).toMatchObject({ order_email: second, order_email_rev: 2, order_email_confirmed_at: null, order_email_confirmed_by: null, order_email_code_hash: null, order_email_code_tries: 0 });
  });

  it("refuses an address that is not one (422), and an unknown site (404)", async () => {
    const site = await h.pendingSite();
    for (const bad of ["", "not-an-email", "a@b", `${"x".repeat(250)}@example.com`, 42]) expect((await setEmail(site.siteId, bad)).status, String(bad)).toBe(422);
    expect((await setEmail("00000000-0000-4000-8000-000000000000", address())).status).toBe(404);
  });
});

describe("POST /api/admin/sites/:siteId/order-email/code", () => {
  it("emails an 8-digit code to the address and stores only a salted hash of it, valid 7 days, 0 tries", async () => {
    const site = await h.pendingSite();
    const email = address();
    await setEmail(site.siteId, email);
    const before = Date.now();
    const res = await sendCode(site.siteId);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ sentTo: email, expiresAt: expect.any(Number) });
    const code = await codeSentTo(email);
    expect(code).toMatch(/^\d{8}$/);
    const stored = await row(site.siteId);
    expect(String(stored?.["order_email_code_hash"])).toMatch(/^v1\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    expect(String(stored?.["order_email_code_hash"])).not.toContain(code);
    expect(Number(stored?.["order_email_code_expires_at"]) - before).toBeGreaterThanOrEqual(7 * 86_400_000 - 5_000);
    expect(Number(stored?.["order_email_code_expires_at"]) - before).toBeLessThanOrEqual(7 * 86_400_000 + 60_000);
    expect(stored?.["order_email_code_tries"]).toBe(0);
  });

  it("never writes the code to the audit log, the Worker's log or the answer", async () => {
    const site = await h.pendingSite();
    const email = address();
    await setEmail(site.siteId, email);
    const answer = await (await sendCode(site.siteId)).text();
    const code = await codeSentTo(email);
    const audit = JSON.stringify(await (await db()).prepare("SELECT * FROM audit_log WHERE site_id = ?").bind(site.siteId).all());
    for (const place of [answer, audit, JSON.stringify(h.logLines())]) {
      expect(place).not.toContain(code);
      expect(place).not.toContain(`${code.slice(0, 4)} ${code.slice(4)}`);
    }
  });

  it("refuses without an address or once confirmed (409), and after 3 codes in a UTC day (429)", async () => {
    const site = await h.pendingSite();
    expect((await sendCode(site.siteId)).status).toBe(409);
    const email = address();
    await setEmail(site.siteId, email);
    for (let i = 0; i < 3; i++) expect((await sendCode(site.siteId)).status).toBe(200);
    expect((await sendCode(site.siteId)).status).toBe(429);
    const other = await h.pendingSite();
    const otherEmail = address();
    await setEmail(other.siteId, otherEmail);
    await sendCode(other.siteId);
    expect((await confirm(other.siteId, await codeSentTo(otherEmail), 1)).status).toBe(200);
    expect((await sendCode(other.siteId)).status).toBe(409);
  });

  it("keeps the 3-a-day limit exact when sends race: of 6 at once, exactly 3 are sent", async () => {
    const site = await h.pendingSite();
    await setEmail(site.siteId, address());
    const statuses = (await Promise.all(Array.from({ length: 6 }, () => sendCode(site.siteId)))).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 200, 429, 429, 429]);
  });

  it("does not count a send Resend definitively rejected; an ambiguous failure (unavailable) still counts", async () => {
    const site = await h.pendingSite();
    await setEmail(site.siteId, `bad${++n}@mail-fails.example`);
    for (let i = 0; i < 4; i++) expect((await sendCode(site.siteId)).status).toBe(502);
    const good = address();
    await setEmail(site.siteId, good);
    for (let i = 0; i < 3; i++) expect((await sendCode(site.siteId)).status).toBe(200);
    expect((await sendCode(site.siteId)).status).toBe(429);
    const other = await h.pendingSite();
    await setEmail(other.siteId, `maybe${++n}@mail-unavailable.example`);
    for (let i = 0; i < 3; i++) expect((await sendCode(other.siteId)).status).toBe(502);
    expect((await sendCode(other.siteId)).status).toBe(429);
  });

  it("a new code replaces the old one: only the newest confirms", async () => {
    const site = await h.pendingSite();
    const email = address();
    await setEmail(site.siteId, email);
    await sendCode(site.siteId);
    const old = await codeSentTo(email);
    await sendCode(site.siteId);
    const fresh = await codeSentTo(email);
    if (old !== fresh) expect((await confirm(site.siteId, old, 1)).status).toBe(422);
    expect((await confirm(site.siteId, fresh, 1)).status).toBe(200);
  });
});

describe("POST /api/admin/sites/:siteId/order-email/confirm", () => {
  async function withCode() {
    const site = await h.pendingSite();
    const email = address();
    await setEmail(site.siteId, email);
    await sendCode(site.siteId);
    return { site, email, code: await codeSentTo(email) };
  }

  it("confirms with the right code for the current revision (spaces allowed), records who and when, clears the code, audits it", async () => {
    const { site, code } = await withCode();
    const res = await confirm(site.siteId, `${code.slice(0, 4)} ${code.slice(4)}`, 1);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ orderEmailConfirmedAt: expect.any(Number) });
    expect(await row(site.siteId)).toMatchObject({ order_email_confirmed_at: expect.any(Number), order_email_confirmed_by: "admin:admin@example.com", order_email_code_hash: null, order_email_code_expires_at: null });
    expect(await audits(site.siteId, "site.order_email_confirmed")).toHaveLength(1);
    expect((await confirm(site.siteId, code, 1)).status).toBe(409);
  });

  it("refuses a wrong code (422, tries left), and after 5 wrong tries even the right one (429)", async () => {
    const { site, code } = await withCode();
    const wrong = code === "00000000" ? "11111111" : "00000000";
    const first = await confirm(site.siteId, wrong, 1);
    expect(first.status).toBe(422);
    expect(await json(first)).toMatchObject({ error: { code: "validation_failed" } });
    for (let i = 0; i < 4; i++) expect((await confirm(site.siteId, wrong, 1)).status).toBe(422);
    expect((await confirm(site.siteId, code, 1)).status).toBe(429);
    expect(await row(site.siteId)).toMatchObject({ order_email_confirmed_at: null, order_email_code_tries: 5 });
  });

  it("refuses a code sent for an earlier address (409): the address changed after the code", async () => {
    const { site, code } = await withCode();
    await setEmail(site.siteId, address());
    expect((await confirm(site.siteId, code, 1)).status).toBe(409);
    expect((await confirm(site.siteId, code, 2)).status).toBe(409);
    expect(await row(site.siteId)).toMatchObject({ order_email_confirmed_at: null });
  });

  it("refuses an expired code (410)", async () => {
    const { site, code } = await withCode();
    await (await db()).prepare("UPDATE sites SET order_email_code_expires_at = 1 WHERE id = ?").bind(site.siteId).run();
    expect((await confirm(site.siteId, code, 1)).status).toBe(410);
  });

  it("refuses a malformed body (422) and an unknown site (404)", async () => {
    const { site } = await withCode();
    expect((await h.call("POST", `/api/admin/sites/${site.siteId}/order-email/confirm`, { body: { code: "12ab5678", rev: 1 } })).status).toBe(422);
    expect((await h.call("POST", `/api/admin/sites/${site.siteId}/order-email/confirm`, { body: { code: "12345678" } })).status).toBe(422);
    expect((await confirm("00000000-0000-4000-8000-000000000000", "12345678", 1)).status).toBe(404);
  });
});
