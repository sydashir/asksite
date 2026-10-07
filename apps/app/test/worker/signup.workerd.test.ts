import { readFileSync } from "node:fs";
import { hashIp, ipRateKey, sha256Hex, TTL, utcDayStart } from "@asksite/core";
import { afterEach, describe, expect, it } from "vitest";
import { NETWORK_SIGNUP_SQL } from "../../src/worker/signup-sql.ts";
import { APP_ORIGIN, json, nextIp, useAppHarness } from "../support/harness.ts";

// Open self sign-up (USER DECISION "Hybrid release", 2026-10-07; DECIDED spec web-maker-d5): POST /api/auth/login answers
// 202 for every address; an unknown address gets a self-serve invite (created_by 'signup') by email, and the existing
// invite-accept path creates the owner and the site. Limits: 3 a day per visitor network (an audit row per attempt),
// 1 an hour and 3 in 24 hours per address, and the day's sign-in email cap for all owners (40) counts sign-up emails.
// At 80% of that cap the admins get one email a day. Its own file, so the day's counts start from a fresh D1.
const h = useAppHarness();

// Every sign-in and sign-up email of this file counts toward the day's cap, and every sign-up toward its network's and
// its address's limits, so none may outlive its test; nor may an alert, which goes out once a day.
afterEach(async () => {
  await h.clearLoginTokens();
  await (await h.db()).prepare("DELETE FROM dev_outbox WHERE to_addr = ?").bind(REVIEWER).run();
});

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const IP_HASH_KEY = "test-ip-hash-key";

/** LOGIN_EMAILS_PER_DAY and ADMIN_NOTIFY_EMAILS in the test Worker's config (test/wrangler.test.jsonc, plain JSON). */
const VARS = (JSON.parse(readFileSync(new URL("../wrangler.test.jsonc", import.meta.url), "utf8")) as { vars: Record<string, string> }).vars;
const LOGIN_EMAILS_PER_DAY = Number(VARS["LOGIN_EMAILS_PER_DAY"]);
const REVIEWER = VARS["ADMIN_NOTIFY_EMAILS"] ?? "";

type Mail = { subject: string; text: string; tag: string };

async function outbox(email: string): Promise<Mail[]> {
  const { results } = await (await h.db()).prepare("SELECT subject, text, tag FROM dev_outbox WHERE to_addr = ? ORDER BY id").bind(email).all<Mail>();
  return results;
}

/** The self-serve invites of an address. */
async function signupInvites(email: string): Promise<Array<{ created_at: number }>> {
  const { results } = await (await h.db()).prepare("SELECT created_at FROM invites WHERE email = ? AND created_by = 'signup'").bind(email).all<{ created_at: number }>();
  return results;
}

/** The network rows of one visitor address: one per sign-up attempt that passed the network's limit. */
async function networkRows(ip: string): Promise<Array<{ actor: string; site_id: string | null; detail_json: string }>> {
  const detail = JSON.stringify({ ipHash: await hashIp(IP_HASH_KEY, ipRateKey(ip)) });
  const { results } = await (await h.db())
    .prepare("SELECT actor, site_id, detail_json FROM audit_log WHERE action = 'owner.signup_requested' AND detail_json = ?")
    .bind(detail)
    .all<{ actor: string; site_id: string | null; detail_json: string }>();
  return results;
}

/** The cap alerts the admins got (ADMIN_NOTIFY_EMAILS of the test config). */
async function capAlerts(): Promise<Array<{ subject: string; tag: string }>> {
  const { results } = await (await h.db())
    .prepare("SELECT subject, tag FROM dev_outbox WHERE to_addr = ? AND subject LIKE 'Sign-in emails today:%' ORDER BY id")
    .bind(REVIEWER)
    .all<{ subject: string; tag: string }>();
  return results;
}

/** Row counts of every table a sign-in or sign-up request can write. */
async function rowCounts(): Promise<Record<string, number>> {
  const db = await h.db();
  const counts: Record<string, number> = {};
  for (const table of ["invites", "audit_log", "login_tokens", "owners", "sites", "dev_outbox"]) {
    counts[table] = (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).bind().first<{ n: number }>())?.n ?? -1;
  }
  return counts;
}

