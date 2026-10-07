import { ApiError, auditStatement, magicLinkEmail, noteLog, readJson, runToEnd, sendReporting } from "@asksite/app-common";
import { isId, newToken, sha256Hex, TTL, utcDayStart } from "@asksite/core";
import { Hono } from "hono";
import { z } from "zod";
import type { SignInEmailsView } from "../../settings-view.ts";
import { loginEmailsPerDay } from "../config.ts";
import { mailerEnv } from "../db.ts";
import type { AdminDeps } from "../deps.ts";
import { emailFailed } from "../send-errors.ts";
import type { AdminEnv } from "../types.ts";

/**
 * Sign-in emails for the owners (A11b): how many went out today against the day's cap, and the admin's own
 * "Send sign-in link", which the owner app's caps do not apply to.
 */
export function signInRoutes(deps: AdminDeps): Hono<AdminEnv> {
  const signIn = new Hono<AdminEnv>();

  signIn.get("/sign-in-emails", async (c) => {
    const db = c.env.DB;
    const dayStart = utcDayStart(Date.now());
    const dailyCap = loginEmailsPerDay(c.env.LOGIN_EMAILS_PER_DAY);
    // The owner app's day count (apps/app/src/worker/sign-in-emails.ts sentToday), exactly: the sign-in links, skipping
    // those kept after an "unavailable" send (send_failed_at set, B1-15), plus the self-serve sign-up invites (open
    // sign-up, created_by 'signup'; a failed sign-up send deletes its invite).
    const emailsToday = `SELECT created_at, token_hash AS k FROM login_tokens WHERE created_at >= ?1 AND send_failed_at IS NULL
      UNION ALL SELECT created_at, id AS k FROM invites WHERE created_by = 'signup' AND created_at >= ?1`;
    const [count, reached] = await db.batch([
      db.prepare(`SELECT COUNT(*) AS n FROM (${emailsToday})`).bind(dayStart),
      // The cap-th email of the day, by time: when the app started refusing.
      db.prepare(`SELECT created_at FROM (${emailsToday}) ORDER BY created_at, k LIMIT 1 OFFSET ?2`).bind(dayStart, dailyCap - 1),
    ]);
    const view: SignInEmailsView = {
      sentToday: (count?.results[0] as { n: number } | undefined)?.n ?? 0,
      dailyCap,
      capReachedAt: (reached?.results[0] as { created_at: number } | undefined)?.created_at ?? null,
    };
    return c.json(view);
  });

  signIn.post("/owners/:ownerId/sign-in-link", async (c) => {
    await readJson(c, z.strictObject({}));
    const ownerId = c.req.param("ownerId");
    const db = c.env.DB;
    const owner = isId(ownerId) ? await db.prepare("SELECT email, disabled_at FROM owners WHERE id = ?").bind(ownerId).first<{ email: string; disabled_at: number | null }>() : null;
    if (owner === null) throw new ApiError("not_found", "Not found");
    if (owner.disabled_at !== null) throw new ApiError("owner_disabled", "This account is disabled. Enable it first");
    const admin = c.get("admin");
    const now = Date.now();
    const token = newToken();
    const tokenHash = await sha256Hex(token);
    // Built before the token exists, so a configuration error (MAILER, APP_ORIGIN) is a 500 that leaves no token.
    const mailer = deps.createMailer(mailerEnv(c.env));
    const content = magicLinkEmail({ appOrigin: c.env.APP_ORIGIN, token });
    // The token, the send and the audit row are one promise handed to waitUntil, so an admin who goes away after
    // the INSERT cannot leave a live token with no audit row.
    await runToEnd(
      c.executionCtx,
      (async () => {
        // No cap here (the app's per-owner and day caps are for sign-in requests anyone can make); the row still
        // counts toward today's total. It is written only for an owner who is still not disabled.
        const inserted = await db
          .prepare("INSERT INTO login_tokens (token_hash, owner_id, created_at, expires_at) SELECT ?, id, ?, ? FROM owners WHERE id = ? AND disabled_at IS NULL")
          .bind(tokenHash, now, now + TTL.loginTokenMs, ownerId)
          .run();
        if (inserted.meta.changes !== 1) throw new ApiError("owner_disabled", "This account is disabled. Enable it first");
        const failure = await sendReporting(mailer, { to: owner.email, ...content, tag: "magic_link", idempotencyKey: `login:${tokenHash}` });
        if (failure !== null) {
          // No email, no token: it must not count toward the day. The request's line says why, never to whom.
          noteLog(c, { error: failure });
          await db.prepare("DELETE FROM login_tokens WHERE token_hash = ?").bind(tokenHash).run();
          throw emailFailed(failure);
        }
        await auditStatement(db, { at: now, actor: `admin:${admin}`, action: "admin.login_link_sent", siteId: null, detail: { ownerId } }).run();
      })(),
    );
    return c.json({});
  });

  return signIn;
}
