// One interface per D1 table (migrations/0001_init.sql), fields named exactly as the columns.
// Times are epoch milliseconds; INTEGER 0/1 flags are typed 0 | 1.

export interface OwnerRow {
  id: string;
  email: string;
  created_at: number;
  disabled_at: number | null;
  disabled_reason: string | null;
  password_hash: string | null; // 0010_owner_password.sql: a PBKDF2 hash (password.ts), never the password; NULL = no password
}

export interface SiteRow {
  id: string;
  owner_id: string;
  slug: string | null;
  facts_json: string;
  brief_json: string;
  edits_json: string;
  rev: number;
  live_version_id: string | null;
  pending_version_id: string | null;
  indexable: 0 | 1;
  taken_down_at: number | null;
  takedown_reason: string | null;
  admin_lock: string | null; // A16-4c: the token of the admin action that holds the site
  admin_lock_until: number | null; // A16-4c: when that lease runs out (epoch ms)
  created_at: number;
  updated_at: number;
}

export interface InviteRow {
  id: string;
  token_hash: string;
  email: string;
  created_by: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  revoked_at: number | null;
  owner_id: string | null;
  site_id: string | null;
}

export interface LoginTokenRow {
  token_hash: string;
  owner_id: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  /** When the email send ended "unavailable" (the link is kept, F26); null on every other row (B1-15, migration 0009). */
  send_failed_at: number | null;
}

export interface SessionRow {
  id_hash: string;
  owner_id: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
}

export interface UploadRow {
  id: string;
  site_id: string;
  width: number;
  height: number;
  bytes: number;
  created_at: number;
  deleted_at: number | null;
  /** When the row was reserved, before its upload's billed transform; null on every other row (P4-21, migration 0003). */
  reserved_at: number | null;
}

export interface GenerationRow {
  id: string;
  site_id: string;
  owner_id: string;
  kind: "first" | "regenerate";
  status: "queued" | "running" | "succeeded" | "failed";
  input_json: string;
  output_json: string | null;
  used_fallback: 0 | 1;
  fallback_reason: string | null;
  model_slot: 0 | 1;
  provider: string | null;
  model: string | null;
  attempts: number;
  input_tokens: number;
  output_tokens: number;
  cost_microusd: number;
  error_code: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface SiteVersionRow {
  id: string;
  site_id: string;
  number: number;
  status: "pending" | "approved" | "rejected" | "withdrawn" | "superseded";
  document_json: string;
  document_sha256: string;
  edits_json: string;
  generation_id: string | null;
  html_key: string;
  html_sha256: string;
  stylesheet_sha256: string;
  requested_by: string;
  requested_at: number;
  reviewed_by: string | null;
  reviewed_at: number | null;
  review_note: string | null;
  pages_json: string; // A16 (0005): canonicalJson(VersionPages); '[]' on rows from before A16
}

export interface LeadRow {
  id: string;
  site_id: string;
  created_at: number;
  name: string;
  phone: string;
  email: string | null;
  service: string | null;
  message: string | null;
  spam: 0 | 1;
  email_status: "pending" | "sent" | "failed" | "skipped";
  email_error: string | null;
  ip_hash: string;
}

export interface SettingRow {
  key: string;
  value: string;
  updated_at: number;
  updated_by: string;
}

export interface AuditRow {
  id: number;
  at: number;
  actor: string;
  action: string;
  site_id: string | null;
  detail_json: string | null;
}