/** Requests a link for `email` (from `ip`, else a fresh address), checks the 202 and waits for the background work. */
async function requestLink(email: string, ip?: string): Promise<void> {
  const res = await h.login(email, ip === undefined ? {} : { ip });
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ ok: true });
  await h.backgroundDone("/api/auth/login");
}

/** Waits out the last 10 s of a UTC day, so every request of a test falls in the day it computed. Returns that day's start. */
async function awayFromUtcMidnight(): Promise<number> {
  const left = utcDayStart(Date.now()) + DAY_MS - Date.now();
  if (left < 10_000) await new Promise((resolve) => setTimeout(resolve, left + 1_000));
  return utcDayStart(Date.now());
}

/** Adds sign-in emails of `ownerId` at the day's first millisecond until the day holds `total` sign-in links (sign-ups not counted here). */
async function fillDay(ownerId: string, dayStart: number, total: number): Promise<void> {
  const db = await h.db();
  const today = await db.prepare("SELECT COUNT(*) AS n FROM login_tokens WHERE created_at >= ?").bind(dayStart).first<{ n: number }>();
  for (let i = today?.n ?? 0; i < total; i += 1) {
    await db.prepare("INSERT INTO login_tokens (token_hash, owner_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(`filler-${crypto.randomUUID()}`, ownerId, dayStart, dayStart + 1).run();
  }
}

/** Adds a self-serve invite of `email` created at `at`. */
async function addSignupInvite(email: string, at: number): Promise<void> {
  await (await h.db())
    .prepare("INSERT INTO invites (id, token_hash, email, created_by, created_at, expires_at) VALUES (?, ?, ?, 'signup', ?, ?)")
    .bind(crypto.randomUUID(), `seeded-${crypto.randomUUID()}`, email, at, at + TTL.inviteMs)
    .run();
}

const tokenIn = (text: string, page: "invite" | "login"): string => {
  const match = new RegExp(`${APP_ORIGIN}/${page}#([A-Za-z0-9_-]{43})`).exec(text);
  if (!match?.[1]) throw new Error("no link in email");
  return match[1];
};

const events = (name: string) => h.logLines().filter((line) => line["event"] === name);

describe("an unknown address signs up (open self sign-up)", () => {
  it("gets the sign-up email with an /invite# link; accepting it creates the owner and the site and signs them in", async () => {
    const email = "new-business@example.com";
    await requestLink("New-Business@Example.com");
    const mails = await outbox(email);
    expect(mails.map(({ subject, tag }) => ({ subject, tag }))).toEqual([{ subject: "Set up your business website", tag: "signup_invite" }]);
    const token = tokenIn(mails[0]?.text ?? "", "invite");
    const db = await h.db();
    const invite = await db
      .prepare("SELECT email, created_by, expires_at - created_at AS ttl, used_at, owner_id, site_id FROM invites WHERE token_hash = ?")
      .bind(await sha256Hex(token))
      .first();
    expect(invite).toEqual({ email, created_by: "signup", ttl: TTL.inviteMs, used_at: null, owner_id: null, site_id: null });
    // No owner and no site before the link is used.
    expect(await db.prepare("SELECT COUNT(*) AS n FROM owners WHERE email = ?").bind(email).first()).toEqual({ n: 0 });

    const accepted = await h.call("POST", "/api/auth/invite/accept", { body: { token }, ip: nextIp() });
    expect(accepted.status).toBe(200);
    const { owner, siteId } = await json<{ owner: { id: string; email: string }; siteId: string }>(accepted);
    expect(owner.email).toBe(email);
    const cookie = (accepted.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
    const me = await h.call("GET", "/api/me", { cookie });
    expect(me.status).toBe(200);
    expect((await json<{ sites: Array<{ id: string }> }>(me)).sites.map((site) => site.id)).toEqual([siteId]);
    expect(await db.prepare("SELECT owner_id, site_id FROM invites WHERE token_hash = ?").bind(await sha256Hex(token)).first()).toEqual({ owner_id: owner.id, site_id: siteId });

    // The address is an owner now: the next request is a sign-in link, not a second sign-up link.
    await requestLink(email);
    expect((await outbox(email)).map((mail) => mail.tag)).toEqual(["signup_invite", "magic_link"]);
    expect(await signupInvites(email)).toHaveLength(1);
  });

  it("answers a known owner, an unknown address, a disabled owner and a network past its limit with the same bytes", async () => {
    const known = await h.signIn("same-known@example.com");
    const disabled = await h.signIn("same-disabled@example.com");
    await (await h.db()).prepare("UPDATE owners SET disabled_at = 1 WHERE id = ?").bind(disabled.ownerId).run();
    const busy = "203.0.113.40";
    await awayFromUtcMidnight();
    for (const email of ["busy-1@example.com", "busy-2@example.com", "busy-3@example.com"]) await requestLink(email, busy);
    const answers = [];
    for (const [email, ip] of [[known.email, nextIp()], ["same-unknown@example.com", nextIp()], [disabled.email, nextIp()], ["busy-4@example.com", busy]] as const) {
      const res = await h.login(email, { ip });
      const headers = [...res.headers].filter(([name]) => name.toLowerCase() !== "date").sort(([a], [b]) => a.localeCompare(b));
      answers.push({ status: res.status, headers, body: await res.text() });
    }
    await h.backgroundDone("/api/auth/login");
    expect(answers[0]).toMatchObject({ status: 202, body: '{"ok":true}' });
    for (const other of answers.slice(1)) expect(other).toEqual(answers[0]);
    // ...and each took its own path after the answer.
    expect((await outbox(known.email)).map((mail) => mail.tag)).toEqual(["magic_link"]);
    expect((await outbox("same-unknown@example.com")).map((mail) => mail.tag)).toEqual(["signup_invite"]);
    expect(await outbox(disabled.email)).toEqual([]);
    expect(await outbox("busy-4@example.com")).toEqual([]);
  });

  it("sends a disabled owner nothing: no sign-in link and no sign-up link (its network row is written, as for every request: I3)", async () => {
    const owner = await h.signIn("disabled-signup@example.com");
    await (await h.db()).prepare("UPDATE owners SET disabled_at = 1 WHERE id = ?").bind(owner.ownerId).run();
    const ip = "203.0.113.41";
    await requestLink(owner.email, ip);
    expect(await outbox(owner.email)).toEqual([]);
    expect(await signupInvites(owner.email)).toEqual([]);
    expect(await networkRows(ip)).toHaveLength(1);
    expect(await (await h.db()).prepare("SELECT COUNT(*) AS n FROM login_tokens WHERE owner_id = ?").bind(owner.ownerId).first()).toEqual({ n: 0 });
  });

  it("still sends a known owner a sign-in link, never a sign-up link", async () => {
    const owner = await h.signIn("known-signin@example.com");
    const ip = "203.0.113.42";
    await requestLink(owner.email, ip);
    expect((await outbox(owner.email)).map(({ subject, tag }) => ({ subject, tag }))).toEqual([{ subject: "Your sign-in link", tag: "magic_link" }]);
    expect(await signupInvites(owner.email)).toEqual([]);
    expect(await networkRows(ip)).toHaveLength(1);
  });
});

// RULED (web-maker-d5, 2026-10-07): accepting a sign-up link revokes the address's other unused sign-up links in the same
// batch, so one address gets one site from sign-up. An admin's invite for the address is not revoked.
describe("accepting a sign-up link", () => {
  it("revokes the address's other unused sign-up links in the same batch, but not an admin's invite for it", async () => {
    const email = "one-site@example.com";
    const db = await h.db();
    // An older sign-up link, more than an hour ago, so the route still sends a new one now.
    const older = "O".repeat(43);
    const olderAt = Date.now() - 2 * HOUR_MS;
    await db
      .prepare("INSERT INTO invites (id, token_hash, email, created_by, created_at, expires_at) VALUES (?, ?, ?, 'signup', ?, ?)")
      .bind(crypto.randomUUID(), await sha256Hex(older), email, olderAt, olderAt + TTL.inviteMs)
      .run();
    const adminToken = await h.invite(email);
    await requestLink(email);
    const token = tokenIn((await outbox(email))[0]?.text ?? "", "invite");

    const accepted = await h.call("POST", "/api/auth/invite/accept", { body: { token }, ip: nextIp() });
    expect(accepted.status).toBe(200);
    const { owner } = await json<{ owner: { id: string } }>(accepted);
    const rows = async (hash: string) =>
      db.prepare("SELECT used_at IS NOT NULL AS used, revoked_at IS NOT NULL AS revoked FROM invites WHERE token_hash = ?").bind(hash).first();
    expect(await rows(await sha256Hex(older))).toEqual({ used: 0, revoked: 1 });
    expect(await rows(await sha256Hex(adminToken))).toEqual({ used: 0, revoked: 0 });
    expect(await rows(await sha256Hex(token))).toEqual({ used: 1, revoked: 0 });
    // The revoked link is refused like any revoked invite and makes no second site.
    const again = await h.call("POST", "/api/auth/invite/accept", { body: { token: older }, ip: nextIp() });
    expect(again.status).toBe(410);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM sites WHERE owner_id = ?").bind(owner.id).first()).toEqual({ n: 1 });
    // The admin's invite still works as before (a second site, by design).
    expect((await h.call("POST", "/api/auth/invite/accept", { body: { token: adminToken }, ip: nextIp() })).status).toBe(200);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM sites WHERE owner_id = ?").bind(owner.id).first()).toEqual({ n: 2 });
  });

  it("revokes nothing when an admin's invite is accepted, and nothing of another address", async () => {
    const email = "admin-first@example.com";
    const db = await h.db();
    await requestLink(email);
    await requestLink("someone-else@example.com");
    const accepted = await h.call("POST", "/api/auth/invite/accept", { body: { token: await h.invite(email) }, ip: nextIp() });
    expect(accepted.status).toBe(200);
    const open = async (address: string) =>
      db.prepare("SELECT COUNT(*) AS n FROM invites WHERE email = ? AND created_by = 'signup' AND revoked_at IS NULL AND used_at IS NULL").bind(address).first();
    expect(await open(email)).toEqual({ n: 1 });
    expect(await open("someone-else@example.com")).toEqual({ n: 1 });
  });
});

describe("the security check comes before any sign-up work", () => {
  it("a failed or missing Turnstile token for an unknown address sends nothing and writes no rows", async () => {
    const before = await rowCounts();
    const background = await h.waitUntilCount("/api/auth/login");
    for (const turnstile of [null, "always-fails"]) {
      const res = await h.login("bot-signup@example.com", { turnstile });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: { code: "forbidden", message: "Please complete the security check and try again." } });
    }
    expect(await h.waitUntilCount("/api/auth/login")).toBe(background);
    expect(await rowCounts()).toEqual(before);
  });
});

