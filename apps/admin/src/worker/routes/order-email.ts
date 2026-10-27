import { ApiError, readJson, sendReporting } from "@asksite/app-common";
import { isId, sha256Hex, utcDayStart } from "@asksite/core";
import { escapeText } from "@asksite/renderer";
import { Hono } from "hono";
import { z } from "zod";
import { mailerEnv } from "../db.ts";
import type { AdminDeps } from "../deps.ts";
import type { AdminEnv } from "../types.ts";

// The client's order address (pages lane proposal 1.8). Staff type it; it is confirmed only when the client reads back,
// on a staff phone call, the 8-digit code emailed to it. The sites Worker takes orders only while the address is confirmed
// (insertOrder's order_email_confirmed_at), so a typo never sends buyers' details to a stranger: the stranger has the code
// but is never called. Every write of the address bumps order_email_rev and clears the confirmation and the code in the
// same statement, so a code sent to an earlier address never confirms a later one.
// The code is stored only as v1$<salt>$<SHA-256 of v1|site|rev|salt|code>. The admin Worker has no MAC secret; a salted
// hash is enough here because guessing online is capped at CODE_TRIES per code, and anyone able to read D1 to brute-force
// the hash offline can already read the orders themselves. The code is never logged, audited or answered.

/**
 * Codes a site may be sent in a UTC day, counted from the audit log: every site.order_email_code_sent row, less those a
 * site.order_email_code_rejected row marks as definitively refused by Resend (MailerError "rejected": nothing delivered,
 * nothing spent; moderator ruling 2026-10-26). An ambiguous failure (unavailable, timeout, 429) still counts.
 */
export const CODE_SENDS_PER_DAY = 3;

/** Today's counted code sends of a site, as SQL: ?site twice, then ?dayStart twice. */
const COUNTED_SENDS = `((SELECT COUNT(*) FROM audit_log WHERE site_id = ? AND action = 'site.order_email_code_sent' AND at >= ?)
  - (SELECT COUNT(*) FROM audit_log WHERE site_id = ? AND action = 'site.order_email_code_rejected' AND at >= ?))`;
/** Wrong codes allowed before the code stops working (a new code resets it). */
export const CODE_TRIES = 5;
const CODE_TTL_MS = 7 * 86_400_000;

const EmailBody = z.strictObject({ email: z.string().trim().toLowerCase().pipe(z.email().max(254)) });
const ConfirmBody = z.strictObject({
  code: z.string().transform((s) => s.replace(/[\s-]/g, "")).pipe(z.string().regex(/^\d{8}$/)),
  rev: z.int().min(1),
});

/** 8 uniformly random digits (rejection sampling, so no digit string is likelier than another). */
function newCode(): string {
  const limit = 4_294_967_296 - (4_294_967_296 % 100_000_000);
  for (;;) {
    const [n = 0] = crypto.getRandomValues(new Uint32Array(1));
    if (n < limit) return String(n % 100_000_000).padStart(8, "0");
  }
}

const hexOf = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

const codeHash = async (siteId: string, rev: number, salt: string, code: string) => `v1$${salt}$${await sha256Hex(`v1|${siteId}|${rev}|${salt}|${code}`)}`;

/** The salt of a stored code hash, or null when it is not one. */
const saltOf = (stored: string | null) => (stored === null ? null : (/^v1\$([0-9a-f]{32})\$[0-9a-f]{64}$/.exec(stored)?.[1] ?? null));

/** The code email (NEW text, for copy approval): plain text and escaped HTML, the business name as escaped text. */
function codeEmail(business: string | null, code: string): { subject: string; text: string; html: string } {
  const name = business ?? "your business";
  const shown = `${code.slice(0, 4)} ${code.slice(4)}`;
  const lines = [
    `Hybrid is setting up online orders for ${name}. Orders placed on the website will be emailed to this address.`,
    `To confirm this address, give this code to the Hybrid team member who calls you: ${shown}`,
    "The code works for 7 days. If you were not expecting this email, you can ignore it.",
  ];
  const subject = `Confirm your order email for ${name}`.replace(/[\p{Cc}\p{Cf}]+/gu, " ").slice(0, 100);
  return {
    subject,
    text: `${lines.join("\n\n")}\n`,
    html: `<!doctype html>\n<html lang="en"><body>\n${lines.map((l) => `<p>${escapeText(l)}</p>`).join("\n")}\n</body></html>\n`,
  };
}

