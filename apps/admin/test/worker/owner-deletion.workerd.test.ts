import { describe, expect, it } from "vitest";
import { json, useAdminHarness } from "../support/harness.ts";

// Delete the account (owner data deletion, spec §7.7), through the admin Worker with the REAL deleteOwner (test/support/fakes.ts).
// Part 1's own suite (packages/publishing/test/owner-deletion.workerd.test.ts) proves what is deleted; this proves the route:
// its body, its answers, its place behind the gate, and that enable and disable refuse once a deletion started.
const h = useAdminHarness();

const UNKNOWN = "00000000-0000-4000-8000-000000000000";
const REASON = "Closure request from Joe's Plumbing";

interface ErrorJson {
  error: { code: string; message: string; issues?: Array<{ path: string[]; code: string; message: string }>; retryAfter?: number };
}

type Site = Awaited<ReturnType<typeof h.pendingSite>>;

/** A live site (approved through the route) with a stored photo, an uploads row and a lead: what a deletion has to remove. */
async function liveSite(): Promise<Site> {
  const site = await h.pendingSite();
  expect((await h.call("POST", `/api/admin/versions/${site.versionId}/approve`, { body: { htmlSha256: site.htmlSha256 } })).status).toBe(200);
  const db = await h.db();
  const photo = crypto.randomUUID();
  await (await h.r2("MEDIA")).put(`${site.siteId}/${photo}.bin`, "photo");
  await db.prepare("INSERT INTO uploads (id, site_id, width, height, bytes, created_at) VALUES (?, ?, 1, 1, 5, ?)").bind(photo, site.siteId, Date.now()).run();
  await db
    .prepare("INSERT INTO leads (id, site_id, created_at, name, phone, email_status, ip_hash) VALUES (?, ?, ?, 'Visitor', '+15125550100', 'sent', 'hash')")
    .bind(crypto.randomUUID(), site.siteId, Date.now())
    .run();
  return site;
}

const disable = (ownerId: string, headers?: Record<string, string>) => h.call("POST", `/api/admin/owners/${ownerId}/disable`, { body: { reason: REASON }, ...(headers === undefined ? {} : { headers }) });
const enable = (ownerId: string, headers?: Record<string, string>) => h.call("POST", `/api/admin/owners/${ownerId}/enable`, { body: {}, ...(headers === undefined ? {} : { headers }) });
const del = (ownerId: string, confirmEmail: string, headers?: Record<string, string>) =>
  h.call("POST", `/api/admin/owners/${ownerId}/delete`, { body: { confirmEmail }, ...(headers === undefined ? {} : { headers }) });

/** The audit rows that name an owner (its ownerId in the detail) or one of its sites, oldest first. */
async function auditOf(ownerId: string, ...siteIds: string[]): Promise<Array<{ action: string; actor: string; site_id: string | null; detail_json: string | null }>> {
  const db = await h.db();
  const marks = siteIds.map(() => "?").join(", ");
  const { results } = await db
    .prepare(`SELECT action, actor, site_id, detail_json FROM audit_log WHERE json_extract(detail_json, '$.ownerId') = ?${siteIds.length === 0 ? "" : ` OR site_id IN (${marks})`} ORDER BY id`)
    .bind(ownerId, ...siteIds)
    .all<{ action: string; actor: string; site_id: string | null; detail_json: string | null }>();
  return results;
}

/** Every row of the owner and its site, and every stored object of the site, as one string: what "nothing changed" and "byte-identical" compare. */
async function dump(site: Site): Promise<string> {
  const db = await h.db();
  const one = async (sql: string, ...values: unknown[]) => (await db.prepare(sql).bind(...values).all()).results;
  const objects = async (bucket: "WORK" | "LIVE" | "MEDIA", prefix: string) => {
    const r2 = await h.r2(bucket);
    const { objects: listed } = await r2.list({ prefix });
    return Promise.all(listed.map(async (o) => [o.key, await (await r2.get(o.key))?.text()]));
  };
  return JSON.stringify([
    await one("SELECT * FROM owners WHERE id = ?", site.ownerId),
    await one("SELECT * FROM sites WHERE id = ?", site.siteId),
    await one("SELECT * FROM site_versions WHERE site_id = ? ORDER BY id", site.siteId),
    await one("SELECT * FROM generations WHERE site_id = ? ORDER BY id", site.siteId),
    await one("SELECT * FROM uploads WHERE site_id = ? ORDER BY id", site.siteId),
    await one("SELECT * FROM leads WHERE site_id = ? ORDER BY id", site.siteId),
    await one("SELECT * FROM invites WHERE owner_id = ? OR email = ? ORDER BY id", site.ownerId, site.email),
    await objects("WORK", `versions/${site.siteId}/`),
    await objects("LIVE", site.slug),
    await objects("MEDIA", `${site.siteId}/`),
  ]);
}