describe("at most 3 sign-ups per visitor network per UTC day", () => {
  it("sends the 3rd, but the 4th from one network sends nothing, writes no invite, still answers 202 and logs one line", async () => {
    const ip = "203.0.113.50";
    await awayFromUtcMidnight();
    h.server.clearLogs();
    for (const n of [1, 2, 3]) await requestLink(`network-${n}@example.com`, ip);
    for (const n of [1, 2, 3]) expect((await outbox(`network-${n}@example.com`)).map((mail) => mail.tag)).toEqual(["signup_invite"]);
    await requestLink("network-4@example.com", ip);
    expect(await outbox("network-4@example.com")).toEqual([]);
    expect(await signupInvites("network-4@example.com")).toEqual([]);
    expect(events("signup_network_limit")).toEqual([{ event: "signup_network_limit" }]);
    // One row per sign-up the limit let through, keyed by the network's hash, exactly as AUTH_RL's key is built.
    const rows = await networkRows(ip);
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row).toEqual({ actor: "signup", site_id: null, detail_json: JSON.stringify({ ipHash: await hashIp(IP_HASH_KEY, ipRateKey(ip)) }) });
    // Another network still signs up.
    await requestLink("network-5@example.com", "203.0.113.51");
    expect((await outbox("network-5@example.com")).map((mail) => mail.tag)).toEqual(["signup_invite"]);
  });

  it("counts every IPv6 address of one /64 network together", async () => {
    await awayFromUtcMidnight();
    for (const n of [1, 2, 3, 4]) await requestLink(`six-${n}@example.com`, `2001:db8:99:1::${n}`);
    expect(await outbox("six-3@example.com")).toHaveLength(1);
    expect(await outbox("six-4@example.com")).toEqual([]);
    await requestLink("six-5@example.com", "2001:db8:99:2::1");
    expect(await outbox("six-5@example.com")).toHaveLength(1);
  });

  it("counts the UTC day only: sign-ups from before 00:00 UTC do not count", async () => {
    const ip = "203.0.113.52";
    const dayStart = await awayFromUtcMidnight();
    const detail = JSON.stringify({ ipHash: await hashIp(IP_HASH_KEY, ipRateKey(ip)) });
    for (let i = 0; i < 3; i += 1) {
      await (await h.db()).prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) VALUES (?, 'signup', 'owner.signup_requested', NULL, ?)").bind(dayStart - 1, detail).run();
    }
    await requestLink("new-day@example.com", ip);
    expect(await outbox("new-day@example.com")).toHaveLength(1);
  });

  it("counts the network's sign-ups today with the audit_site (site_id, at) index, never a scan of audit_log (EXPLAIN QUERY PLAN)", async () => {
    const plan = await (await h.db()).prepare(`EXPLAIN QUERY PLAN ${NETWORK_SIGNUP_SQL}`).bind(1, "{}", 0, 3).all<{ detail: string }>();
    const lines = plan.results.map((row) => row.detail).join("\n");
    console.log(`EXPLAIN QUERY PLAN of the network count:\n${lines}`);
    expect(lines).toContain("USING INDEX audit_site (site_id=? AND at>?)");
    expect(lines).not.toMatch(/SCAN audit_log/);
  });
});

