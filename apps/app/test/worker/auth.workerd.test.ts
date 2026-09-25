import { sha256Hex } from "@asksite/core";
import { describe, expect, it } from "vitest";
import { APP_ORIGIN, json, nextIp, useAppHarness } from "../support/harness.ts";

const h = useAppHarness();

/** What the log mailer wrote for this address (read straight from D1; the dev route comes later). */
async function outbox(email: string): Promise<Array<{ subject: string; text: string; tag: string }>> {
  const { results } = await (await h.db())
    .prepare("SELECT subject, text, tag FROM dev_outbox WHERE to_addr = ? ORDER BY id DESC")
    .bind(email)
    .all<{ subject: string; text: string; tag: string }>();
  return results;
}

async function waitForEmail(email: string, count = 1) {
  for (let i = 0; i < 50; i += 1) {
    const messages = await outbox(email);
    if (messages.length >= count) return messages;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no email for ${email}`);
}

const tokenIn = (text: string, page: "invite" | "login"): string => {
  const match = new RegExp(`${APP_ORIGIN}/${page}#([A-Za-z0-9_-]{43})`).exec(text);
  if (!match?.[1]) throw new Error("no link in email");
  return match[1];
};

describe("signed-in routes", () => {
  it("return 401 without a session", async () => {
    const res = await h.call("GET", "/api/me");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "unauthenticated", message: "Please sign in" } });
  });
});

describe("invite acceptance", () => {
  it("creates the owner, a draft site and a __Host- session cookie", async () => {
    const token = await h.invite("New.Owner@Example.com");
    const res = await h.call("POST", "/api/auth/invite/accept", { body: { token }, ip: nextIp() });
    expect(res.status).toBe(200);
    const body = await json<{ owner: { id: string; email: string }; siteId: string }>(res);
    expect(body.owner.email).toBe("new.owner@example.com");
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toMatch(/^__Host-asksite_sid=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
    const me = await h.call("GET", "/api/me", { cookie: cookie.split(";")[0] ?? "" });
    expect(await json(me)).toEqual({
      owner: { id: body.owner.id, email: "new.owner@example.com" },
      sites: [{ id: body.siteId, slug: null, businessName: null, live: false, inReview: false, takenDown: false }],
    });
    const audit = await (await h.db())
      .prepare("SELECT actor, site_id FROM audit_log WHERE action = 'invite.accepted' AND site_id = ?")
      .bind(body.siteId)
      .all<{ actor: string; site_id: string }>();
    expect(audit.results).toEqual([{ actor: `owner:${body.owner.id}`, site_id: body.siteId }]);
  });

  it("stores only the hash of the session token", async () => {
    const token = await h.invite("hashes@example.com");
    const res = await h.call("POST", "/api/auth/invite/accept", { body: { token }, ip: nextIp() });
    expect(res.status).toBe(200);
    const session = (res.headers.get("Set-Cookie") ?? "").split(";")[0]?.split("=")[1] ?? "";
    const { owner } = await json<{ owner: { id: string } }>(res);
    const rows = await (await h.db()).prepare("SELECT id_hash FROM sessions WHERE owner_id = ?").bind(owner.id).all<{ id_hash: string }>();
    expect(rows.results.map((r) => r.id_hash)).toEqual([await sha256Hex(session)]);
  });

  it("is single use: a second accept of the same token is 410", async () => {
    const token = await h.invite("once@example.com");
    expect((await h.call("POST", "/api/auth/invite/accept", { body: { token }, ip: nextIp() })).status).toBe(200);
    const again = await h.call("POST", "/api/auth/invite/accept", { body: { token }, ip: nextIp() });
    expect(again.status).toBe(410);
    expect((await json<{ error: { code: string } }>(again)).error.code).toBe("invite_invalid");
  });

  it("two accepts of one token at the same moment give exactly one session", async () => {
    const token = await h.invite("race@example.com");
    const results = await Promise.all([1, 2, 3].map(() => h.call("POST", "/api/auth/invite/accept", { body: { token }, ip: nextIp() })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 410, 410]);
  });

  it("rejects an expired or revoked invite with 410", async () => {
    const db = await h.db();
    const expired = await h.invite("expired@example.com");
    await db.prepare("UPDATE invites SET expires_at = 1 WHERE email = ?").bind("expired@example.com").run();
    expect((await h.call("POST", "/api/auth/invite/accept", { body: { token: expired }, ip: nextIp() })).status).toBe(410);
    const revoked = await h.invite("revoked@example.com");
    await db.prepare("UPDATE invites SET revoked_at = 1 WHERE email = ?").bind("revoked@example.com").run();
    expect((await h.call("POST", "/api/auth/invite/accept", { body: { token: revoked }, ip: nextIp() })).status).toBe(410);
  });

  it("refuses a disabled owner without spending the token", async () => {
    const first = await h.signIn("disabled@example.com");
    const db = await h.db();
    await db.prepare("UPDATE owners SET disabled_at = 1 WHERE id = ?").bind(first.ownerId).run();
    const token = await h.invite("disabled@example.com");
    const res = await h.call("POST", "/api/auth/invite/accept", { body: { token }, ip: nextIp() });
    expect(res.status).toBe(403);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("owner_disabled");
    const row = await db.prepare("SELECT used_at FROM invites WHERE email = ? ORDER BY rowid DESC").bind("disabled@example.com").first<{ used_at: number | null }>();
    expect(row?.used_at).toBeNull();
    const me = await h.call("GET", "/api/me", { cookie: first.cookie });
    expect(me.status).toBe(403);
  });

  it("gives an existing owner a second site from a second invite", async () => {
    const first = await h.signIn("two-sites@example.com");
    const token = await h.invite("two-sites@example.com");
    const res = await h.call("POST", "/api/auth/invite/accept", { body: { token }, ip: nextIp() });
    const second = await json<{ owner: { id: string }; siteId: string }>(res);
    expect(second.owner.id).toBe(first.ownerId);
    expect(second.siteId).not.toBe(first.siteId);
  });
});

describe("magic-link sign-in", () => {
  it("always answers 202, and emails a link only to a known owner", async () => {
    await h.signIn("known@example.com");
    for (const email of ["known@example.com", "nobody@example.com"]) {
      const res = await h.call("POST", "/api/auth/login", { body: { email }, ip: nextIp() });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ ok: true });
    }
    const messages = await waitForEmail("known@example.com");
    expect(messages[0]).toMatchObject({ subject: "Your sign-in link", tag: "magic_link" });
    await new Promise((r) => setTimeout(r, 300));
    expect(await outbox("nobody@example.com")).toEqual([]);
  });

  it("signs in with the emailed token once, then the token is spent", async () => {
    const owner = await h.signIn("link@example.com");
    await h.call("POST", "/api/auth/login", { body: { email: "LINK@example.com" }, ip: nextIp() });
    const token = tokenIn((await waitForEmail("link@example.com"))[0]?.text ?? "", "login");
    const db = await h.db();
    const stored = await db.prepare("SELECT token_hash FROM login_tokens WHERE owner_id = ?").bind(owner.ownerId).all<{ token_hash: string }>();
    expect(stored.results.map((r) => r.token_hash)).toEqual([await sha256Hex(token)]);
    const res = await h.call("POST", "/api/auth/login/verify", { body: { token }, ip: nextIp() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ owner: { id: owner.ownerId, email: "link@example.com" } });
    expect(res.headers.get("Set-Cookie")).toMatch(/^__Host-asksite_sid=/);
    const login = await db.prepare("SELECT site_id FROM audit_log WHERE action = 'auth.login' AND actor = ?").bind(`owner:${owner.ownerId}`).all();
    expect(login.results).toEqual([{ site_id: null }]);
    const again = await h.call("POST", "/api/auth/login/verify", { body: { token }, ip: nextIp() });
    expect(again.status).toBe(410);
    expect((await json<{ error: { code: string } }>(again)).error.code).toBe("token_invalid");
  });

  it("sends at most 5 links per owner per hour", async () => {
    await h.signIn("capped@example.com");
    for (let i = 0; i < 7; i += 1) await h.call("POST", "/api/auth/login", { body: { email: "capped@example.com" }, ip: nextIp() });
    await waitForEmail("capped@example.com", 5);
    await new Promise((r) => setTimeout(r, 500));
    expect(await outbox("capped@example.com")).toHaveLength(5);
  });

  it("refuses a disabled owner's link with 403", async () => {
    const owner = await h.signIn("gone@example.com");
    await h.call("POST", "/api/auth/login", { body: { email: "gone@example.com" }, ip: nextIp() });
    const token = tokenIn((await waitForEmail("gone@example.com"))[0]?.text ?? "", "login");
    await (await h.db()).prepare("UPDATE owners SET disabled_at = 1 WHERE id = ?").bind(owner.ownerId).run();
    expect((await h.call("POST", "/api/auth/login/verify", { body: { token }, ip: nextIp() })).status).toBe(403);
  });
});