const count = async (sql: string, ...values: unknown[]): Promise<number> => ((await (await h.db()).prepare(sql).bind(...values).first<{ n: number }>())?.n ?? -1);

describe("POST /api/admin/owners/:ownerId/delete: the body and the id", () => {
  it("answers 422 for a missing, empty, blank or extra field and 404 for a non-UUID or unknown id, and writes no audit row", async () => {
    const site = await liveSite();
    const before = await dump(site);
    const audits = async () => (await auditOf(site.ownerId, site.siteId)).length;
    const auditsBefore = await audits();
    const path = `/api/admin/owners/${site.ownerId}/delete`;
    for (const body of [{}, { confirmEmail: "" }, { confirmEmail: "   " }, { confirmEmail: site.email, extra: 1 }, { confirmEmail: "x".repeat(255) }, { confirmEmail: 5 }]) {
      const res = await h.call("POST", path, { body });
      expect([res.status, (await json<ErrorJson>(res)).error.code]).toEqual([422, "validation_failed"]);
    }
    for (const id of ["not-a-uuid", "ABC", UNKNOWN, site.siteId]) {
      const res = await h.call("POST", `/api/admin/owners/${id}/delete`, { body: { confirmEmail: site.email } });
      expect([res.status, (await json<ErrorJson>(res)).error.code]).toEqual([404, "not_found"]);
    }
    expect(await audits()).toBe(auditsBefore);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE detail_json LIKE ?", `%${UNKNOWN}%`)).toBe(0);
    expect(await dump(site)).toBe(before);
  });
});

describe("POST /api/admin/owners/:ownerId/delete: refusals", () => {
  it("is 409 while the owner is enabled, with the right email and with a WRONG email (not 422: the owner's state is checked first)", async () => {
    const site = await liveSite();
    const before = await dump(site);
    for (const email of [site.email, "someone.else@example.com"]) {
      const res = await del(site.ownerId, email);
      expect(res.status).toBe(409);
      expect((await json<ErrorJson>(res)).error).toMatchObject({ code: "conflict", message: "Disable the owner first. Only a disabled owner's account can be deleted." });
    }
    expect(await dump(site)).toBe(before);
    expect((await auditOf(site.ownerId)).map((a) => a.action)).not.toContain("owner.deletion_started");
  });

  it("is 409 not-disabled, with no Retry-After and the holder's lease untouched, while another action holds the site of an enabled owner", async () => {
    const site = await liveSite();
    const db = await h.db();
    await db.prepare("UPDATE sites SET admin_lock = 'holder', admin_lock_until = ? WHERE id = ?").bind(Date.now() + 60_000, site.siteId).run();
    const res = await del(site.ownerId, site.email);
    expect(res.status).toBe(409);
    expect(res.headers.get("Retry-After")).toBeNull();
    expect((await json<ErrorJson>(res)).error).toMatchObject({ code: "conflict", message: "Disable the owner first. Only a disabled owner's account can be deleted." });
    expect(await db.prepare("SELECT admin_lock FROM sites WHERE id = ?").bind(site.siteId).first()).toEqual({ admin_lock: "holder" });
  });

  it("is 422 on the field confirmEmail for a wrong email, and changes nothing", async () => {
    const site = await liveSite();
    expect((await disable(site.ownerId)).status).toBe(200);
    const before = await dump(site);
    const res = await del(site.ownerId, "someone.else@example.com");
    expect(res.status).toBe(422);
    const { error } = await json<ErrorJson>(res);
    expect(error).toMatchObject({ code: "validation_failed", message: "This is not the owner's email. Nothing was deleted." });
    expect(error.issues).toEqual([{ path: ["confirmEmail"], code: "email_mismatch", message: "This is not the owner's email. Nothing was deleted." }]);
    expect(await dump(site)).toBe(before);
    expect((await auditOf(site.ownerId)).map((a) => a.action)).not.toContain("owner.deletion_started");
  });

  it("is 409 with Retry-After while another action holds the site, and changes nothing: the other lease stays", async () => {
    const site = await liveSite();
    expect((await disable(site.ownerId)).status).toBe(200);
    const db = await h.db();
    await db.prepare("UPDATE sites SET admin_lock = 'holder', admin_lock_until = ? WHERE id = ?").bind(Date.now() + 60_000, site.siteId).run();
    const before = await dump(site);
    const res = await del(site.ownerId, site.email);
    expect(res.status).toBe(409);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await json<ErrorJson>(res)).error).toMatchObject({
      code: "conflict",
      message: "Another admin action on one of this owner's sites is still running. Nothing was deleted. Try again in a minute.",
    });
    expect(await dump(site)).toBe(before);
    expect(await db.prepare("SELECT admin_lock FROM sites WHERE id = ?").bind(site.siteId).first()).toEqual({ admin_lock: "holder" });
    expect((await auditOf(site.ownerId)).map((a) => a.action)).not.toContain("owner.deletion_started");
  });
});

