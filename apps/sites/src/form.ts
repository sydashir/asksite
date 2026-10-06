import { hashIp, ipRateKey, isId, LIMITS, livePointerKey, newId, siteUrl, utcDayStart } from "@asksite/core";
import { createMailer, MailerError } from "@asksite/mailer";
import { businessOf, formBusiness } from "./business.ts";
import { leadEmailsPerDay } from "./config.ts";
import type { Env } from "./env.ts";
import { plainHeaders } from "./headers.ts";
import { leadEmail } from "./lead-email.ts";
import { looksLikeSpam, PROBLEM_TEXT, readLead, type Lead } from "./lead.ts";
import { logLine } from "./log.ts";
import { formProblems, messageTooLong, notFound, siteBusy, tooManyRequests, unavailable, unreadableForm } from "./pages.ts";

// 24 KiB (A15). The real form cannot send more than about 20,100 bytes: maxlength 80/30/254/2,000, a
// service from the list, and 9 bytes a character for a 3-byte script once form-encoded. form.workerd.test.ts
// posts 20,136 bytes with every field at the Worker's own limit (303). A hand-made body can be larger, as
// cleaning strips characters before the length checks, so only this cap bounds it (413).
const MAX_BODY_BYTES = 24 * 1024;

/** Reads at most `max` bytes, counting as it reads, so a missing or false Content-Length cannot get past it. */
async function readLimited(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > max) return null;
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

const seeOther = (location: string) => new Response(null, { status: 303, headers: plainHeaders({ Location: location }) });

interface SiteForForm { slug: string | null; live_version_id: string | null; taken_down_at: number | null; email: string }

/** POST /_f/<siteId> on a site host (design §7.5). */
export async function handleForm(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  hostSlug: string,
  siteId: string,
  now: number,
): Promise<{ response: Response; code?: string }> {
  const root = env.ROOT_DOMAIN;
  if (!isId(siteId)) return { response: notFound(root) };

  const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return { response: unreadableForm(root), code: "unsupported_media_type" };
  const body = await readLimited(request, MAX_BODY_BYTES);
  if (body === null) return { response: messageTooLong(root), code: "payload_too_large" };

  const key = env.IP_HASH_KEY ?? "";
  if (key === "") return { response: unavailable(root), code: "misconfigured" };
  // The visitor's network: the IPv6 /64 (an IPv4 address whole), so a visitor cannot dodge a limit by
  // changing the low bits of their address (Decision 27). It keys the rate limit and the daily network
  // limits, and it is the ip_hash stored with the lead (A15).
  const ipHash = await hashIp(key, ipRateKey(request.headers.get("cf-connecting-ip") ?? "unknown"));
  const { success } = await env.FORM_RL.limit({ key: `${siteId}:${ipHash}` });
  // The page prints the business phone (QA-2 RU(4)); only a refused post pays for this LIVE.head.
  if (!success) return { response: tooManyRequests(root, (await formBusiness(env.LIVE, hostSlug, siteId)).phone), code: "rate_limited" };

  const fields = new URLSearchParams(body);
  const sent = `/_f/${siteId}/sent`;
  if ((fields.get("website") ?? "") !== "") return { response: seeOther(sent), code: "honeypot" };

  const read = readLead(fields);
  if (!read.ok) return { response: formProblems(root, read.problems.map((p) => PROBLEM_TEXT[p])), code: "validation_failed" };

  // R2 first: a form for a site with no pointer never reaches D1 (Decision 24). The pointer is written only after
  // every page is copied, so a visitor who can see /contact always has a working form.
  const pointer = await env.LIVE.head(livePointerKey(hostSlug));
  if (pointer === null || pointer.customMetadata?.["siteId"] !== siteId) return { response: notFound(root) };

  const site = await env.DB.prepare(
    "SELECT s.slug, s.live_version_id, s.taken_down_at, o.email FROM sites s JOIN owners o ON o.id = s.owner_id WHERE s.id = ?",
  ).bind(siteId).first<SiteForForm>();
  if (site === null || site.slug !== hostSlug || site.live_version_id === null || site.taken_down_at !== null) {
    return { response: notFound(root) };
  }

  const leadId = newId();
  const spam = looksLikeSpam(read.lead);
  const emailsPerDay = leadEmailsPerDay(env.LEAD_EMAILS_PER_DAY);
  const status = await insertLead(env.DB, { leadId, siteId, now, lead: read.lead, spam, ipHash, emailsPerDay });
  // Nothing was stored, so nothing is emailed or counted; the page gives the visitor the phone number.
  if (status === "site_daily_cap" || status === "network_daily_limit") return { response: siteBusy(root, now, businessOf(pointer.customMetadata).phone), code: status };
  // The same request again (a second tap on Send): stored and emailed once already, so only thanked.
  if (status === "duplicate") return { response: seeOther(sent), code: "duplicate" };
  if (status === "skipped") return { response: seeOther(sent), code: "spam" };
  // A11c: today's lead emails for all sites are used up. The lead is saved (the owner sees it in the app)
  // and the visitor is thanked as usual, but it is never emailed.
  if (status === "failed") return { response: seeOther(sent), code: "lead_email_cap_reached" };

  // The lead is saved: thank the visitor now and email the owner after the response (Decision 26).
  ctx.waitUntil(emailOwner(env, { leadId, siteId, to: site.email, lead: read.lead, siteUrl: siteUrl(root, site.slug) }));
  return { response: seeOther(sent) };
}

