import { describe, expect, it } from "vitest";
import { json, useAppHarness } from "../support/harness.ts";

const h = useAppHarness();

type ErrorJson = { error: { code: string; issues?: Array<{ path: unknown[]; code: string }> } };

const slugAndRev = async (siteId: string) => (await h.db()).prepare("SELECT slug, rev FROM sites WHERE id = ?").bind(siteId).first();

describe("web address", () => {
  it("reports availability: free, taken, invalid, reserved and blocked", async () => {
    const owner = await h.signIn();
    const check = async (slug: string) => json(await h.call("GET", `/api/slugs/${slug}/availability`, { cookie: owner.cookie }));
    expect(await check("joes-plumbing-austin")).toEqual({ available: true, reason: null });
    await h.call("PUT", `/api/sites/${owner.siteId}/slug`, { cookie: owner.cookie, body: { rev: 1, slug: "joes-plumbing-austin" } });
    expect(await check("joes-plumbing-austin")).toEqual({ available: false, reason: "taken" });
    expect(await check("Joes")).toEqual({ available: false, reason: "invalid" });
    expect(await check("admin")).toEqual({ available: false, reason: "reserved" });
    expect(await check("paypal")).toEqual({ available: false, reason: "blocked" });
  });

  it("sets the slug and bumps rev; a taken slug is 409 slug_taken", async () => {
    const a = await h.signIn();
    const b = await h.signIn();
    const set = await h.call("PUT", `/api/sites/${a.siteId}/slug`, { cookie: a.cookie, body: { rev: 1, slug: "acme-roofing" } });
    expect(await set.json()).toEqual({ rev: 2, slug: "acme-roofing" });
    const taken = await h.call("PUT", `/api/sites/${b.siteId}/slug`, { cookie: b.cookie, body: { rev: 1, slug: "acme-roofing" } });
    expect(taken.status).toBe(409);
    expect((await json<ErrorJson>(taken)).error.code).toBe("slug_taken");
  });

  it("refuses a blocked slug with 422 slug_invalid and the reason code", async () => {
    const owner = await h.signIn();
    const res = await h.call("PUT", `/api/sites/${owner.siteId}/slug`, { cookie: owner.cookie, body: { rev: 1, slug: "wells-fargo" } });
    expect(res.status).toBe(422);
    const body = await json<ErrorJson>(res);
    expect(body.error.code).toBe("slug_invalid");
    expect(body.error.issues?.[0]?.code).toBe("blocked");
  });

  it("locks the slug once a version is pending or live (409 slug_locked)", async () => {
    const owner = await h.signIn();
    await (await h.db()).prepare("UPDATE sites SET pending_version_id = 'v' WHERE id = ?").bind(owner.siteId).run();
    const res = await h.call("PUT", `/api/sites/${owner.siteId}/slug`, { cookie: owner.cookie, body: { rev: 1, slug: "locked-name" } });
    expect(res.status).toBe(409);
    expect((await json<ErrorJson>(res)).error.code).toBe("slug_locked");
  });

  it("keeps the slug locked while a version is live and none is pending (409 slug_locked, nothing written)", async () => {
    const owner = await h.signIn();
    const set = await h.call("PUT", `/api/sites/${owner.siteId}/slug`, { cookie: owner.cookie, body: { rev: 1, slug: "live-name" } });
    expect(await set.json()).toEqual({ rev: 2, slug: "live-name" });
    await (await h.db()).prepare("UPDATE sites SET live_version_id = 'v', pending_version_id = NULL WHERE id = ?").bind(owner.siteId).run();
    const res = await h.call("PUT", `/api/sites/${owner.siteId}/slug`, { cookie: owner.cookie, body: { rev: 2, slug: "moved-live" } });
    expect(res.status).toBe(409);
    expect((await json<ErrorJson>(res)).error.code).toBe("slug_locked");
    expect(await slugAndRev(owner.siteId)).toEqual({ slug: "live-name", rev: 2 });
  });

  it("cannot set another owner's web address (404, nothing written)", async () => {
    const a = await h.signIn();
    const b = await h.signIn();
    const res = await h.call("PUT", `/api/sites/${a.siteId}/slug`, { cookie: b.cookie, body: { rev: 1, slug: "stolen-name" } });
    expect(res.status).toBe(404);
    expect((await json<ErrorJson>(res)).error.code).toBe("not_found");
    expect(await slugAndRev(a.siteId)).toEqual({ slug: null, rev: 1 });
  });
});