describe("POST /api/admin/owners/:ownerId/delete: deleting", () => {
  it("deletes a disabled owner's account with everything in it, and leaves another owner byte-identical", async () => {
    const site = await liveSite();
    const control = await liveSite();
    const db = await h.db();
    // An open invite for the owner's email (it could re-create the account), and a sign-in session.
    expect((await h.call("POST", "/api/admin/invites", { body: { email: site.email } })).status).toBe(201);
    expect((await disable(site.ownerId)).status).toBe(200);
    const controlBefore = await dump(control);
    expect((await (await h.r2("WORK")).list({ prefix: `versions/${site.siteId}/` })).objects.length).toBeGreaterThan(0);
    expect(await h.liveKeys(site.slug)).not.toEqual([]);

    const res = await del(site.ownerId, site.email);
    expect(res.status).toBe(200);
    const body = await json<{ deleted: true; alreadyDeleted: boolean; counts: { attempts: number; siteIds: string[]; rows: Record<string, number>; objects: Record<string, number> } }>(res);
    expect(body).toMatchObject({ deleted: true, alreadyDeleted: false, counts: { attempts: 1, siteIds: [site.siteId], rows: { sites: 1, site_versions: 1, uploads: 1, leads: 1, owners: 1 } } });
    expect(body.counts.objects.work).toBeGreaterThan(0);

    expect((await h.call("GET", `/api/admin/sites/${site.siteId}`)).status).toBe(404);
    const listed = await json<{ sites: Array<{ id: string }> }>(await h.call("GET", "/api/admin/sites"));
    expect(listed.sites.map((s) => s.id)).toEqual(expect.arrayContaining([control.siteId]));
    expect(listed.sites.map((s) => s.id)).not.toContain(site.siteId);
    const invites = await json<{ invites: Array<{ email: string }> }>(await h.call("GET", "/api/admin/invites"));
    expect(invites.invites.map((i) => i.email)).not.toContain(site.email);
    expect((await (await h.r2("WORK")).list({ prefix: `versions/${site.siteId}/` })).objects).toEqual([]);
    expect((await (await h.r2("MEDIA")).list({ prefix: `${site.siteId}/` })).objects).toEqual([]);
    expect(await h.liveKeys(site.slug)).toEqual([]);
    expect(await count("SELECT COUNT(*) AS n FROM owners WHERE id = ? OR email = ?", site.ownerId, site.email)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM leads WHERE site_id = ?", site.siteId)).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM sites WHERE id = ?").bind(site.siteId).first()).toEqual({ n: 0 });

    const actions = (await auditOf(site.ownerId, site.siteId)).filter((a) => a.action === "owner.deletion_started" || a.action === "owner.deleted");
    expect(actions.map((a) => [a.action, a.actor])).toEqual([
      ["owner.deletion_started", "admin:admin@example.com"],
      ["owner.deleted", "admin:admin@example.com"],
    ]);
    expect(await dump(control)).toBe(controlBefore);
  });

  it("accepts the owner's email with other case and spaces around it", async () => {
    const site = await liveSite();
    expect((await disable(site.ownerId)).status).toBe(200);
    const res = await del(site.ownerId, `  ${site.email.toUpperCase()} `);
    expect(res.status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM owners WHERE id = ?", site.ownerId)).toBe(0);
  });

  it("answers a second press with alreadyDeleted and changes nothing", async () => {
    const site = await liveSite();
    expect((await disable(site.ownerId)).status).toBe(200);
    expect((await del(site.ownerId, site.email)).status).toBe(200);
    const auditCount = () => count("SELECT COUNT(*) AS n FROM audit_log");
    const before = await auditCount();
    const again = await del(site.ownerId, site.email);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ deleted: true, alreadyDeleted: true, counts: null });
    expect(await auditCount()).toBe(before);
    // Even a wrong email: the email is gone with the owner, and a repeat of a finished deletion is not an error.
    expect(await (await del(site.ownerId, "someone.else@example.com")).json()).toEqual({ deleted: true, alreadyDeleted: true, counts: null });
  });

  it("answers a failed run with the generic 500 and leaves the owner disabled and the site taken down, and a press without the fault finishes it", async () => {
    const site = await liveSite();
    expect((await disable(site.ownerId)).status).toBe(200);
    expect((await (await h.r2("WORK")).list({ prefix: `versions/${site.siteId}/` })).objects.length).toBeGreaterThan(0);
    const failed = await del(site.ownerId, site.email, { "X-Test-Delete-Fault": "work-delete-once" });
    expect(failed.status).toBe(500);
    expect((await json<ErrorJson>(failed)).error).toEqual({ code: "internal", message: "Something went wrong. Please try again." });
    const detail = await json<{ site: { takenDown: boolean; ownerDisabled: boolean } }>(await h.call("GET", `/api/admin/sites/${site.siteId}`));
    expect(detail.site).toMatchObject({ takenDown: true, ownerDisabled: true });
    expect(await h.liveKeys(site.slug)).toEqual([]);

    const finished = await del(site.ownerId, site.email);
    expect(finished.status).toBe(200);
    expect(await finished.json()).toMatchObject({ deleted: true, alreadyDeleted: false, counts: { attempts: 2 } });
    expect((await h.call("GET", `/api/admin/sites/${site.siteId}`)).status).toBe(404);
  });

  it("writes no log line that holds the owner's email", async () => {
    const site = await liveSite();
    expect((await disable(site.ownerId)).status).toBe(200);
    h.server.clearLogs();
    expect((await del(site.ownerId, "someone.else@example.com")).status).toBe(422);
    expect((await del(site.ownerId, site.email)).status).toBe(200);
    const lines = h.logLines();
    // The scan is not vacuous: the two requests did write their one line each, by route pattern.
    expect(lines.filter((l) => l["route"] === "POST /api/admin/owners/:ownerId/delete").map((l) => l["status"])).toEqual([422, 200]);
    const text = JSON.stringify(lines).toLowerCase();
    expect(text).not.toContain(site.email.toLowerCase());
    expect(text).not.toContain("someone.else@example.com");
  });

  it("runs to its end under waitUntil, as the takedown does", async () => {
    const site = await liveSite();
    expect((await disable(site.ownerId)).status).toBe(200);
    const path = `/api/admin/owners/${site.ownerId}/delete`;
    expect(await h.waitUntilCount(path)).toBe(0);
    expect((await del(site.ownerId, site.email)).status).toBe(200);
    expect(await h.waitUntilCount(path)).toBe(1);
    await h.backgroundDone(path);
  });
});