export type StoredStatus = "pending" | "failed" | "skipped";
/** Why a lead was not stored: the site's day cap, or its network's daily limit on this site or on all sites (A15). */
export type Refusal = "site_daily_cap" | "network_daily_limit";
/** Not stored because the same request is already there (QA-2 RU(1)). */
export type Duplicate = "duplicate";

/** A second tap on Send while the first post is on its way arrives within this time (QA-2 RU(1)). */
const REPEAT_WINDOW_MS = 120_000;

/**
 * Inserts the lead unless the same request is already stored (QA-2 RU(1): the same site, network, name,
 * phone and message in the last REPEAT_WINDOW_MS, e.g. a second tap on Send), or its network already left
 * LIMITS.leadsPerNetworkPerSitePerDay leads on this site today or LIMITS.leadsPerNetworkPerDay on all sites
 * (spam included; A15), or the site already has LIMITS.leadsPerSitePerDay. A repeat is reported before any
 * limit, so a repeat of the last allowed lead is thanked, not refused.
 * The same statement decides its email (A11c): spam is 'skipped'; any other lead is 'pending' while fewer
 * than `emailsPerDay` of today's leads across all sites had their email tried (not spam, and not capped
 * here), else 'failed' with email_error 'daily_cap'. One statement, so every rule stays exact when
 * visitors post at the same time.
 * D1 bills every row scanned. The repeat check reads only the network's (or the site's) rows of the last
 * REPEAT_WINDOW_MS, the network counts only the network's rows for today (leads_network, migration 0002)
 * and the site count only the site's (leads_site), so a refused post reads a bounded number of rows. The
 * email count reads the partial index leads_emailed (migration 0007: spam = 0 and not capped, as that count's
 * WHERE says), so only a stored
 * lead that is not spam runs it: `tried` has a row only while every rule allows the insert (measured
 * locally: this SQLite checks that WHERE before it runs the columns), and CASE is lazy, so spam skips it.
 * Production SQL has no RETURNING (A10), so a SELECT in the same batch (a transaction) reads back the
 * stored status or, when nothing was stored, whether it was a repeat or which limit refused it.
 */
