/**
 * Bindings and variables of the asksite-sites Worker (apps/sites/wrangler.jsonc). Written by hand:
 * `wrangler types` emits a global `Env`, which would clash with the other Workers' types, and it
 * reads secrets from the gitignored .dev.vars, so its output differs between machines.
 * test/config.test.ts proves this list matches the config.
 */
export interface Env {
  DB: D1Database;
  /** Approved pages only. Read-only by type: this Worker can never put or delete (only asksite-admin writes LIVE). */
  LIVE: Pick<R2Bucket, "get" | "head">;
  /** Re-encoded photos. Read-only by type (asksite-app writes MEDIA). */
  MEDIA: Pick<R2Bucket, "get" | "head">;
  FORM_RL: RateLimit;
  ENVIRONMENT: string;
  /** host[:port] of the product domain, e.g. "asksite.example" or "localhost:8789". */
  ROOT_DOMAIN: string;
  MAILER: "resend" | "log";
  MAIL_FROM: string;
  /** RFC 9116 Expires for /.well-known/security.txt, an ISO 8601 date set at deploy time. */
  SECURITY_TXT_EXPIRES: string;
  /** Lead emails a UTC day across all sites (A11c), in digits; anything else is logged and 40 applies. */
  LEAD_EMAILS_PER_DAY: string;
  /** Secrets (wrangler secret put, or .dev.vars locally). Missing ones fail closed. */
  RESEND_API_KEY?: string;
  IP_HASH_KEY?: string;
}
