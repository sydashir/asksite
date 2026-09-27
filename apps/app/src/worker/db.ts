import { ApiError } from "@asksite/app-common";
import { isId, type SiteRow } from "@asksite/core";
import type { MailerEnv } from "./deps.ts";

const notFound = (): ApiError => new ApiError("not_found", "Not found");

/** The read of the owner's own site, alone or in a batch after a write to it. A malformed id is 404 before any query. */
export function ownedSiteQuery(db: D1Database, siteId: string, ownerId: string): D1PreparedStatement {
  if (!isId(siteId)) throw notFound();
  return db.prepare("SELECT * FROM sites WHERE id = ? AND owner_id = ?").bind(siteId, ownerId);
}

/** The row ownedSiteQuery found. Anyone else's site is 404 (never 403) so ids cannot be probed. */
export function foundSite(site: SiteRow | null | undefined): SiteRow {
  if (site === null || site === undefined) throw notFound();
  return site;
}

/** The owner's own site. Anyone else's site, or a malformed id, is 404 (never 403) so ids cannot be probed. */
export async function ownedSite(db: D1Database, siteId: string, ownerId: string): Promise<SiteRow> {
  return foundSite(await ownedSiteQuery(db, siteId, ownerId).first<SiteRow>());
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