export async function insertLead(
  db: D1Database,
  input: { leadId: string; siteId: string; now: number; lead: Lead; spam: boolean; ipHash: string; emailsPerDay: number },
): Promise<StoredStatus | Refusal | Duplicate> {
  const { leadId, siteId, now, lead, spam, ipHash, emailsPerDay } = input;
  const dayStart = utcDayStart(now);
  const repeatSince = now - REPEAT_WINDOW_MS;
  const [, outcome] = await db.batch<{ outcome: StoredStatus | Refusal | Duplicate }>([
    db
      .prepare(
        `INSERT INTO leads (id, site_id, created_at, name, phone, email, service, message, spam, email_status, email_error, ip_hash)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
                CASE WHEN ?9 = 1 THEN 'skipped' WHEN tried.n < ?11 THEN 'pending' ELSE 'failed' END,
                CASE WHEN ?9 = 0 AND tried.n >= ?11 THEN 'daily_cap' END,
                ?10
         FROM (SELECT CASE WHEN ?9 = 1 THEN 0
                           ELSE (SELECT COUNT(*) FROM leads WHERE created_at >= ?12 AND spam = 0 AND email_error IS NOT 'daily_cap') END AS n
               WHERE NOT EXISTS (SELECT 1 FROM leads WHERE ip_hash = ?10 AND site_id = ?2 AND created_at >= ?16
                                   AND name = ?4 AND phone = ?5 AND message IS ?8)
                 AND (SELECT COUNT(*) FROM leads WHERE ip_hash = ?10 AND site_id = ?2 AND created_at >= ?12) < ?14
                 AND (SELECT COUNT(*) FROM leads WHERE ip_hash = ?10 AND created_at >= ?12) < ?15
                 AND (SELECT COUNT(*) FROM leads WHERE site_id = ?2 AND created_at >= ?12) < ?13) AS tried`,
      )
      .bind(leadId, siteId, now, lead.name, lead.phone, lead.email, lead.service, lead.message, spam ? 1 : 0, ipHash,
        emailsPerDay, dayStart, LIMITS.leadsPerSitePerDay, LIMITS.leadsPerNetworkPerSitePerDay, LIMITS.leadsPerNetworkPerDay, repeatSince),
    db
      .prepare(
        `SELECT CASE WHEN stored.email_status IS NOT NULL THEN stored.email_status
                     WHEN EXISTS (SELECT 1 FROM leads WHERE ip_hash = ?2 AND site_id = ?3 AND created_at >= ?7
                                    AND name = ?8 AND phone = ?9 AND message IS ?10) THEN 'duplicate'
                     WHEN (SELECT COUNT(*) FROM leads WHERE ip_hash = ?2 AND site_id = ?3 AND created_at >= ?4) >= ?5
                       OR (SELECT COUNT(*) FROM leads WHERE ip_hash = ?2 AND created_at >= ?4) >= ?6 THEN 'network_daily_limit'
                     ELSE 'site_daily_cap' END AS outcome
         FROM (SELECT (SELECT email_status FROM leads WHERE id = ?1) AS email_status) AS stored`,
      )
      .bind(leadId, ipHash, siteId, dayStart, LIMITS.leadsPerNetworkPerSitePerDay, LIMITS.leadsPerNetworkPerDay, repeatSince, lead.name, lead.phone, lead.message),
  ]);
  const result = outcome?.results[0]?.outcome;
  if (result === undefined) throw new Error("insertLead: the read-back SELECT returned no row");
  return result;
}

/**
 * Runs after the 303 (ctx.waitUntil): sends the lead email to the owner's verified login email and
 * records the outcome. The lead is already saved; nothing here can reject, so nothing here can change
 * what the visitor saw. Logs one line with the outcome (codes only).
 */
async function emailOwner(env: Env, input: { leadId: string; siteId: string; to: string; lead: Lead; siteUrl: string }): Promise<void> {
  const started = Date.now();
  let error: string | null = null;
  try {
    await createMailer(env).send(leadEmail(input));
  } catch (e) {
    error = e instanceof MailerError ? e.code : "internal";
  }
  let code = error === null ? undefined : `email_${error}`;
  try {
    await env.DB.prepare("UPDATE leads SET email_status = ?, email_error = ? WHERE id = ?").bind(error === null ? "sent" : "failed", error, input.leadId).run();
  } catch {
    code = "email_status_not_saved"; // the lead stays 'pending'; the owner still sees it in the app
  }
  logLine({ route: "form_email", ms: Date.now() - started, siteId: input.siteId, ...(code === undefined ? {} : { code }) });
}
