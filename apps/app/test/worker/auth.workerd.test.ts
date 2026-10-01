import { readFileSync } from "node:fs";
import { LIMITS, sha256Hex } from "@asksite/core";
import { Facts } from "@asksite/site-schema";
import { afterEach, describe, expect, it } from "vitest";
import { claimInvite } from "../../src/worker/invite-claim.ts";
import { APP_ORIGIN, awayFromMinuteBoundary, eventually, json, nextIp, useAppHarness } from "../support/harness.ts";
import { TURNSTILE_DUMMY_TOKEN } from "../support/turnstile.ts";

const h = useAppHarness();

// Every sign-in link of this file also counts toward the day's cap for all owners (LOGIN_EMAILS_PER_DAY),
// so none may outlive its test.
afterEach(h.clearLoginTokens);

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The API_RL limit the test Worker runs with (test/wrangler.test.jsonc, plain JSON). */
const API_RL_LIMIT = (
  JSON.parse(readFileSync(new URL("../wrangler.test.jsonc", import.meta.url), "utf8")) as { ratelimits: Array<{ name: string; simple: { limit: number } }> }
).ratelimits.find((limiter) => limiter.name === "API_RL")!.simple.limit;

type ErrorJson = { error: { code: string; message: string } };

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

const cookieValue = (cookie: string): string => cookie.split("=")[1] ?? "";

async function tokenRows(ownerId: string): Promise<Array<{ created_at: number }>> {
  const { results } = await (await h.db()).prepare("SELECT created_at FROM login_tokens WHERE owner_id = ?").bind(ownerId).all<{ created_at: number }>();
  return results;
}

async function sessionHashes(ownerId: string): Promise<string[]> {
  const { results } = await (await h.db()).prepare("SELECT id_hash FROM sessions WHERE owner_id = ?").bind(ownerId).all<{ id_hash: string }>();
  return results.map((row) => row.id_hash);
}

async function acceptInvite(email: string): Promise<string> {
  const res = await h.call("POST", "/api/auth/invite/accept", { body: { token: await h.invite(email) }, ip: nextIp() });
  expect(res.status).toBe(200);
  return (await json<{ siteId: string }>(res)).siteId;
}

/** Runs `body` with a temporary SQL trigger in the test database, standing in for a failure or a race. */
async function withTrigger(name: string, sql: string, body: () => Promise<void>): Promise<void> {
  const db = await h.db();
  await db.prepare(sql).bind().run();
  try {
    await body();
  } finally {
    await db.prepare(`DROP TRIGGER ${name}`).bind().run();
  }
}

/** Moves login tokens back in time (controlled time: the Worker's clock is real, the rows' times are the test's). */
async function ageTokens(ownerId: string, byMs: number, newerThan = 0): Promise<void> {
  await (await h.db()).prepare("UPDATE login_tokens SET created_at = created_at - ? WHERE owner_id = ? AND created_at > ?").bind(byMs, ownerId, newerThan).run();
}