// I3 (DECIDED, moderator 2026-10-07): every request that passed Turnstile writes its network's row, owner or not, so the
// network's count cannot tell whether an address has an account. The limit of 3 refuses only sign-ups.
describe("the network count says nothing about accounts (I3)", () => {
  it("gives the same number of sign-up emails after a known, a disabled or an unknown target address", async () => {
    const known = await h.signIn("oracle-known@example.com");
    const disabled = await h.signIn("oracle-disabled@example.com");
    await (await h.db()).prepare("UPDATE owners SET disabled_at = 1 WHERE id = ?").bind(disabled.ownerId).run();
    await awayFromUtcMidnight();
    const counts: Record<string, number> = {};
    for (const [label, target, ip] of [["known", known.email, "203.0.113.70"], ["disabled", disabled.email, "203.0.113.71"], ["unknown", "oracle-unknown@example.com", "203.0.113.72"]] as const) {
      await requestLink(target, ip);
      let sent = 0;
      for (const n of [1, 2, 3]) {
        await requestLink(`oracle-${label}-${n}@example.com`, ip);
        sent += (await outbox(`oracle-${label}-${n}@example.com`)).length;
      }
      counts[label] = sent;
    }
    expect(counts).toEqual({ known: 2, disabled: 2, unknown: 2 });
  });

  it("never refuses a known owner's sign-in: the 4th and 5th requests from a network past its 3 still get their links", async () => {
    const owner = await h.signIn("busy-network-owner@example.com");
    const ip = "203.0.113.73";
    await awayFromUtcMidnight();
    for (const n of [1, 2, 3]) await requestLink(`busy-network-${n}@example.com`, ip);
    await requestLink(owner.email, ip);
    await requestLink(owner.email, ip);
    expect((await outbox(owner.email)).map((mail) => mail.tag)).toEqual(["magic_link", "magic_link"]);
    expect(await networkRows(ip)).toHaveLength(5);
  });
});