describe("sessions", () => {
  it("logout deletes the session and expires the cookie", async () => {
    const owner = await h.signIn();
    const res = await h.call("POST", "/api/auth/logout", { cookie: owner.cookie, ip: nextIp() });
    expect(res.status).toBe(204);
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect((await h.call("GET", "/api/me", { cookie: owner.cookie })).status).toBe(401);
  });

  it("an expired session is refused", async () => {
    const owner = await h.signIn();
    await (await h.db()).prepare("UPDATE sessions SET expires_at = 1 WHERE owner_id = ?").bind(owner.ownerId).run();
    expect((await h.call("GET", "/api/me", { cookie: owner.cookie })).status).toBe(401);
  });

  it("AUTH_RL refuses the 11th auth request in a minute from one address", async () => {
    const ip = "203.0.113.77";
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) statuses.push((await h.call("POST", "/api/auth/login", { body: { email: "x@example.com" }, ip })).status);
    expect(statuses.slice(0, 10).every((s) => s === 202)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("AUTH_RL counts every IPv6 address of one /64 network together", async () => {
    const statuses: number[] = [];
    for (let i = 1; i <= 11; i += 1) statuses.push((await h.call("POST", "/api/auth/login", { body: { email: "y@example.com" }, ip: `2001:db8:77:1::${i.toString(16)}` })).status);
    expect(statuses.slice(0, 10).every((s) => s === 202)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect((await h.call("POST", "/api/auth/login", { body: { email: "y@example.com" }, ip: "2001:db8:77:2::1" })).status).toBe(202);
  });
});
