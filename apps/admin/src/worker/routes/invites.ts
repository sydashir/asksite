import { ApiError, auditStatement, inviteEmail, noteLog, readJson, sendReporting, type AuditAction } from "@asksite/app-common";
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

/** What the admin reads when the invite email fails. Resend's shared daily limit (§7.6) gets its own words: retrying will not help today. */
const SEND_FAILED = "Email could not be sent, try again";
const DAILY_LIMIT_REACHED = "Invite emails are paused for today because the daily email limit was reached. Try again after 00:00 UTC.";

/**
 * auditStatement's row (§2.6), but written only when the invite's revoked_at is this request's own `at`:
 * a revoke that changed nothing leaves no row. Runs inside the revoke's batch, after its UPDATE.
 */
const revokeAuditStatement = (db: D1Database, entry: { at: number; actor: string; action: AuditAction; inviteId: string }): D1PreparedStatement =>
  db
    .prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) SELECT ?, ?, ?, NULL, ? WHERE EXISTS (SELECT 1 FROM invites WHERE id = ? AND revoked_at = ?)")
    .bind(entry.at, entry.actor, entry.action, JSON.stringify({ inviteId: entry.inviteId }), entry.inviteId, entry.at);

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
    await db
      .prepare("INSERT INTO invites (id, token_hash, email, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, await sha256Hex(token), email, admin, now, now + TTL.inviteMs)
      .run();
    const failure = await sendReporting(mailer, { to: email, ...content, tag: "invite", idempotencyKey: `invite:${id}` });
    if (failure !== null) {
      // No email, no invite: nothing is left for anyone to use or revoke. The request's line says why, never to whom.
      noteLog(c, { error: failure });
      await db.prepare("DELETE FROM invites WHERE id = ?").bind(id).run();
      throw new ApiError("email_failed", failure === "rate_limited" ? DAILY_LIMIT_REACHED : SEND_FAILED);
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
    const inviteId = c.req.param("inviteId");
    const now = Date.now();
    const db = c.env.DB;
    // One transaction (A10: no RETURNING). Only an invite that is still open is revoked: a repeat, or a
    // revoke after the owner's accept finished (site_id set), changes nothing and is not audited. An
    // accept that has claimed the token but not finished (used_at set, site_id NULL) is still revoked,
    // so its rollback cannot reopen the invite. The last statement tells an unknown id (404) from one
    // that needed nothing (204).
    const results = await db.batch([
      db.prepare("UPDATE invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL AND site_id IS NULL").bind(now, inviteId),
      revokeAuditStatement(db, { at: now, actor: `admin:${c.get("admin")}`, action: "invite.revoked", inviteId }),
      db.prepare("SELECT id FROM invites WHERE id = ?").bind(inviteId),
    ]);
    if (results[2]?.results.length !== 1) throw new ApiError("not_found", "Not found");
    return c.body(null, 204);
  });

  return invites;
}