// I1 (DECIDED, moderator 2026-10-07): sign-ups may use at most half of the day's cap (20 of 40), so bot sign-ups can never
// use up the sign-in emails of every owner.
describe("sign-ups use at most half of the day's sign-in email cap (I1)", () => {
  it("sends no sign-up once today's sign-ups reach 20, and a known owner still gets a sign-in link", async () => {
    const owner = await h.signIn("still-signs-in@example.com");
    const dayStart = await awayFromUtcMidnight();
    for (let i = 0; i < LOGIN_EMAILS_PER_DAY / 2 - 1; i += 1) await addSignupInvite(`earlier-signup-${i}@example.com`, dayStart);
    await requestLink("twentieth-signup@example.com");
    expect(await outbox("twentieth-signup@example.com")).toHaveLength(1);
    h.server.clearLogs();
    await requestLink("twenty-first-signup@example.com");
    expect(await outbox("twenty-first-signup@example.com")).toEqual([]);
    expect(await signupInvites("twenty-first-signup@example.com")).toEqual([]);
    expect(events("signup_cap_reached")).toEqual([{ event: "signup_cap_reached" }]);
    await requestLink(owner.email);
    expect((await outbox(owner.email)).map((mail) => mail.tag)).toEqual(["magic_link"]);
  });
});

