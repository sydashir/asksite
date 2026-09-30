import { ApiError, auditStatement, inviteEmail, noteLog, readJson, runToEnd, sendReporting, type AuditAction } from "@asksite/app-common";
import { CreateInviteBody, newId, newToken, sha256Hex, TTL, type InviteRow, type InviteView } from "@asksite/core";
import { Hono } from "hono";
import { mailerEnv } from "../db.ts";
import type { AdminDeps } from "../deps.ts";
import { emailFailed } from "../send-errors.ts";
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

/**
 * auditStatement's row (§2.6), but written only when the revoke's UPDATE is about to change the invite: it runs
 * first in the revoke's batch, under the UPDATE's own predicate, so a revoke that changes nothing leaves no row.
 */
const revokeAuditStatement = (db: D1Database, entry: { at: number; actor: string; action: AuditAction; inviteId: string }): D1PreparedStatement =>
  db
    .prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) SELECT ?, ?, ?, NULL, ? FROM invites WHERE id = ? AND revoked_at IS NULL AND site_id IS NULL")
    .bind(entry.at, entry.actor, entry.action, JSON.stringify({ inviteId: entry.inviteId }), entry.inviteId);

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
    // Built before the row exists, so a configuration error (MAILER, APP_ORIGIN) is a 500 that leaves no invite.
    const mailer = deps.createMailer(mailerEnv(c.env));
    const content = inviteEmail({ appOrigin: c.env.APP_ORIGIN, token });
    // INSERT, send, then the audit row: one promise handed to waitUntil, so an admin who goes away after the INSERT
    // cannot leave an invite with no audit row (or, after a failed send, an invite that was never emailed).
    await runToEnd(
      c.executionCtx,
      (async () => {
        await db
          .prepare("INSERT INTO invites (id, token_hash, email, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(id, await sha256Hex(token), email, admin, now, now + TTL.inviteMs)
          .run();
        const failure = await sendReporting(mailer, { to: email, ...content, tag: "invite", idempotencyKey: `invite:${id}` });
        if (failure !== null) {
          // No email, no invite: nothing is left for anyone to use or revoke. The request's line says why, never to whom.
          noteLog(c, { error: failure });
          await db.prepare("DELETE FROM invites WHERE id = ?").bind(id).run();
          throw emailFailed(failure);
        }
        await auditStatement(db, { at: now, actor: `admin:${admin}`, action: "invite.created", siteId: null, detail: { inviteId: id } }).run();
      })(),
    );
    const row = await db.prepare("SELECT * FROM invites WHERE id = ?").bind(id).first<InviteRow>();
    if (row === null) throw new Error("invite row missing after insert");
    return c.json({ invite: toInviteView(row) }, 201);
  });

  invites.get("/invites", async (c) => {
    const { results } = await c.env.DB.prepare("SELECT * FROM invites ORDER BY created_at DESC LIMIT 500").all<InviteRow>();
    return c.json({ invites: results.map(toInviteView) });
  });

  invites.delete("/invites/:inviteId", async (c) => {
    const inviteId = c.req.param("inviteId");
    const now = Date.now();
    const db = c.env.DB;
    // One transaction (A10: no RETURNING). Only an invite that is still open is revoked: a repeat (even
    // one in the same millisecond), or a revoke after the owner's accept finished (site_id set), changes
    // nothing and is not audited, because the audit INSERT runs first, under the UPDATE's own predicate.
    // An accept that has claimed the token but not finished (used_at set, site_id NULL) is still revoked,
    // so its rollback cannot reopen the invite. The last statement tells an unknown id (404) from one
    // that needed nothing (204).
    const results = await db.batch([
      // Keep the action below a literal: plan Task 26's mutation test finds it in this file by its text.
      revokeAuditStatement(db, { at: now, actor: `admin:${c.get("admin")}`, action: "invite.revoked", inviteId }),
      db.prepare("UPDATE invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL AND site_id IS NULL").bind(now, inviteId),
      db.prepare("SELECT id FROM invites WHERE id = ?").bind(inviteId),
    ]);
    if (results[2]?.results.length !== 1) throw new ApiError("not_found", "Not found");
    return c.body(null, 204);
  });

  return invites;
}
