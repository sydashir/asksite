import { hashIp, TTL, utcDayStart } from "@asksite/core";
import { afterEach, describe, expect, it } from "vitest";
import { LINK_RESET_WINDOW_MS, LOCK_WINDOW_MS, PASSWORD_LOCKED_SQL } from "../../src/worker/password-sql.ts";
import { APP_ORIGIN, json, nextIp, useAppHarness } from "../support/harness.ts";
import { TURNSTILE_DUMMY_TOKEN } from "../support/turnstile.ts";

// Password accounts (USER ORDER 2026-10-08, rulings of 2026-10-08): sign-up with an email and a password signs in at once;
// log-in gives one answer for a wrong email or password and locks an email for 15 minutes after 5 wrong tries, while the
// emailed link keeps working; a signed-in owner sets or replaces the password. Made-up passwords only. Its own file, so the
// day's sign-up counts start from a fresh D1.
const h = useAppHarness();

// Every sign-up counts toward the day's caps and its network's limit, and every link toward the day's email cap.
afterEach(h.clearLoginTokens);

const IP_HASH_KEY = "test-ip-hash-key"; // test/wrangler.test.jsonc
const PASSWORD = "made-up password 1";
const OTHER = "made-up password 2";
const NO_MATCH = "That email and password don't match.";
const ACCOUNT_EXISTS = "There's already an account for this email. Log in, or email yourself a log-in link.";
const NEED_LINK = "To set a new password without your current one, log in again with an email link.";
const HASH = /^pbkdf2-sha256\$100000\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=$/;

type ErrorJson = { error: { code: string; message: string } };