describe("signed-in routes", () => {
  it("return 401 without a session", async () => {
    const res = await h.call("GET", "/api/me");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "unauthenticated", message: "Please sign in" } });
  });

  it("report each site's business name and live, in-review and taken-down state from its rows on /api/me", async () => {
    const owner = await h.signIn();
    const second = await acceptInvite(owner.email);
    const third = await acceptInvite(owner.email);
    const db = await h.db();
    const set = (siteId: string, columns: string, ...values: unknown[]) => db.prepare(`UPDATE sites SET ${columns} WHERE id = ?`).bind(...values, siteId).run();
    await set(owner.siteId, "slug = 'ace-plumbing', facts_json = ?, live_version_id = 'v-live', pending_version_id = 'v-new'", JSON.stringify({ businessName: "Ace Plumbing" }));
    await set(second, "facts_json = '{not json', live_version_id = 'v-old', taken_down_at = 5");
    await set(third, "facts_json = ?, pending_version_id = 'v-first'", JSON.stringify({ businessName: "   " }));
    const me = await json<{ sites: unknown[] }>(await h.call("GET", "/api/me", { cookie: owner.cookie }));
    expect(me.sites).toHaveLength(3);
    expect(me.sites).toEqual(
      expect.arrayContaining([
        { id: owner.siteId, slug: "ace-plumbing", businessName: "Ace Plumbing", live: true, inReview: true, takenDown: false },
        { id: second, slug: null, businessName: null, live: false, inReview: false, takenDown: true },
        { id: third, slug: null, businessName: null, live: false, inReview: true, takenDown: false },
      ]),
    );
  });

  it("read only what /api/me shows from each site's row: never its brief or edits, and of its facts only the business name, at most 60 characters", async () => {
    const owner = await h.signIn();
    await h.recordSql("/api/me");
    expect((await h.call("GET", "/api/me", { cookie: owner.cookie })).status).toBe(200);
    const reads = (await h.recordedSql("/api/me")).filter((sql) => /\bFROM sites\b/.test(sql));
    expect(reads).toHaveLength(1);
    expect(reads[0]).not.toMatch(/\*|brief_json|edits_json/);
    // The whole select list (P4-21 item 3). Its CASE holds commas, so it is pinned whole, whitespace collapsed.
    const selected = /^\s*SELECT\s+([\s\S]+?)\s+FROM sites\b/.exec(reads[0] ?? "")?.[1]?.replace(/\s+/g, " ");
    expect(selected).toBe(
      "id, slug, live_version_id, pending_version_id, taken_down_at, CASE WHEN NOT json_valid(facts_json) THEN NULL " +
        "WHEN json_type(facts_json, '$.businessName') = 'text' THEN substr(json_extract(facts_json, '$.businessName'), 1, 60) END AS business_name",
    );
  });

  // P4-21 item 4 and DECIDED 8: the name is clamped inside D1 to Facts' own limit, and again in the Worker, where a
  // lone surrogate D1 counted once arrives as three U+FFFD; both count as Facts counts (code points).
  it("show at most Facts' 60 characters of a draft's business name, clamped before it leaves D1: a 250,000-character name, an emoji name, a name of lone surrogates", async () => {
    const owner = await h.signIn();
    const db = await h.db();
    const huge = owner.siteId;
    const emoji = await acceptInvite(owner.email);
    const lone = await acceptInvite(owner.email);
    const saveFacts = (siteId: string, factsJson: string) => db.prepare("UPDATE sites SET facts_json = ? WHERE id = ?").bind(factsJson, siteId).run();
    await saveFacts(huge, JSON.stringify({ businessName: "x".repeat(250_000) }));
    await saveFacts(emoji, JSON.stringify({ businessName: "\u{1F527}".repeat(70) }));
    // Only a hand-made request can store these: JSON escapes of lone surrogates.
    await saveFacts(lone, `{"businessName":"${"\\ud800".repeat(70)}"}`);
    const res = await h.call("GET", "/api/me", { cookie: owner.cookie });
    expect(res.status).toBe(200);
    const text = await res.text();
    // The answer is small. The select list pinned in the test above cuts the name inside D1, so it never reaches the Worker whole.
    expect(new TextEncoder().encode(text).byteLength).toBeLessThan(2_048);
    const names = new Map((JSON.parse(text) as { sites: Array<{ id: string; businessName: string | null }> }).sites.map((site) => [site.id, site.businessName]));
    expect(names.get(huge)).toBe("x".repeat(60));
    expect(names.get(emoji)).toBe("\u{1F527}".repeat(60));
    for (const siteId of [huge, emoji, lone]) {
      // Never over Facts' own limit, by Facts' own count.
      const name = names.get(siteId) ?? "";
      expect(Facts.shape.businessName.safeParse(name).success, `${siteId}: ${Array.from(name).length} code points`).toBe(true);
    }
  });

  it("show each site's business name on /api/me as saved (quotes, accents, JSON escapes), and none for a name that is not text", async () => {
    const owner = await h.signIn();
    const saved: Array<[string, unknown]> = [
      [owner.siteId, `Joe's "Best" Plumbing`],
      [await acceptInvite(owner.email), "Café Ñandú"],
      [await acceptInvite(owner.email), { first: "Ace" }],
      [await acceptInvite(owner.email), 42],
    ];
    for (const [siteId, businessName] of saved) {
      expect((await h.call("PATCH", `/api/sites/${siteId}/draft`, { cookie: owner.cookie, body: { rev: 1, facts: { businessName } } })).status).toBe(200);
    }
    // The accented name again, written with JSON escapes (JSON.stringify never writes these, another writer might).
    const escaped = await acceptInvite(owner.email);
    await (await h.db()).prepare("UPDATE sites SET facts_json = ? WHERE id = ?").bind(String.raw`{"businessName":"Caf\u00e9 \u00d1and\u00fa"}`, escaped).run();
    const me = await json<{ sites: Array<{ id: string; businessName: unknown }> }>(await h.call("GET", "/api/me", { cookie: owner.cookie }));
    expect(Object.fromEntries(me.sites.map((site) => [site.id, site.businessName]))).toEqual({
      [saved[0]![0]]: `Joe's "Best" Plumbing`,
      [saved[1]![0]]: "Café Ñandú",
      [saved[2]![0]]: null,
      [saved[3]![0]]: null,
      [escaped]: "Café Ñandú",
    });
  });

  it("show each owner only their own sites on /api/me", async () => {
    const owners = [await h.signIn(), await h.signIn()];
    for (const owner of owners) {
      const me = await json<{ owner: { id: string }; sites: Array<{ id: string }> }>(await h.call("GET", "/api/me", { cookie: owner.cookie }));
      expect(me.owner.id).toBe(owner.ownerId);
      expect(me.sites.map((site) => site.id)).toEqual([owner.siteId]);
    }
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

  // F12: the route's own checks turn later requests away before the claim, so only a direct second claim of the same
  // hash shows whether the claim itself is single use (§5.1).
  it("claims an invite once: a second claim of the same hash changes no row", async () => {
    const token = await h.invite("claim-twice@example.com");
    const hash = await sha256Hex(token);
    const db = await h.db();
    expect(await claimInvite(db, hash, Date.now())).toBe(true);
    expect(await claimInvite(db, hash, Date.now())).toBe(false);
    expect(await db.prepare("SELECT used_at FROM invites WHERE token_hash = ?").bind(hash).first()).toEqual({ used_at: expect.any(Number) });
  });

  it("claims no invite that is revoked or expired", async () => {
    const db = await h.db();
    for (const [email, column] of [["claim-revoked@example.com", "revoked_at"], ["claim-expired@example.com", "expires_at"]] as const) {
      const hash = await sha256Hex(await h.invite(email));
      await db.prepare(`UPDATE invites SET ${column} = 1 WHERE token_hash = ?`).bind(hash).run();
      expect([email, await claimInvite(db, hash, Date.now())]).toEqual([email, false]);
    }
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

  it("checks for a disabled owner before the invite's state, leaving used, revoked and expired to the claim", async () => {
    const first = await h.signIn("disabled-expired@example.com");
    const db = await h.db();
    await db.prepare("UPDATE owners SET disabled_at = 1 WHERE id = ?").bind(first.ownerId).run();
    const token = await h.invite("disabled-expired@example.com");
    await db.prepare("UPDATE invites SET expires_at = 1 WHERE token_hash = ?").bind(await sha256Hex(token)).run();
    const res = await h.call("POST", "/api/auth/invite/accept", { body: { token }, ip: nextIp() });
    expect(res.status).toBe(403);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("owner_disabled");
  });

  it("gives an existing owner a second site from a second invite", async () => {
    const first = await h.signIn("two-sites@example.com");
    const token = await h.invite("two-sites@example.com");
    const res = await h.call("POST", "/api/auth/invite/accept", { body: { token }, ip: nextIp() });
    const second = await json<{ owner: { id: string }; siteId: string }>(res);
    expect(second.owner.id).toBe(first.ownerId);
    expect(second.siteId).not.toBe(first.siteId);
  });

  it("links the invite to its owner and the new site", async () => {
    const owner = await h.signIn("linked@example.com");
    const row = await (await h.db()).prepare("SELECT owner_id, site_id, used_at FROM invites WHERE email = ?").bind("linked@example.com").first();
    expect(row).toEqual({ owner_id: owner.ownerId, site_id: owner.siteId, used_at: expect.any(Number) });
  });

  it("releases the invite when its batch fails, so the same link works again", async () => {
    const token = await h.invite("retry@example.com");
    await withTrigger(
      "fail_site",
      "CREATE TRIGGER fail_site BEFORE INSERT ON sites WHEN (SELECT email FROM owners WHERE id = NEW.owner_id) = 'retry@example.com' BEGIN SELECT RAISE(ABORT, 'test failure'); END",
      async () => {
        expect((await h.call("POST", "/api/auth/invite/accept", { body: { token }, ip: nextIp() })).status).toBe(500);
      },
    );
    const db = await h.db();
    expect(await db.prepare("SELECT used_at, owner_id, site_id FROM invites WHERE email = ?").bind("retry@example.com").first()).toEqual({ used_at: null, owner_id: null, site_id: null });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM owners WHERE email = ?").bind("retry@example.com").first()).toEqual({ n: 0 });
    expect((await h.call("POST", "/api/auth/invite/accept", { body: { token }, ip: nextIp() })).status).toBe(200);
  });

  it("keeps the invite spent when its batch saved and a later step failed, so a second click makes no second site", async () => {
    const token = await h.invite("saved@example.com");
    // The owner is renamed inside the batch, so the batch saves and reading the owner back afterwards fails.
    await withTrigger(
      "rename_owner",
      "CREATE TRIGGER rename_owner AFTER INSERT ON audit_log WHEN NEW.action = 'invite.accepted' BEGIN UPDATE owners SET email = 'saved-renamed@example.com' WHERE email = 'saved@example.com'; END",
      async () => {
        expect((await h.call("POST", "/api/auth/invite/accept", { body: { token }, ip: nextIp() })).status).toBe(500);
      },
    );
    const db = await h.db();
    const invite = await db.prepare("SELECT used_at, site_id FROM invites WHERE email = ?").bind("saved@example.com").first<{ used_at: number | null; site_id: string | null }>();
    expect(invite?.used_at).toEqual(expect.any(Number));
    expect(invite?.site_id).toEqual(expect.any(String));
    const again = await h.call("POST", "/api/auth/invite/accept", { body: { token }, ip: nextIp() });
    expect(again.status).toBe(410);
    const sites = "SELECT COUNT(*) AS n FROM sites s JOIN owners o ON o.id = s.owner_id WHERE o.email IN ('saved@example.com', 'saved-renamed@example.com')";
    expect(await db.prepare(sites).bind().first()).toEqual({ n: 1 });
  });

  it("stores no site, session or audit row when the owner is disabled after the check and before the batch, and releases the invite", async () => {
    const email = "race-disabled@example.com";
    const first = await h.signIn(email);
    const token = await h.invite(email);
    // The admin's disable lands after step (0)'s check and the claim, just before the batch: the test
    // Worker runs it right before the request's next D1 batch.
    expect((await h.call("POST", "/__test/disable-before-batch", { body: { email } })).status).toBe(200);
    const res = await h.call("POST", "/api/auth/invite/accept", { body: { token }, ip: nextIp() });
    expect(res.status).toBe(403);
    expect((await json<ErrorJson>(res)).error.code).toBe("owner_disabled");
    expect(res.headers.get("Set-Cookie")).toBeNull();
    const db = await h.db();
    expect(await db.prepare("SELECT disabled_at FROM owners WHERE id = ?").bind(first.ownerId).first()).toEqual({ disabled_at: expect.any(Number) });
    expect((await db.prepare("SELECT id FROM sites WHERE owner_id = ?").bind(first.ownerId).all()).results).toEqual([{ id: first.siteId }]);
    expect(await sessionHashes(first.ownerId)).toEqual([await sha256Hex(cookieValue(first.cookie))]);
    const accepted = await db.prepare("SELECT site_id FROM audit_log WHERE action = 'invite.accepted' AND actor = ?").bind(`owner:${first.ownerId}`).all();
    expect(accepted.results).toEqual([{ site_id: first.siteId }]);
    // Nothing links the invite to a site, so P4-8's release (only while site_id IS NULL) reopens it.
    const invite = await db.prepare("SELECT used_at, owner_id, site_id FROM invites WHERE token_hash = ?").bind(await sha256Hex(token)).first();
    expect(invite).toEqual({ used_at: null, owner_id: null, site_id: null });
  });

  it("hands the claim-to-batch work to waitUntil as well, so a client that goes away cannot stop it halfway", async () => {
    const before = await h.waitUntilCount("/api/auth/invite/accept");
    await h.signIn();
    expect(await h.waitUntilCount("/api/auth/invite/accept")).toBe(before + 1);
  });
});

describe("magic-link sign-in", () => {
  it("always answers 202, and emails a link only to a known owner", async () => {
    await h.signIn("known@example.com");
    for (const email of ["known@example.com", "nobody@example.com"]) {
      const res = await h.login(email);
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
    await h.login("LINK@example.com");
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

  it("gives a cookie that opens /api/me, and stores only the hash of that cookie's token", async () => {
    const owner = await h.signIn("cookie@example.com");
    await h.login("cookie@example.com");
    const token = tokenIn((await waitForEmail("cookie@example.com"))[0]?.text ?? "", "login");
    const verifiedBefore = await h.waitUntilCount("/api/auth/login/verify");
    const res = await h.call("POST", "/api/auth/login/verify", { body: { token }, ip: nextIp() });
    expect(res.status).toBe(200);
    const cookie = (res.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
    const me = await h.call("GET", "/api/me", { cookie });
    expect(me.status).toBe(200);
    expect((await json<{ owner: { id: string } }>(me)).owner.id).toBe(owner.ownerId);
    expect(await sessionHashes(owner.ownerId)).toContain(await sha256Hex(cookieValue(cookie)));
    // The claim-to-batch work is also handed to waitUntil, so a client that goes away cannot stop it halfway.
    expect(await h.waitUntilCount("/api/auth/login/verify")).toBe(verifiedBefore + 1);
  });

  it("refuses an expired sign-in link with 410", async () => {
    const owner = await h.signIn("late@example.com");
    await h.login("late@example.com");
    const token = tokenIn((await waitForEmail("late@example.com"))[0]?.text ?? "", "login");
    await (await h.db()).prepare("UPDATE login_tokens SET expires_at = 1 WHERE owner_id = ?").bind(owner.ownerId).run();
    const res = await h.call("POST", "/api/auth/login/verify", { body: { token }, ip: nextIp() });
    expect(res.status).toBe(410);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("token_invalid");
  });

  it("sends at most 5 links per owner per hour", async () => {
    await h.signIn("capped@example.com");
    for (let i = 0; i < 7; i += 1) await h.login("capped@example.com");
    await waitForEmail("capped@example.com", 5);
    await new Promise((r) => setTimeout(r, 500));
    expect(await outbox("capped@example.com")).toHaveLength(5);
  });

  it("refuses a disabled owner's link with 403, storing no session and no sign-in audit row", async () => {
    const owner = await h.signIn("gone@example.com");
    await h.login("gone@example.com");
    const token = tokenIn((await waitForEmail("gone@example.com"))[0]?.text ?? "", "login");
    await (await h.db()).prepare("UPDATE owners SET disabled_at = 1 WHERE id = ?").bind(owner.ownerId).run();
    const res = await h.call("POST", "/api/auth/login/verify", { body: { token }, ip: nextIp() });
    expect(res.status).toBe(403);
    expect((await json<ErrorJson>(res)).error.code).toBe("owner_disabled");
    expect(await sessionHashes(owner.ownerId)).toEqual([await sha256Hex(cookieValue(owner.cookie))]);
    const audit = await (await h.db()).prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.login' AND actor = ?").bind(`owner:${owner.ownerId}`).first();
    expect(audit).toEqual({ n: 0 });
  });

  it("sends no link to a disabled owner", async () => {
    const owner = await h.signIn("off@example.com");
    await (await h.db()).prepare("UPDATE owners SET disabled_at = 1 WHERE id = ?").bind(owner.ownerId).run();
    expect((await h.login("off@example.com")).status).toBe(202);
    await h.backgroundDone("/api/auth/login");
    expect(await tokenRows(owner.ownerId)).toEqual([]);
    expect(await outbox("off@example.com")).toEqual([]);
  });

  it("counts 10 links per owner per day apart from the 5 per hour (controlled time)", async () => {
    const email = "daily@example.com";
    const owner = await h.signIn(email);
    const loginFive = async () => {
      for (let i = 0; i < LIMITS.loginTokensPerOwnerPerHour; i += 1) expect((await h.login(email)).status).toBe(202);
      await h.backgroundDone("/api/auth/login");
    };
    // Hour 1: five links, then three hours pass.
    await loginFive();
    expect(await tokenRows(owner.ownerId)).toHaveLength(5);
    await ageTokens(owner.ownerId, 3 * HOUR_MS);
    // Hour 2: five more, all sent (the hourly cap starts again), then two hours pass for them.
    await loginFive();
    expect(await outbox(email)).toHaveLength(10);
    await ageTokens(owner.ownerId, 2 * HOUR_MS, Date.now() - HOUR_MS);
    // Hour 3: none in the last hour, but ten in the last day, so the 11th is refused, with the same 202.
    const eleventh = await h.login(email);
    expect(eleventh.status).toBe(202);
    expect(await eleventh.json()).toEqual({ ok: true });
    await h.backgroundDone("/api/auth/login");
    expect(await tokenRows(owner.ownerId)).toHaveLength(10);
    expect(await outbox(email)).toHaveLength(10);
    // A day after the first ten, links are sent again.
    await ageTokens(owner.ownerId, DAY_MS);
    await h.login(email);
    await h.backgroundDone("/api/auth/login");
    expect(await tokenRows(owner.ownerId)).toHaveLength(11);
    expect(await outbox(email)).toHaveLength(11);
  });

  it("deletes a link whose email failed, so failures never use up the owner's links", async () => {
    const owner = await h.signIn("broken@mail-fails.example");
    h.server.clearLogs();
    for (let i = 0; i <= LIMITS.loginTokensPerOwnerPerHour; i += 1) {
      await h.login("broken@mail-fails.example");
      await h.backgroundDone("/api/auth/login");
    }
    const failures = h.logLines().filter((line) => line["event"] === "email_failed");
    expect(failures).toEqual(Array.from({ length: LIMITS.loginTokensPerOwnerPerHour + 1 }, () => ({ event: "email_failed", tag: "magic_link", error: "rejected" })));
    expect(await tokenRows(owner.ownerId)).toEqual([]);
  });

  // (The http scheme is covered in packages/app-common/test/http.test.ts: through the local test runtime an Origin of
  // http://app.localhost:8787 reaches the Worker accepted, measured 2026-10-01, so this file cannot tell it apart.)
  // F10: the second CSRF test at the auth routes (logout has one in "sessions"): a foreign Origin never reaches login.
  it("refuses a sign-in request from another site (Origin check) before the security check, any lookup or any email", async () => {
    const owner = await h.signIn("csrf@example.com");
    const seen = (await h.siteverifyCalls()).length;
    h.server.clearLogs();
    for (const origin of ["https://evil.example", "null", `${APP_ORIGIN}/`, "https://app.localhost:8788"]) {
      const res = await h.call("POST", "/api/auth/login", { body: { email: "csrf@example.com" }, ip: nextIp(), origin, headers: { "x-turnstile-token": TURNSTILE_DUMMY_TOKEN } });
      expect([origin, res.status]).toEqual([origin, 403]);
      expect((await json<ErrorJson>(res)).error.code).toBe("forbidden");
    }
    expect((await h.siteverifyCalls()).length).toBe(seen);
    expect(await tokenRows(owner.ownerId)).toEqual([]);
    expect(await outbox("csrf@example.com")).toEqual([]);
  });

  // F11: with one owner, a token-to-owner read that is not keyed on the token still returns that owner. Two owners tell them apart.
  it("signs each of two owners in as themselves, each with their own link", async () => {
    const first = await h.signIn("first-link@example.com");
    const second = await h.signIn("second-link@example.com");
    await h.login("first-link@example.com");
    await h.login("second-link@example.com");
    const firstToken = tokenIn((await waitForEmail("first-link@example.com"))[0]?.text ?? "", "login");
    const secondToken = tokenIn((await waitForEmail("second-link@example.com"))[0]?.text ?? "", "login");
    const verified: Array<{ id: string; email: string }> = [];
    for (const token of [firstToken, secondToken]) {
      const res = await h.call("POST", "/api/auth/login/verify", { body: { token }, ip: nextIp() });
      expect(res.status).toBe(200);
      verified.push((await json<{ owner: { id: string; email: string } }>(res)).owner);
      const me = await h.call("GET", "/api/me", { cookie: (res.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "" });
      expect((await json<{ owner: { id: string } }>(me)).owner.id).toBe(verified.at(-1)?.id);
    }
    expect(verified).toEqual([
      { id: first.ownerId, email: "first-link@example.com" },
      { id: second.ownerId, email: "second-link@example.com" },
    ]);
  });

  // F26: after an "unavailable" (a 5xx) the provider may have delivered, so the link must still work and still count.
  it("keeps the link, and its place in the caps, when the email service was unavailable", async () => {
    const owner = await h.signIn("flaky@mail-unavailable.example");
    h.server.clearLogs();
    await h.login("flaky@mail-unavailable.example");
    await h.backgroundDone("/api/auth/login");
    expect(h.logLines().filter((line) => line["event"] === "email_failed")).toEqual([{ event: "email_failed", tag: "magic_link", error: "unavailable" }]);
    expect(await tokenRows(owner.ownerId)).toHaveLength(1);
  });

  it("logs a sign-in link job that failed as one line, without the address", async () => {
    const owner = await h.signIn("jobfails@example.com");
    h.server.clearLogs();
    await withTrigger(
      "fail_token",
      `CREATE TRIGGER fail_token BEFORE INSERT ON login_tokens WHEN NEW.owner_id = '${owner.ownerId}' BEGIN SELECT RAISE(ABORT, 'test failure'); END`,
      async () => {
        expect((await h.login("jobfails@example.com")).status).toBe(202);
        await h.backgroundDone("/api/auth/login");
      },
    );
    expect(h.logLines().filter((line) => "event" in line)).toEqual([{ event: "login_link_failed", error: "Error" }]);
    expect(h.server.getLogs().map((entry) => entry.message).join("\n")).not.toContain("jobfails");
  });
});

describe("Turnstile on sign-in (A11)", () => {
  async function refused(res: Response): Promise<void> {
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "forbidden", message: "Please complete the security check and try again." } });
  }

  it("refuses a request without a token before any lookup, write, email or siteverify call", async () => {
    const owner = await h.signIn("no-token@example.com");
    const calls = (await h.siteverifyCalls()).length;
    const background = await h.waitUntilCount("/api/auth/login");
    await refused(await h.login("no-token@example.com", { turnstile: null }));
    expect((await h.siteverifyCalls()).length).toBe(calls);
    expect(await h.waitUntilCount("/api/auth/login")).toBe(background);
    expect(await tokenRows(owner.ownerId)).toEqual([]);
  });

  it("refuses a token siteverify rejects, with no link written or sent (other hosts and actions: turnstile-live.workerd.test.ts)", async () => {
    const owner = await h.signIn("bad-token@example.com");
    const background = await h.waitUntilCount("/api/auth/login");
    await refused(await h.login("bad-token@example.com", { turnstile: "always-fails" }));
    expect(await h.waitUntilCount("/api/auth/login")).toBe(background);
    expect(await tokenRows(owner.ownerId)).toEqual([]);
    expect(await outbox("bad-token@example.com")).toEqual([]);
  });

  it("sends siteverify the secret, the token, the visitor's address and a new idempotency key each time, then signs in", async () => {
    await h.signIn("good-token@example.com");
    const seen = (await h.siteverifyCalls()).length;
    for (const ip of ["192.0.2.201", "2001:db8:5::1"]) expect((await h.login("good-token@example.com", { ip })).status).toBe(202);
    const calls = (await h.siteverifyCalls()).slice(seen);
    expect(calls).toEqual([
      { response: TURNSTILE_DUMMY_TOKEN, remoteip: "192.0.2.201", idempotencyKey: expect.stringMatching(UUID), testSecret: true },
      { response: TURNSTILE_DUMMY_TOKEN, remoteip: "2001:db8:5::1", idempotencyKey: expect.stringMatching(UUID), testSecret: true },
    ]);
    expect(calls[0]?.idempotencyKey).not.toBe(calls[1]?.idempotencyKey);
    await waitForEmail("good-token@example.com", 2);
  });

  it("calls siteverify as a plain function, the way workerd's global fetch must be called (no Illegal invocation)", async () => {
    // The test Worker's siteverify first calls the real global fetch with the `this` it was called with
    // (an already aborted request to a .invalid host, so nothing leaves the runtime). The check is real here:
    // a plain call only reports the abort, while a call as a method of another object throws.
    expect(await json(await h.call("GET", "/__test/fetch-receiver"))).toEqual({ plain: "AbortError", asMethod: expect.stringContaining("Illegal invocation") });
    await h.signIn("plain-call@example.com");
    expect((await h.login("plain-call@example.com")).status).toBe(202);
    await waitForEmail("plain-call@example.com");
  });

  it("tries once more after a 5 s timeout, with the same idempotency key, and then signs in", async () => {
    await h.signIn("slow@example.com");
    const seen = (await h.siteverifyCalls()).length;
    const started = Date.now();
    expect((await h.login("slow@example.com", { turnstile: "slow-once" })).status).toBe(202);
    expect(Date.now() - started).toBeGreaterThanOrEqual(5_000);
    expect(Date.now() - started).toBeLessThan(10_000);
    const calls = (await h.siteverifyCalls()).slice(seen);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.idempotencyKey).toBe(calls[0]?.idempotencyKey);
    await waitForEmail("slow@example.com");
  });

  it("gives up on a siteverify that never answers after the timeout and one retry, so the check ends in a bounded time", async () => {
    // The probe runs the Turnstile check against a siteverify that never answers, with a 200 ms timeout
    // instead of production's 5 s (which it reports), so this test stays fast.
    const started = Date.now();
    const res = await h.call("POST", "/__test/turnstile-never?timeoutMs=200", { headers: { "x-turnstile-token": "never" } });
    const elapsed = Date.now() - started;
    expect(await json(res)).toEqual({ refused: "forbidden", calls: 2, abandoned: [true, true], defaultTimeoutMs: 5_000 });
    expect(elapsed).toBeGreaterThanOrEqual(2 * 200);
    expect(elapsed).toBeLessThan(2 * 200 + 2_000);
  });

  it("tries once more when siteverify reports its own internal error, as its docs advise", async () => {
    await h.signIn("busy@example.com");
    const seen = (await h.siteverifyCalls()).length;
    expect((await h.login("busy@example.com", { turnstile: "busy-once" })).status).toBe(202);
    const calls = (await h.siteverifyCalls()).slice(seen);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.idempotencyKey).toBe(calls[0]?.idempotencyKey);
  });

  it("refuses a token longer than siteverify's 2,048-character maximum without calling it", async () => {
    const seen = (await h.siteverifyCalls()).length;
    await refused(await h.login("long@example.com", { turnstile: "a".repeat(2_049) }));
    expect((await h.siteverifyCalls()).length).toBe(seen);
  });

  it("fails closed when siteverify cannot answer twice: 403 after exactly one retry with the same key", async () => {
    const owner = await h.signIn("down@example.com");
    const seen = (await h.siteverifyCalls()).length;
    await refused(await h.login("down@example.com", { turnstile: "down" }));
    const calls = (await h.siteverifyCalls()).slice(seen);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.idempotencyKey).toBe(calls[0]?.idempotencyKey);
    expect(await tokenRows(owner.ownerId)).toEqual([]);
  });

  it("writes one log line per refusal, naming the reason and never the token, email or address", async () => {
    h.server.clearLogs();
    for (const turnstile of [null, "always-fails", "down"]) await refused(await h.login("quiet@example.com", { turnstile, ip: "192.0.2.77" }));
    const lines = h.logLines().filter((line) => line["route"] === "POST /api/auth/login");
    expect(lines).toEqual(
      ["missing", "rejected", "unavailable"].map((reason) => ({ route: "POST /api/auth/login", status: 403, ms: expect.any(Number), code: "forbidden", turnstile: reason })),
    );
    expect(h.server.getLogs().map((entry) => entry.message).join("\n")).not.toMatch(/quiet@|192\.0\.2\.77|always-fails/);
  });

  it("accepts Cloudflare's test-key result (the real answer: success only, no action, host name example.com) in development on a *.localhost host", async () => {
    await h.signIn("test-key@example.com");
    expect(new URL(APP_ORIGIN).hostname).not.toBe("example.com");
    expect((await h.login("test-key@example.com")).status).toBe(202);
    await waitForEmail("test-key@example.com");
  });

  it("accepts the test-key result when the CONFIGURED host is local even if the request Host is not: the request Host is never used", async () => {
    await h.signIn("forged@example.com");
    for (const host of ["https://example.com", "https://localhost:8787", "https://app.localhost.example"]) {
      const res = await h.server.fetch(`${host}/api/auth/login`, {
        method: "POST",
        headers: { Origin: APP_ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": nextIp(), "x-turnstile-token": TURNSTILE_DUMMY_TOKEN },
        body: JSON.stringify({ email: "forged@example.com" }),
      });
      expect(res.status).toBe(202);
    }
  });
});

describe("sessions", () => {
  const EXPIRED_COOKIE = "__Host-asksite_sid=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0";

  /** Design §4.4: logout takes a session or none, and always answers 204 with the cookie expired. */
  async function loggedOut(res: Response): Promise<void> {
    expect(res.status).toBe(204);
    expect(res.headers.get("Set-Cookie")).toBe(EXPIRED_COOKIE);
    expect(await res.text()).toBe("");
  }

  it("logout deletes the session and expires the cookie", async () => {
    const owner = await h.signIn();
    await loggedOut(await h.call("POST", "/api/auth/logout", { cookie: owner.cookie, ip: nextIp() }));
    expect(await sessionHashes(owner.ownerId)).toEqual([]);
    expect((await h.call("GET", "/api/me", { cookie: owner.cookie })).status).toBe(401);
  });

  it("logout without a cookie still answers 204 and expires the cookie", async () => {
    await loggedOut(await h.call("POST", "/api/auth/logout", { ip: nextIp() }));
  });

  it("logout with an unknown or malformed session token still answers 204 and expires the cookie", async () => {
    for (const token of ["A".repeat(43), "not-a-token"]) {
      await loggedOut(await h.call("POST", "/api/auth/logout", { cookie: `__Host-asksite_sid=${token}`, ip: nextIp() }));
    }
  });

  it("logout of an expired session deletes it and expires the cookie", async () => {
    const owner = await h.signIn();
    await (await h.db()).prepare("UPDATE sessions SET expires_at = 1 WHERE owner_id = ?").bind(owner.ownerId).run();
    await loggedOut(await h.call("POST", "/api/auth/logout", { cookie: owner.cookie, ip: nextIp() }));
    expect(await sessionHashes(owner.ownerId)).toEqual([]);
  });

  it("logout of a disabled owner's session deletes it and expires the cookie", async () => {
    const owner = await h.signIn();
    await (await h.db()).prepare("UPDATE owners SET disabled_at = 1 WHERE id = ?").bind(owner.ownerId).run();
    await loggedOut(await h.call("POST", "/api/auth/logout", { cookie: owner.cookie, ip: nextIp() }));
    expect(await sessionHashes(owner.ownerId)).toEqual([]);
  });

  it("logout deletes only the session its cookie names", async () => {
    const owner = await h.signIn();
    await acceptInvite(owner.email); // a second invite gives the same owner a second session (another device)
    expect(await sessionHashes(owner.ownerId)).toHaveLength(2);
    await loggedOut(await h.call("POST", "/api/auth/logout", { cookie: owner.cookie, ip: nextIp() }));
    const left = await sessionHashes(owner.ownerId);
    expect(left).toHaveLength(1);
    expect(left).not.toContain(await sha256Hex(cookieValue(owner.cookie)));
  });

  it("logout still answers 204 with the expired cookie when deleting the session fails, and its one log line says so", async () => {
    const owner = await h.signIn();
    h.server.clearLogs();
    await withTrigger(
      "fail_logout",
      `CREATE TRIGGER fail_logout BEFORE DELETE ON sessions WHEN OLD.owner_id = '${owner.ownerId}' BEGIN SELECT RAISE(ABORT, 'test failure'); END`,
      async () => {
        await loggedOut(await h.call("POST", "/api/auth/logout", { cookie: owner.cookie, ip: nextIp() }));
      },
    );
    // The row neither DELETE could remove is still there (it lives up to 30 days); the browser's cookie is gone.
    expect(await sessionHashes(owner.ownerId)).toEqual([await sha256Hex(cookieValue(owner.cookie))]);
    const lines = h.logLines().filter((line) => line["route"] === "POST /api/auth/logout");
    expect(lines).toEqual([{ route: "POST /api/auth/logout", status: 204, ms: expect.any(Number), event: "session_delete_failed", error: "Error" }]);
    expect(h.server.getLogs().map((entry) => entry.message).join("\n")).not.toContain(cookieValue(owner.cookie));
  });

  // F4: a session the owner signed out of must not stay valid for 30 days because one DELETE failed.
  it("logout retries a failed session delete once in the background, so the session is gone", async () => {
    const owner = await h.signIn();
    await h.call("POST", "/__test/session-delete-fails", { body: { times: 1 } });
    await loggedOut(await h.call("POST", "/api/auth/logout", { cookie: owner.cookie, ip: nextIp() }));
    await eventually(() => sessionHashes(owner.ownerId), (left) => left.length === 0, "the retry to delete the session");
  });

  it("logout logs the retry's own line when the second delete fails too", async () => {
    const owner = await h.signIn();
    h.server.clearLogs();
    await withTrigger(
      "fail_logout_twice",
      `CREATE TRIGGER fail_logout_twice BEFORE DELETE ON sessions WHEN OLD.owner_id = '${owner.ownerId}' BEGIN SELECT RAISE(ABORT, 'test failure'); END`,
      async () => {
        await loggedOut(await h.call("POST", "/api/auth/logout", { cookie: owner.cookie, ip: nextIp() }));
        const lines = await eventually(() => h.logLines().filter((line) => line["event"] === "session_delete_retry_failed"), (found) => found.length > 0, "the retry's log line");
        expect(lines).toEqual([{ event: "session_delete_retry_failed", error: "Error" }]);
      },
    );
  });

  it("logout from another site is refused like every change (Origin check), and the session stays", async () => {
    const owner = await h.signIn();
    const res = await h.call("POST", "/api/auth/logout", { cookie: owner.cookie, ip: nextIp(), origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect((await json<ErrorJson>(res)).error.code).toBe("forbidden");
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(await sessionHashes(owner.ownerId)).toEqual([await sha256Hex(cookieValue(owner.cookie))]);
  });

  it("logout is not counted by AUTH_RL: it works from an address that has used up its auth requests", async () => {
    const owner = await h.signIn();
    const ip = "203.0.113.88";
    const statuses: number[] = [];
    await awayFromMinuteBoundary();
    for (let i = 0; i < 11; i += 1) statuses.push((await h.login("z@example.com", { ip })).status);
    expect(statuses[10]).toBe(429);
    expect((await h.call("POST", "/api/auth/logout", { cookie: owner.cookie, ip })).status).toBe(204);
  });

  it("API_RL refuses an owner's requests past its configured limit in a minute, but never their sign-out", async () => {
    const owner = await h.signIn();
    // The burst took 1.0-4.1 s at a load average of about 80 (measured), so it gets 20 s of the minute.
    await awayFromMinuteBoundary(20_000);
    const statuses = await Promise.all(Array.from({ length: API_RL_LIMIT }, async () => (await h.call("GET", "/api/me", { cookie: owner.cookie })).status));
    expect(statuses.filter((status) => status === 200)).toHaveLength(API_RL_LIMIT);
    const over = await h.call("GET", "/api/me", { cookie: owner.cookie });
    expect(over.status).toBe(429);
    expect(over.headers.get("Retry-After")).toBe("60");
    await loggedOut(await h.call("POST", "/api/auth/logout", { cookie: owner.cookie, ip: nextIp() }));
    expect(await sessionHashes(owner.ownerId)).toEqual([]);
  }, 60_000);

  it("an expired session is refused", async () => {
    const owner = await h.signIn();
    await (await h.db()).prepare("UPDATE sessions SET expires_at = 1 WHERE owner_id = ?").bind(owner.ownerId).run();
    expect((await h.call("GET", "/api/me", { cookie: owner.cookie })).status).toBe(401);
  });

  it("AUTH_RL refuses the 11th auth request in a minute from one address", async () => {
    const ip = "203.0.113.77";
    const statuses: number[] = [];
    await awayFromMinuteBoundary();
    for (let i = 0; i < 11; i += 1) statuses.push((await h.login("x@example.com", { ip })).status);
    expect(statuses.slice(0, 10).every((s) => s === 202)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("AUTH_RL counts every IPv6 address of one /64 network together", async () => {
    const statuses: number[] = [];
    await awayFromMinuteBoundary();
    for (let i = 1; i <= 11; i += 1) statuses.push((await h.login("y@example.com", { ip: `2001:db8:77:1::${i.toString(16)}` })).status);
    expect(statuses.slice(0, 10).every((s) => s === 202)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect((await h.login("y@example.com", { ip: "2001:db8:77:2::1" })).status).toBe(202);
  });
});
