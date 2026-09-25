import { ApiError } from "@asksite/app-common";
import { isId, type SiteRow } from "@asksite/core";
import type { MailerEnv } from "./deps.ts";

/** The owner's own site. Anyone else's site, or a malformed id, is 404 (never 403) so ids cannot be probed. */
export async function ownedSite(db: D1Database, siteId: string, ownerId: string): Promise<SiteRow> {
  if (!isId(siteId)) throw new ApiError("not_found", "Not found");
  const site = await db.prepare("SELECT * FROM sites WHERE id = ? AND owner_id = ?").bind(siteId, ownerId).first<SiteRow>();
  if (site === null) throw new ApiError("not_found", "Not found");
  return site;
}

export function assertNotTakenDown(site: SiteRow): void {
  if (site.taken_down_at !== null) throw new ApiError("site_taken_down", "This website has been taken offline. Contact us to restore it.");
}

/** JSON column text to a value; a corrupt column reads as an empty object (drafts may be anything). */
export function parseStored(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export function mailerEnv(env: Env): MailerEnv {
  if (env.MAILER !== "resend" && env.MAILER !== "log") throw new Error("MAILER must be resend or log");
  return { MAILER: env.MAILER, MAIL_FROM: env.MAIL_FROM, RESEND_API_KEY: env.RESEND_API_KEY, DB: env.DB, ENVIRONMENT: env.ENVIRONMENT };
}

export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}