const uniqueEmail = (label: string): string => `${label}-${crypto.randomUUID().slice(0, 8)}@example.com`;
const cookieOf = (res: Response): string => (res.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
const withCheck = { "x-turnstile-token": TURNSTILE_DUMMY_TOKEN };

const signUp = (email: string, password: string, ip = nextIp()) => h.call("POST", "/api/auth/signup", { body: { email, password }, ip, headers: withCheck });
const logIn = (email: string, password: string) => h.call("POST", "/api/auth/login/password", { body: { email, password }, ip: nextIp(), headers: withCheck });
const setPassword = (cookie: string, body: { currentPassword?: string; newPassword: string }) => h.call("POST", "/api/me/password", { cookie, body });
const me = async (cookie: string) => json<{ sites: Array<{ id: string }>; hasPassword: boolean; skipCurrent: boolean }>(await h.call("GET", "/api/me", { cookie }));

async function storedHash(email: string): Promise<string | null | undefined> {
  return (await (await h.db()).prepare("SELECT password_hash FROM owners WHERE email = ?").bind(email).first<{ password_hash: string | null }>())?.password_hash;
}

async function sessionCount(email: string): Promise<number> {
  return (await (await h.db()).prepare("SELECT COUNT(*) AS n FROM sessions s JOIN owners o ON o.id = s.owner_id WHERE o.email = ?").bind(email).first<{ n: number }>())?.n ?? -1;
}

/** The lock rows' detail for an email, as password.ts keys it. */
const lockDetail = async (email: string): Promise<string> => JSON.stringify({ emailHash: await hashIp(IP_HASH_KEY, `email:${email}`) });

/** Signs in with the emailed link (the existing flow): request, read the dev outbox, verify. Returns the session cookie. */
async function linkLogIn(email: string): Promise<string> {
  const res = await h.login(email);
  expect(res.status).toBe(202);
  await h.backgroundDone("/api/auth/login");
  const { results } = await (await h.db()).prepare("SELECT text FROM dev_outbox WHERE to_addr = ? AND tag = 'magic_link' ORDER BY id DESC").bind(email).all<{ text: string }>();
  const token = new RegExp(`${APP_ORIGIN}/login#([A-Za-z0-9_-]{43})`).exec(results[0]?.text ?? "")?.[1];
  if (token === undefined) throw new Error("no sign-in link");
  const verified = await h.call("POST", "/api/auth/login/verify", { body: { token }, ip: nextIp() });
  expect(verified.status).toBe(200);
  return cookieOf(verified);
}

/** Adds a self-serve invite created at `at` (an emailed sign-up, as far as the day's counts go). */
async function addSignupInvite(email: string, at: number): Promise<void> {
  await (await h.db())
    .prepare("INSERT INTO invites (id, token_hash, email, created_by, created_at, expires_at) VALUES (?, ?, ?, 'signup', ?, ?)")
    .bind(crypto.randomUUID(), `seeded-${crypto.randomUUID()}`, email, at, at + TTL.inviteMs)
    .run();
}

describe("password sign-up", () => {
  it("creates the owner, the site and a 30-day password session at once, sends no email, and stores a hash, never the password", async () => {
    const email = uniqueEmail("pw-signup");
    const res = await signUp(` ${email.toUpperCase()} `, PASSWORD);
    expect(res.status).toBe(200);
    const body = await json<{ owner: { id: string; email: string }; siteId: string }>(res);
    expect(body.owner.email).toBe(email);
    expect(res.headers.get("Set-Cookie")).toMatch(/^__Host-asksite_sid=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
    const cookie = cookieOf(res);
    expect(await me(cookie)).toMatchObject({ sites: [{ id: body.siteId }], hasPassword: true, skipCurrent: false });

    const stored = await storedHash(email);
    expect(stored).toMatch(HASH);
    expect(stored).not.toContain(PASSWORD);
    const db = await h.db();
    expect(await db.prepare("SELECT signed_in_with FROM sessions WHERE owner_id = ?").bind(body.owner.id).first()).toEqual({ signed_in_with: "password" });
    // Recorded as a self-serve invite, spent at once, so the day's sign-up counts include it; no email went out.
    const invite = await db.prepare("SELECT created_by, used_at IS NOT NULL AS used, owner_id, site_id FROM invites WHERE email = ?").bind(email).first();
    expect(invite).toEqual({ created_by: "signup", used: 1, owner_id: body.owner.id, site_id: body.siteId });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM dev_outbox WHERE to_addr = ?").bind(email).first()).toEqual({ n: 0 });
  });

  it("never sets or replaces an existing account's password: 409 with the brief's words, and no session", async () => {
    const linkOwner = await h.signIn(uniqueEmail("pw-taken-link"));
    const passwordOwner = uniqueEmail("pw-taken-password");
    expect((await signUp(passwordOwner, PASSWORD)).status).toBe(200);
    const before = await storedHash(passwordOwner);

    for (const email of [linkOwner.email, passwordOwner]) {
      const sessions = await sessionCount(email);
      const res = await signUp(email, OTHER);
      expect(res.status).toBe(409);
      expect(await json<ErrorJson>(res)).toEqual({ error: { code: "conflict", message: ACCOUNT_EXISTS } });
      expect(res.headers.get("Set-Cookie")).toBeNull();
      expect(await sessionCount(email)).toBe(sessions);
    }
    expect(await storedHash(linkOwner.email)).toBeNull();
    expect(await storedHash(passwordOwner)).toBe(before);
    expect((await logIn(passwordOwner, OTHER)).status).toBe(401);
  });

  it("follows the sign-up limits: the security check, the network's 3 a day, and the sign-ups' half of the day's cap", async () => {
    const noCheck = await h.call("POST", "/api/auth/signup", { body: { email: uniqueEmail("pw-nocheck"), password: PASSWORD }, ip: nextIp() });
    expect(noCheck.status).toBe(403);

    const busy = "203.0.113.90";
    for (const label of ["pw-net-1", "pw-net-2", "pw-net-3"]) expect((await signUp(uniqueEmail(label), PASSWORD, busy)).status).toBe(200);
    const fourth = uniqueEmail("pw-net-4");
    const refused = await signUp(fourth, PASSWORD, busy);
    expect(refused.status).toBe(429);
    expect((await json<ErrorJson>(refused)).error.message).toBe("We can't open new accounts right now. Please try again tomorrow.");
    expect(await storedHash(fourth)).toBeUndefined();

    // 20 of the day's 40 (test config) are the sign-ups' share: with 20 already today, a password sign-up leaves nothing.
    const today = utcDayStart(Date.now());
    const { results } = await (await h.db()).prepare("SELECT COUNT(*) AS n FROM invites WHERE created_by = 'signup' AND created_at >= ?").bind(today).all<{ n: number }>();
    for (let i = results[0]?.n ?? 0; i < 20; i += 1) await addSignupInvite(uniqueEmail("pw-filler"), Date.now());
    const capped = uniqueEmail("pw-capped");
    const res = await signUp(capped, PASSWORD);
    expect(res.status).toBe(429);
    expect(await storedHash(capped)).toBeUndefined();
    expect(await (await h.db()).prepare("SELECT COUNT(*) AS n FROM invites WHERE email = ?").bind(capped).first()).toEqual({ n: 0 });
  });
});

describe("password log-in", () => {
  it("signs in with the right password; a wrong password and an unknown email get the same generic answer", async () => {
    const email = uniqueEmail("pw-login");
    expect((await signUp(email, PASSWORD)).status).toBe(200);
    const ok = await logIn(email.toUpperCase(), PASSWORD);
    expect(ok.status).toBe(200);
    expect((await me(cookieOf(ok))).hasPassword).toBe(true);

    const wrong = await logIn(email, OTHER);
    const unknown = await logIn(uniqueEmail("pw-nobody"), PASSWORD);
    const noPassword = await logIn((await h.signIn(uniqueEmail("pw-link-only"))).email, PASSWORD);
    for (const res of [wrong, unknown, noPassword]) {
      expect(res.status).toBe(401);
      expect(await res.text()).toBe(JSON.stringify({ error: { code: "login_failed", message: NO_MATCH } }));
      expect(res.headers.get("Set-Cookie")).toBeNull();
    }
  });

  // MUST 3: an unknown email is checked against a dummy hash, so it costs one PBKDF2 derive like a wrong password. Without the
  // dummy it would answer in a small fraction of the time; the threshold is loose so a busy machine does not flake it.
  it("takes about as long for an unknown email as for a wrong password (the dummy hash)", async () => {
    const owners = await Promise.all(["pw-time-1", "pw-time-2", "pw-time-3"].map(async (label) => {
      const email = uniqueEmail(label);
      expect((await signUp(email, PASSWORD)).status).toBe(200);
      return email;
    }));
    const known: number[] = [];
    const unknown: number[] = [];
    const timed = async (email: string): Promise<number> => {
      const started = performance.now();
      expect((await logIn(email, OTHER)).status).toBe(401);
      return performance.now() - started;
    };
    for (const email of owners) {
      known.push(await timed(email));
      unknown.push(await timed(uniqueEmail("pw-time-nobody")));
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[1]!;
    expect(median(unknown)).toBeGreaterThan(median(known) * 0.5);
  });

  it("locks the email after 5 wrong passwords: even the right one gets the generic answer, and the emailed link still signs in", async () => {
    const email = uniqueEmail("pw-lock");
    expect((await signUp(email, PASSWORD)).status).toBe(200);
    for (let i = 0; i < 5; i += 1) expect((await logIn(email, OTHER)).status).toBe(401);
    const locked = await logIn(email, PASSWORD);
    expect(locked.status).toBe(429);
    expect(await json<ErrorJson>(locked)).toEqual({ error: { code: "login_locked", message: NO_MATCH } });
    expect(locked.headers.get("Set-Cookie")).toBeNull();

    const cookie = await linkLogIn(email);
    expect((await h.call("GET", "/api/me", { cookie })).status).toBe(200);
    // The lock rows hold a keyed hash of the email, never the address.
    const rows = await (await h.db()).prepare("SELECT actor, detail_json FROM audit_log WHERE action = 'auth.password_failed' AND detail_json = ?").bind(await lockDetail(email)).all<{ actor: string; detail_json: string }>();
    expect(rows.results).toHaveLength(5);
    expect(rows.results.map((row) => row.detail_json).join()).not.toContain(email);
  });

  it("keeps the lock for 15 minutes from the 5th wrong try, then lets the right password in", async () => {
    const email = uniqueEmail("pw-lock-ends");
    expect((await signUp(email, PASSWORD)).status).toBe(200);
    const db = await h.db();
    const detail = await lockDetail(email);
    const seed = async (fifthAgoMs: number) => {
      await db.prepare("DELETE FROM audit_log WHERE action = 'auth.password_failed' AND detail_json = ?").bind(detail).run();
      // The 5 tries a minute apart, the 5th `fifthAgoMs` ago.
      for (let i = 4; i >= 0; i -= 1) {
        await db.prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) VALUES (?, 'login', 'auth.password_failed', NULL, ?)").bind(Date.now() - fifthAgoMs - i * 60_000, detail).run();
      }
    };
    await seed(LOCK_WINDOW_MS - 30_000);
    expect((await logIn(email, PASSWORD)).status).toBe(429);
    await seed(LOCK_WINDOW_MS + 1_000);
    expect((await logIn(email, PASSWORD)).status).toBe(200);
  });

  it("reads the lock's rows through the audit_site index (EXPLAIN QUERY PLAN), never by scanning the audit log", async () => {
    const { results } = await (await h.db()).prepare(`EXPLAIN QUERY PLAN ${PASSWORD_LOCKED_SQL}`).bind(Date.now(), await lockDetail("plan@example.com")).all<{ detail: string }>();
    const plan = results.map((row) => row.detail);
    // Both reads (the tries of the last 15 minutes, and the count up to each) are range searches of the index.
    expect(plan.filter((line) => /^SEARCH [fg] USING INDEX audit_site \(site_id=\? AND at>\?/.test(line))).toHaveLength(2);
    // The only scan is the outer SELECT EXISTS's one constant row.
    expect(plan.filter((line) => line.startsWith("SCAN"))).toEqual(["SCAN CONSTANT ROW"]);
  });
});

describe("setting and changing the password", () => {
  it("sets the first password without a current one; the owner can then log in with it", async () => {
    const owner = await h.signIn(uniqueEmail("pw-first"));
    expect(await me(owner.cookie)).toMatchObject({ hasPassword: false, skipCurrent: false });
    const res = await setPassword(owner.cookie, { newPassword: PASSWORD });
    expect(res.status).toBe(200);
    expect(await storedHash(owner.email)).toMatch(HASH);
    expect((await logIn(owner.email, PASSWORD)).status).toBe(200);
    expect((await me(owner.cookie)).hasPassword).toBe(true);
  });

  it("changes it with the current one from a password session, ends the owner's other sessions and keeps this one", async () => {
    const email = uniqueEmail("pw-change");
    const signedUp = await signUp(email, PASSWORD);
    const other = cookieOf(signedUp);
    const cookie = cookieOf(await logIn(email, PASSWORD));

    const missing = await setPassword(cookie, { newPassword: OTHER });
    expect(missing.status).toBe(403);
    expect((await json<ErrorJson>(missing)).error.message).toBe(NEED_LINK);
    const wrong = await setPassword(cookie, { currentPassword: OTHER, newPassword: OTHER });
    expect(wrong.status).toBe(403);
    expect((await json<ErrorJson>(wrong)).error.message).toBe("Your current password is not right.");

    expect((await setPassword(cookie, { currentPassword: PASSWORD, newPassword: OTHER })).status).toBe(200);
    expect((await h.call("GET", "/api/me", { cookie })).status).toBe(200);
    expect((await h.call("GET", "/api/me", { cookie: other })).status).toBe(401);
    expect((await logIn(email, PASSWORD)).status).toBe(401);
    expect((await logIn(email, OTHER)).status).toBe(200);
  });

  // RULED 2026-10-08 (a), test (1): sign-up does not check the email, so a squatter can sign up someone else's address.
  it("lets the real owner of a squatted email take it back: link log-in, a new password without the old one, the squatter signed out", async () => {
    const victim = uniqueEmail("pw-victim");
    const squatter = cookieOf(await signUp(victim, PASSWORD));
    expect((await h.call("GET", "/api/me", { cookie: squatter })).status).toBe(200);

    const owner = await linkLogIn(victim);
    expect(await me(owner)).toMatchObject({ hasPassword: true, skipCurrent: true });
    expect((await setPassword(owner, { newPassword: OTHER })).status).toBe(200);
    expect((await h.call("GET", "/api/me", { cookie: squatter })).status).toBe(401);
    expect((await logIn(victim, PASSWORD)).status).toBe(401);
    expect((await logIn(victim, OTHER)).status).toBe(200);
  });

  // RULED 2026-10-08 (a), test (2): a link or invite session may skip the current password for 15 minutes after its sign-in.
  it("lets a link session skip the current password up to 15 minutes after its sign-in, and refuses it after that with the decided text", async () => {
    const email = uniqueEmail("pw-window");
    expect((await signUp(email, PASSWORD)).status).toBe(200);
    const db = await h.db();
    const signedInAgo = async (cookie: string, ms: number) => {
      const owner = (await db.prepare("SELECT id FROM owners WHERE email = ?").bind(email).first<{ id: string }>())!;
      // Only this test's newest session: the one `cookie` holds (the others are the sign-up's and an earlier link's).
      await db.prepare("UPDATE sessions SET created_at = ? WHERE owner_id = ? AND signed_in_with IS NULL AND created_at = (SELECT MAX(created_at) FROM sessions WHERE owner_id = ?)").bind(Date.now() - ms, owner.id, owner.id).run();
      return cookie;
    };

    const fresh = await signedInAgo(await linkLogIn(email), LINK_RESET_WINDOW_MS - 10_000);
    expect((await setPassword(fresh, { newPassword: OTHER })).status).toBe(200);

    const stale = await signedInAgo(await linkLogIn(email), LINK_RESET_WINDOW_MS + 1_000);
    expect((await me(stale)).skipCurrent).toBe(false);
    const refused = await setPassword(stale, { newPassword: PASSWORD });
    expect(refused.status).toBe(403);
    expect((await json<ErrorJson>(refused)).error.message).toBe(NEED_LINK);
    expect((await logIn(email, OTHER)).status).toBe(200);
  });
});