describe("GET /api/admin/sites/:siteId: ownerSites", () => {
  it("counts the sites of the site's owner and no one else's", async () => {
    const site = await liveSite();
    const control = await liveSite();
    const db = await h.db();
    const ownerSites = async (s: Site) => (await json<{ ownerSites: number }>(await h.call("GET", `/api/admin/sites/${s.siteId}`))).ownerSites;
    expect(await ownerSites(site)).toBe(1);
    await db.prepare("INSERT INTO sites (id, owner_id, created_at, updated_at) VALUES (?, ?, 1, 1)").bind(crypto.randomUUID(), site.ownerId).run();
    expect(await ownerSites(site)).toBe(2);
    expect(await ownerSites(control)).toBe(1);
  });
});

describe("enable and disable after a deletion started", () => {
  /** An owner whose deletion failed half way: disabled, site taken down, owner.deletion_started written. */
  async function halfDeleted(): Promise<Site> {
    const site = await liveSite();
    expect((await disable(site.ownerId)).status).toBe(200);
    expect((await del(site.ownerId, site.email, { "X-Test-Delete-Fault": "work-delete-once" })).status).toBe(500);
    expect((await auditOf(site.ownerId)).map((a) => a.action)).toContain("owner.deletion_started");
    return site;
  }
  const owner = async (site: Site) => (await (await h.db()).prepare("SELECT disabled_at, disabled_reason FROM owners WHERE id = ?").bind(site.ownerId).first()) as { disabled_at: number | null; disabled_reason: string | null };
  const MESSAGE = "This owner's account is being deleted. Press Delete the account to finish it.";

  it("refuses to enable the owner: 409, still disabled, no owner.enabled row", async () => {
    const site = await halfDeleted();
    const before = await owner(site);
    const res = await enable(site.ownerId);
    expect(res.status).toBe(409);
    expect((await json<ErrorJson>(res)).error).toMatchObject({ code: "conflict", message: MESSAGE });
    expect(await owner(site)).toEqual(before);
    expect(before.disabled_at).not.toBeNull();
    expect((await auditOf(site.ownerId)).map((a) => a.action)).not.toContain("owner.enabled");
  });

  it("refuses to disable the owner again: 409, the reason unchanged, no new owner.disabled row", async () => {
    const site = await halfDeleted();
    const before = await owner(site);
    const rows = async () => (await auditOf(site.ownerId)).filter((a) => a.action === "owner.disabled").length;
    const rowsBefore = await rows();
    const res = await h.call("POST", `/api/admin/owners/${site.ownerId}/disable`, { body: { reason: "A different reason" } });
    expect(res.status).toBe(409);
    expect((await json<ErrorJson>(res)).error).toMatchObject({ code: "conflict", message: MESSAGE });
    expect(await owner(site)).toEqual(before);
    expect(await rows()).toBe(rowsBefore);
  });

  // Ruling Q-1: the check above reads, the write that follows is fenced too. The test Worker (X-Test-Deletion-Started-Race) runs another
  // admin's deletion start between the two, so only the fence in the UPDATE can refuse.
  it("enable: a deletion that starts after the pre-check still refuses (409), and the owner stays disabled with no owner.enabled row", async () => {
    const site = await liveSite();
    expect((await disable(site.ownerId)).status).toBe(200);
    const before = await owner(site);
    const res = await enable(site.ownerId, { "X-Test-Deletion-Started-Race": site.ownerId });
    expect(res.status).toBe(409);
    expect((await json<ErrorJson>(res)).error).toMatchObject({ code: "conflict", message: MESSAGE });
    expect(await owner(site)).toEqual(before);
    const actions = (await auditOf(site.ownerId)).map((a) => a.action);
    expect(actions).toContain("owner.deletion_started"); // the seam did run
    expect(actions).not.toContain("owner.enabled");
  });

  it("disable: a deletion that starts after the pre-check still refuses (409), and the owner stays enabled with no owner.disabled row", async () => {
    const site = await liveSite();
    const res = await disable(site.ownerId, { "X-Test-Deletion-Started-Race": site.ownerId });
    expect(res.status).toBe(409);
    expect((await json<ErrorJson>(res)).error).toMatchObject({ code: "conflict", message: MESSAGE });
    expect(await owner(site)).toEqual({ disabled_at: null, disabled_reason: null });
    const actions = (await auditOf(site.ownerId)).map((a) => a.action);
    expect(actions).toContain("owner.deletion_started"); // the seam did run
    expect(actions).not.toContain("owner.disabled");
  });
});