describe("at most 1 sign-up link per address an hour and 3 in 24 hours", () => {
  it("sends nothing for a 2nd request within the hour, even from another network, and logs one line", async () => {
    const email = "hourly@example.com";
    await requestLink(email);
    h.server.clearLogs();
    await requestLink(email);
    expect(await outbox(email)).toHaveLength(1);
    expect(await signupInvites(email)).toHaveLength(1);
    expect(events("signup_email_limit")).toEqual([{ event: "signup_email_limit" }]);
  });

  it("sends the 3rd in 24 hours but not the 4th, counted back from the request (rolling, not the UTC day)", async () => {
    const email = "daily@example.com";
    const now = Date.now();
    // Two links more than an hour ago, so the hourly limit does not count them.
    await addSignupInvite(email, now - 2 * HOUR_MS);
    await addSignupInvite(email, now - 3 * HOUR_MS);
    await requestLink(email);
    expect(await outbox(email)).toHaveLength(1);
    // The 3rd moves back past the hour: the 4th in 24 hours is still refused.
    await (await h.db()).prepare("UPDATE invites SET created_at = ? WHERE email = ? AND created_at > ?").bind(now - 4 * HOUR_MS, email, now - HOUR_MS).run();
    await requestLink(email);
    expect(await outbox(email)).toHaveLength(1);
    expect(await signupInvites(email)).toHaveLength(3);
    // A link more than 24 hours old no longer counts.
    await (await h.db()).prepare("UPDATE invites SET created_at = ? WHERE email = ? AND created_at = ?").bind(now - DAY_MS - HOUR_MS, email, now - 3 * HOUR_MS).run();
    await requestLink(email);
    expect(await outbox(email)).toHaveLength(2);
  });
});

describe("sign-up emails count toward the day's sign-in email cap for all owners", () => {
  it(`a sign-up takes the ${LOGIN_EMAILS_PER_DAY}th of the day, so the next known owner's link is refused and logged`, async () => {
    expect(LOGIN_EMAILS_PER_DAY).toBe(40);
    const filler = await h.signIn();
    const known = await h.signIn("refused-after-signup@example.com");
    const dayStart = await awayFromUtcMidnight();
    await fillDay(filler.ownerId, dayStart, LOGIN_EMAILS_PER_DAY - 1);
    await requestLink("fortieth-signup@example.com");
    expect(await outbox("fortieth-signup@example.com")).toHaveLength(1);
    h.server.clearLogs();
    await requestLink(known.email);
    expect(await outbox(known.email)).toEqual([]);
    expect(await (await h.db()).prepare("SELECT COUNT(*) AS n FROM login_tokens WHERE owner_id = ?").bind(known.ownerId).first()).toEqual({ n: 0 });
    expect(events("login_email_cap_reached")).toEqual([{ event: "login_email_cap_reached" }]);
  });

  it("a sign-up past the day's cap sends nothing, writes no invite, and logs login_email_cap_reached", async () => {
    const filler = await h.signIn();
    const dayStart = await awayFromUtcMidnight();
    await fillDay(filler.ownerId, dayStart, LOGIN_EMAILS_PER_DAY);
    h.server.clearLogs();
    await requestLink("past-cap-signup@example.com");
    expect(await outbox("past-cap-signup@example.com")).toEqual([]);
    expect(await signupInvites("past-cap-signup@example.com")).toEqual([]);
    expect(events("login_email_cap_reached")).toEqual([{ event: "login_email_cap_reached" }]);
    expect(events("signup_email_limit")).toEqual([]);
  });
});

