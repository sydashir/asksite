import { ApiError, auditStatement, inviteEmail, readJson } from "@asksite/app-common";
import { CreateInviteBody, newId, newToken, sha256Hex, TTL, type InviteRow, type InviteView } from "@asksite/core";
import { Hono } from "hono";
import { mailerEnv } from "../db.ts";
import type { AdminDeps } from "../deps.ts";
import type { AdminEnv } from "../types.ts";

const toInviteView = (row: InviteRow): InviteView => ({
  id: row.id,
  email: row.email,
  createdBy: row.created_by,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  usedAt: row.used_at,
  revokedAt: row.revoked_at,
  siteId: row.site_id,
});

/** Invites are always emailed and never shown to the admin (§3.2 step 2, §5.2). */
export function inviteRoutes(deps: AdminDeps): Hono<AdminEnv> {
  const invites = new Hono<AdminEnv>();

  invites.post("/invites", async (c) => {
    const { email: typed } = await readJson(c, CreateInviteBody);
    const email = typed.trim().toLowerCase();
    const admin = c.get("admin");
    const db = c.env.DB;
    const token = newToken();
    const now = Date.now();
    const id = newId();
    await db
      .prepare("INSERT INTO invites (id, token_hash, email, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, await sha256Hex(token), email, admin, now, now + TTL.inviteMs)
      .run();
    try {
      await deps.createMailer(mailerEnv(c.env)).send({
        to: email,
        ...inviteEmail({ appOrigin: c.env.APP_ORIGIN, token }),
        tag: "invite",
        idempotencyKey: `invite:${id}`,
      });
    } catch {
      // No email, no invite: nothing is left for anyone to use or revoke.
      await db.prepare("DELETE FROM invites WHERE id = ?").bind(id).run();
      throw new ApiError("email_failed", "Email could not be sent, try again");
    }
    await auditStatement(db, { at: now, actor: `admin:${admin}`, action: "invite.created", siteId: null, detail: { inviteId: id } }).run();
    const row = await db.prepare("SELECT * FROM invites WHERE id = ?").bind(id).first<InviteRow>();
    if (row === null) throw new Error("invite row missing after insert");
    return c.json({ invite: toInviteView(row) }, 201);
  });

  invites.get("/invites", async (c) => {
    const { results } = await c.env.DB.prepare("SELECT * FROM invites ORDER BY created_at DESC LIMIT 500").all<InviteRow>();
    return c.json({ invites: results.map(toInviteView) });
  });

  invites.delete("/invites/:inviteId", async (c) => {
    const admin = c.get("admin");
    const now = Date.now();
    const result = await c.env.DB.prepare("UPDATE invites SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").bind(now, c.req.param("inviteId")).run();
    if (result.meta.changes !== 1) throw new ApiError("not_found", "Not found");
    await auditStatement(c.env.DB, { at: now, actor: `admin:${admin}`, action: "invite.revoked", siteId: null, detail: { inviteId: c.req.param("inviteId") } }).run();
    return c.body(null, 204);
  });

  return invites;
}