describe("disable and enable are idempotent", () => {
  const state = async (ownerId: string) => (await (await h.db()).prepare("SELECT disabled_at, disabled_reason FROM owners WHERE id = ?").bind(ownerId).first()) as { disabled_at: number | null; disabled_reason: string | null };
  const rows = async (ownerId: string, action: string) => (await auditOf(ownerId)).filter((a) => a.action === action);

  it("disable twice: both 200 {}, the first time and reason stay, and exactly one owner.disabled row exists (an owner with no session)", async () => {
    const site = await h.pendingSite();
    const first = await h.call("POST", `/api/admin/owners/${site.ownerId}/disable`, { body: { reason: "First reason" } });
    expect([first.status, await first.json()]).toEqual([200, {}]);
    const kept = await state(site.ownerId);
    expect(kept).toMatchObject({ disabled_reason: "First reason" });
    expect(kept.disabled_at).not.toBeNull();
    expect(await rows(site.ownerId, "owner.disabled")).toHaveLength(1);
    const second = await h.call("POST", `/api/admin/owners/${site.ownerId}/disable`, { body: { reason: "Second reason" }, headers: { "X-Test-Now": String(Date.now() + 60_000) } });
    expect([second.status, await second.json()]).toEqual([200, {}]);
    expect(await state(site.ownerId)).toEqual(kept);
    expect(await rows(site.ownerId, "owner.disabled")).toHaveLength(1);
  });

  it("disable still ends the sessions of an owner who is already disabled, and still adds no second row", async () => {
    const site = await h.pendingSite();
    expect((await disable(site.ownerId)).status).toBe(200);
    const db = await h.db();
    await db.prepare("INSERT INTO sessions (id_hash, owner_id, created_at, expires_at, last_seen_at) VALUES (?, ?, 1, 9999999999999, 1)").bind(`late-${site.ownerId}`, site.ownerId).run();
    expect((await disable(site.ownerId)).status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM sessions WHERE owner_id = ?", site.ownerId)).toBe(0);
    expect(await rows(site.ownerId, "owner.disabled")).toHaveLength(1);
  });

  it("writes the owner.disabled row for an owner whose sessions were deleted by the same call, and for one with none", async () => {
    const withSession = await h.pendingSite();
    const db = await h.db();
    await db.prepare("INSERT INTO sessions (id_hash, owner_id, created_at, expires_at, last_seen_at) VALUES (?, ?, 1, 9999999999999, 1)").bind(`first-${withSession.ownerId}`, withSession.ownerId).run();
    expect((await disable(withSession.ownerId)).status).toBe(200);
    expect(await rows(withSession.ownerId, "owner.disabled")).toHaveLength(1);
    expect(await count("SELECT COUNT(*) AS n FROM sessions WHERE owner_id = ?", withSession.ownerId)).toBe(0);
  });

  it("enable twice: both 200 {}, the owner is enabled, and exactly one owner.enabled row exists", async () => {
    const site = await h.pendingSite();
    expect((await disable(site.ownerId)).status).toBe(200);
    const first = await enable(site.ownerId);
    expect([first.status, await first.json()]).toEqual([200, {}]);
    expect(await state(site.ownerId)).toEqual({ disabled_at: null, disabled_reason: null });
    const second = await enable(site.ownerId);
    expect([second.status, await second.json()]).toEqual([200, {}]);
    expect(await state(site.ownerId)).toEqual({ disabled_at: null, disabled_reason: null });
    expect(await rows(site.ownerId, "owner.enabled")).toHaveLength(1);
  });

  it("enabling an owner who was never disabled adds no row", async () => {
    const site = await h.pendingSite();
    expect((await enable(site.ownerId)).status).toBe(200);
    expect(await rows(site.ownerId, "owner.enabled")).toHaveLength(0);
  });
});