describe("a failed sign-up email", () => {
  it("deletes the invite (rejected or unavailable), so it neither works nor counts toward the day's cap; its network row still counts", async () => {
    const ip = "203.0.113.60";
    const filler = await h.signIn();
    const known = await h.signIn("after-failed-signups@example.com");
    const dayStart = await awayFromUtcMidnight();
    h.server.clearLogs();
    for (const email of ["broken@mail-fails.example", "down@mail-unavailable.example"]) {
      await requestLink(email, ip);
      expect(await signupInvites(email)).toEqual([]);
    }
    expect(events("email_failed")).toEqual([
      { event: "email_failed", tag: "signup_invite", error: "rejected" },
      { event: "email_failed", tag: "signup_invite", error: "unavailable" },
    ]);
    expect(await networkRows(ip)).toHaveLength(2);
    // Not counted: with the day at 39, a known owner still gets the 40th.
    await fillDay(filler.ownerId, dayStart, LOGIN_EMAILS_PER_DAY - 1);
    await requestLink(known.email);
    expect((await outbox(known.email)).map((mail) => mail.tag)).toEqual(["magic_link"]);
  });
});

describe(`the near-cap alert (80% of ${LOGIN_EMAILS_PER_DAY})`, () => {
  it("emails ADMIN_NOTIFY_EMAILS once when a sign-up takes the day to 32 of 40, and never again that day", async () => {
    const filler = await h.signIn();
    const known = await h.signIn("thirty-third@example.com");
    const dayStart = await awayFromUtcMidnight();
    await fillDay(filler.ownerId, dayStart, 30);
    await requestLink("thirty-first@example.com");
    expect(await capAlerts()).toEqual([]);
    h.server.clearLogs();
    await requestLink("thirty-second@example.com");
    expect(await capAlerts()).toEqual([{ subject: "Sign-in emails today: 32 of 40", tag: "admin_alert" }]);
    expect(events("signin_cap_alert")).toEqual([{ event: "signin_cap_alert", sent: 32, cap: 40, recipients: 1 }]);
    // The 33rd (a sign-in) and the 34th (a sign-up) send no second alert.
    await requestLink(known.email);
    await requestLink("thirty-fourth@example.com");
    expect((await outbox(known.email)).map((mail) => mail.tag)).toEqual(["magic_link"]);
    expect(await capAlerts()).toHaveLength(1);
    const { results } = await (await h.db()).prepare("SELECT actor, site_id FROM audit_log WHERE action = 'signin.cap_alert_sent'").bind().all();
    expect(results).toEqual([{ actor: "system", site_id: null }]);
  });

  it("fires from the sign-in path too, after the owner's own link", async () => {
    const filler = await h.signIn();
    const known = await h.signIn("thirty-second-signin@example.com");
    const dayStart = await awayFromUtcMidnight();
    await fillDay(filler.ownerId, dayStart, 31);
    await requestLink(known.email);
    expect((await outbox(known.email)).map((mail) => mail.tag)).toEqual(["magic_link"]);
    expect(await capAlerts()).toEqual([{ subject: "Sign-in emails today: 32 of 40", tag: "admin_alert" }]);
  });
});
