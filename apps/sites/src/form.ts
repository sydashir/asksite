import { hashIp, ipRateKey, isId, LIMITS, liveKey, newId, siteUrl, utcDayStart } from "@asksite/core";
import { createMailer, MailerError } from "@asksite/mailer";
import { leadEmailsPerDay } from "./config.ts";
import type { Env } from "./env.ts";
import { plainHeaders } from "./headers.ts";
import { leadEmail } from "./lead-email.ts";
import { looksLikeSpam, PROBLEM_TEXT, readLead, type Lead } from "./lead.ts";
import { logLine } from "./log.ts";
import { formProblems, notFound, siteBusy, tooManyRequests, unavailable, unreadableForm } from "./pages.ts";

const MAX_BODY_BYTES = 16 * 1024;

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
  if (type !== "application/x-www-form-urlencoded") return { response: unreadableForm(root, 415), code: "unsupported_media_type" };
  const body = await readLimited(request, MAX_BODY_BYTES);
  if (body === null) return { response: unreadableForm(root, 413), code: "payload_too_large" };

  const key = env.IP_HASH_KEY ?? "";
  if (key === "") return { response: unavailable(root), code: "misconfigured" };
  // The visitor's network: the IPv6 /64 (an IPv4 address whole), so a visitor cannot dodge a limit by
  // changing the low bits of their address (Decision 27). It keys the rate limit and the daily network
  // limits, and it is the ip_hash stored with the lead (A15).
  const ipHash = await hashIp(key, ipRateKey(request.headers.get("cf-connecting-ip") ?? "unknown"));
  const { success } = await env.FORM_RL.limit({ key: `${siteId}:${ipHash}` });
  if (!success) return { response: tooManyRequests(root), code: "rate_limited" };

  const fields = new URLSearchParams(body);
  const sent = `/_f/${siteId}/sent`;
  if ((fields.get("website") ?? "") !== "") return { response: seeOther(sent), code: "honeypot" };

  const read = readLead(fields);
  if (!read.ok) return { response: formProblems(root, read.problems.map((p) => PROBLEM_TEXT[p])), code: "validation_failed" };

  // R2 first: a form for a site with no approved page never reaches D1 (Decision 24).
  const page = await env.LIVE.head(liveKey(hostSlug));
  if (page === null || page.customMetadata?.["siteId"] !== siteId) return { response: notFound(root) };

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
  // Nothing was stored, so nothing is emailed or counted; the page points the visitor to the phone number.
  if (status === "site_daily_cap" || status === "network_daily_limit") return { response: siteBusy(root), code: status };
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

/**
 * Inserts the lead unless its network already left LIMITS.leadsPerNetworkPerSitePerDay leads on this site
 * today or LIMITS.leadsPerNetworkPerDay on all sites (spam included; A15), or the site already has
 * LIMITS.leadsPerSitePerDay. The same statement decides its email (A11c): spam is 'skipped'; any other
 * lead is 'pending' while fewer than `emailsPerDay` of today's leads across all sites had their email
 * tried (not spam, and not capped here), else 'failed' with email_error 'daily_cap'. One statement, so
 * every limit stays exact when visitors post at the same time.
 * D1 bills every row scanned. The network counts read only the network's rows for today (leads_network,
 * migration 0002) and the site count only the site's (leads_site), so a refused post reads a bounded
 * number of rows. The email count scans leads (A11c adds no index; the retention cron keeps the table
 * small), so only a stored lead that is not spam runs it: `tried` has a row only while every limit has
 * room (measured locally: this SQLite checks that WHERE before it runs the columns), and CASE is lazy,
 * so spam skips it.
 * Production SQL has no RETURNING (A10), so a SELECT in the same batch (a transaction) reads back the
 * stored status or, when nothing was stored, which limit refused it.
 */
export async function insertLead(
  db: D1Database,
  input: { leadId: string; siteId: string; now: number; lead: Lead; spam: boolean; ipHash: string; emailsPerDay: number },
): Promise<StoredStatus | Refusal> {
  const { leadId, siteId, now, lead, spam, ipHash, emailsPerDay } = input;
  const dayStart = utcDayStart(now);
  const [, outcome] = await db.batch<{ outcome: StoredStatus | Refusal }>([
    db
      .prepare(
        `INSERT INTO leads (id, site_id, created_at, name, phone, email, service, message, spam, email_status, email_error, ip_hash)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
                CASE WHEN ?9 = 1 THEN 'skipped' WHEN tried.n < ?11 THEN 'pending' ELSE 'failed' END,
                CASE WHEN ?9 = 0 AND tried.n >= ?11 THEN 'daily_cap' END,
                ?10
         FROM (SELECT CASE WHEN ?9 = 1 THEN 0
                           ELSE (SELECT COUNT(*) FROM leads WHERE created_at >= ?12 AND spam = 0 AND email_error IS NOT 'daily_cap') END AS n
               WHERE (SELECT COUNT(*) FROM leads WHERE ip_hash = ?10 AND site_id = ?2 AND created_at >= ?12) < ?14
                 AND (SELECT COUNT(*) FROM leads WHERE ip_hash = ?10 AND created_at >= ?12) < ?15
                 AND (SELECT COUNT(*) FROM leads WHERE site_id = ?2 AND created_at >= ?12) < ?13) AS tried`,
      )
      .bind(leadId, siteId, now, lead.name, lead.phone, lead.email, lead.service, lead.message, spam ? 1 : 0, ipHash,
        emailsPerDay, dayStart, LIMITS.leadsPerSitePerDay, LIMITS.leadsPerNetworkPerSitePerDay, LIMITS.leadsPerNetworkPerDay),
    db
      .prepare(
        `SELECT CASE WHEN stored.email_status IS NOT NULL THEN stored.email_status
                     WHEN (SELECT COUNT(*) FROM leads WHERE ip_hash = ?2 AND site_id = ?3 AND created_at >= ?4) >= ?5
                       OR (SELECT COUNT(*) FROM leads WHERE ip_hash = ?2 AND created_at >= ?4) >= ?6 THEN 'network_daily_limit'
                     ELSE 'site_daily_cap' END AS outcome
         FROM (SELECT (SELECT email_status FROM leads WHERE id = ?1) AS email_status) AS stored`,
      )
      .bind(leadId, ipHash, siteId, dayStart, LIMITS.leadsPerNetworkPerSitePerDay, LIMITS.leadsPerNetworkPerDay),
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