interface AddressRow {
  order_email: string | null;
  order_email_rev: number;
  order_email_confirmed_at: number | null;
  order_email_code_hash: string | null;
  order_email_code_expires_at: number | null;
  order_email_code_tries: number;
  business: string | null;
}

const ADDRESS = `SELECT order_email, order_email_rev, order_email_confirmed_at, order_email_code_hash, order_email_code_expires_at, order_email_code_tries,
                        json_extract(facts_json, '$.businessName') AS business FROM sites WHERE id = ?`;

export function orderEmailRoutes(deps: AdminDeps): Hono<AdminEnv> {
  const routes = new Hono<AdminEnv>();

  async function site(db: D1Database, siteId: string): Promise<AddressRow> {
    if (!isId(siteId)) throw new ApiError("not_found", "No such site");
    const row = await db.prepare(ADDRESS).bind(siteId).first<AddressRow>();
    if (row === null) throw new ApiError("not_found", "No such site");
    return row;
  }

  routes.put("/sites/:siteId/order-email", async (c) => {
    const siteId = c.req.param("siteId");
    const { email } = await readJson(c, EmailBody);
    const db = c.env.DB;
    const current = await site(db, siteId);
    if (current.order_email === email) return c.json({ orderEmail: email, orderEmailRev: current.order_email_rev });
    const now = Date.now();
    const actor = `admin:${c.get("admin")}`;
    const [changed, , readBack] = await db.batch<{ order_email_rev: number }>([
      db.prepare(
        `UPDATE sites SET order_email = ?, order_email_rev = order_email_rev + 1, order_email_confirmed_at = NULL, order_email_confirmed_by = NULL,
                          order_email_code_hash = NULL, order_email_code_expires_at = NULL, order_email_code_tries = 0
         WHERE id = ? AND order_email IS ?`,
      ).bind(email, siteId, current.order_email),
      db.prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) SELECT ?, ?, 'site.order_email_set', ?, json_object('rev', (SELECT order_email_rev FROM sites WHERE id = ?)) WHERE changes() = 1")
        .bind(now, actor, siteId, siteId),
      db.prepare("SELECT order_email_rev FROM sites WHERE id = ?").bind(siteId),
    ]);
    if (changed?.meta.changes !== 1) throw new ApiError("conflict", "The order email changed meanwhile. Reload and try again.");
    return c.json({ orderEmail: email, orderEmailRev: readBack?.results[0]?.order_email_rev ?? current.order_email_rev + 1 });
  });

  routes.post("/sites/:siteId/order-email/code", async (c) => {
    const siteId = c.req.param("siteId");
    const db = c.env.DB;
    const current = await site(db, siteId);
    if (current.order_email === null) throw new ApiError("conflict", "Add the client's order email first.");
    if (current.order_email_confirmed_at !== null) throw new ApiError("conflict", "This order email is already confirmed.");
    const now = Date.now();
    const dayStart = utcDayStart(now);
    const tooMany = () => new ApiError("rate_limited", `At most ${CODE_SENDS_PER_DAY} codes a day. Try again tomorrow.`);
    const counted = async () => (await db.prepare(`SELECT ${COUNTED_SENDS} AS n`).bind(siteId, dayStart, siteId, dayStart).first<{ n: number }>())?.n ?? 0;
    if ((await counted()) >= CODE_SENDS_PER_DAY) throw tooMany(); // the fast answer; the claim below decides
    const code = newCode();
    const salt = hexOf(crypto.getRandomValues(new Uint8Array(16)));
    const expiresAt = now + CODE_TTL_MS;
    const actor = `admin:${c.get("admin")}`;
    // Stored first, for exactly this address and revision, and only while today's counted sends are under the limit: one
    // statement, so sends that race never pass it (D1 runs one statement at a time; the batch is one transaction). A send
    // that races an address change stores nothing.
    const [stored] = await db.batch([
      db.prepare(
        `UPDATE sites SET order_email_code_hash = ?, order_email_code_expires_at = ?, order_email_code_tries = 0
         WHERE id = ? AND order_email = ? AND order_email_rev = ? AND order_email_confirmed_at IS NULL AND ${COUNTED_SENDS} < ?`,
      ).bind(await codeHash(siteId, current.order_email_rev, salt, code), expiresAt, siteId, current.order_email, current.order_email_rev, siteId, dayStart, siteId, dayStart, CODE_SENDS_PER_DAY),
      db.prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) SELECT ?, ?, 'site.order_email_code_sent', ?, json_object('rev', ?) WHERE changes() = 1")
        .bind(now, actor, siteId, current.order_email_rev),
    ]);
    if (stored?.meta.changes !== 1) {
      if ((await counted()) >= CODE_SENDS_PER_DAY) throw tooMany();
      throw new ApiError("conflict", "The order email changed meanwhile. Reload and try again.");
    }
    const email = codeEmail(current.business, code);
    const failure = await sendReporting(deps.createMailer(mailerEnv(c.env)), {
      to: current.order_email, ...email, replyTo: c.env.SUPPORT_EMAIL, tag: "order_email_code", idempotencyKey: `order-email-code:${siteId}:${current.order_email_rev}:${salt}`,
    });
    if (failure === "rejected") {
      // Definitively refused: nothing was delivered, so this send does not count toward the day's limit (the ruling above).
      await db.prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) VALUES (?, ?, 'site.order_email_code_rejected', ?, json_object('rev', ?))")
        .bind(Date.now(), actor, siteId, current.order_email_rev).run();
    }
    if (failure !== null) throw new ApiError("email_failed", "The code email could not be sent. Try again in a minute.");
    return c.json({ sentTo: current.order_email, expiresAt });
  });

  routes.post("/sites/:siteId/order-email/confirm", async (c) => {
    const siteId = c.req.param("siteId");
    const { code, rev } = await readJson(c, ConfirmBody);
    const db = c.env.DB;
    const current = await site(db, siteId);
    if (current.order_email_confirmed_at !== null) throw new ApiError("conflict", "This order email is already confirmed.");
    if (rev !== current.order_email_rev) throw new ApiError("conflict", "The order email changed after this code was sent. Send a new code.");
    const salt = saltOf(current.order_email_code_hash);
    if (salt === null) throw new ApiError("conflict", "Send a code first.");
    if (current.order_email_code_tries >= CODE_TRIES) throw new ApiError("rate_limited", "Too many wrong codes. Send a new code.");
    const now = Date.now();
    const actor = `admin:${c.get("admin")}`;
    const live = "id = ? AND order_email_rev = ? AND order_email_confirmed_at IS NULL AND order_email_code_expires_at > ? AND order_email_code_tries < ?";
    // One batch: confirm only the right, live code of this revision; audit that; otherwise count one more try.
    const [confirmed] = await db.batch([
      db.prepare(`UPDATE sites SET order_email_confirmed_at = ?, order_email_confirmed_by = ?, order_email_code_hash = NULL, order_email_code_expires_at = NULL WHERE ${live} AND order_email_code_hash = ?`)
        .bind(now, actor, siteId, rev, now, CODE_TRIES, await codeHash(siteId, rev, salt, code)),
      db.prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) SELECT ?, ?, 'site.order_email_confirmed', ?, json_object('rev', ?) WHERE changes() = 1").bind(now, actor, siteId, rev),
      db.prepare(`UPDATE sites SET order_email_code_tries = order_email_code_tries + 1 WHERE changes() = 0 AND ${live} AND order_email_code_hash IS NOT NULL`)
        .bind(siteId, rev, now, CODE_TRIES),
    ]);
    if (confirmed?.meta.changes === 1) return c.json({ orderEmailConfirmedAt: now });
    const after = await site(db, siteId);
    if (after.order_email_rev !== rev || after.order_email_confirmed_at !== null) throw new ApiError("conflict", "The order email changed meanwhile. Reload and try again.");
    if ((after.order_email_code_expires_at ?? 0) <= now) throw new ApiError("token_invalid", "This code has expired. Send a new code.");
    // This try was counted: a wrong code answers 422 with what is left (0 after the last), and only the next try is refused.
    const left = Math.max(0, CODE_TRIES - after.order_email_code_tries);
    throw new ApiError("validation_failed", left === 0 ? "That code is not right, and that was the last try. Send a new code." : `That code is not right. ${left} ${left === 1 ? "try" : "tries"} left.`);
  });

  return routes;
}
