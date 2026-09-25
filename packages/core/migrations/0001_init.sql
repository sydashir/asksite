-- asksite schema v1 (design §2.6). All times are Unix epoch milliseconds. All ids are
-- crypto.randomUUID(). Emails are stored trimmed and lower-cased. Money is integer micro-USD.

CREATE TABLE owners (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  disabled_at INTEGER,
  disabled_reason TEXT
) STRICT;

CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  slug TEXT UNIQUE,
  facts_json TEXT NOT NULL DEFAULT '{}',
  brief_json TEXT NOT NULL DEFAULT '{}',
  edits_json TEXT NOT NULL DEFAULT '{"baseGenerationId":null,"copy":{},"order":null,"hidden":[],"theme":null}',
  rev INTEGER NOT NULL DEFAULT 1,
  live_version_id TEXT,
  pending_version_id TEXT,
  indexable INTEGER NOT NULL DEFAULT 1 CHECK (indexable IN (0, 1)),
  taken_down_at INTEGER,
  takedown_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX sites_owner ON sites(owner_id);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  revoked_at INTEGER,
  owner_id TEXT REFERENCES owners(id),
  site_id TEXT REFERENCES sites(id)
) STRICT;

CREATE TABLE login_tokens (
  token_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
) STRICT;
CREATE INDEX login_tokens_owner ON login_tokens(owner_id, created_at);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
) STRICT;
CREATE INDEX sessions_owner ON sessions(owner_id);

CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
) STRICT;
CREATE INDEX uploads_site ON uploads(site_id);

CREATE TABLE generations (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  owner_id TEXT NOT NULL REFERENCES owners(id),
  kind TEXT NOT NULL CHECK (kind IN ('first', 'regenerate')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  input_json TEXT NOT NULL,
  output_json TEXT,
  used_fallback INTEGER NOT NULL DEFAULT 0 CHECK (used_fallback IN (0, 1)),
  fallback_reason TEXT,
  model_slot INTEGER NOT NULL DEFAULT 0 CHECK (model_slot IN (0, 1)), -- 1 = this job took one of today's model calls
  provider TEXT,
  model TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_microusd INTEGER NOT NULL DEFAULT 0, -- reporting only; limits are counts
  error_code TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
) STRICT;
CREATE INDEX generations_site ON generations(site_id, created_at);
CREATE INDEX generations_owner ON generations(owner_id);
CREATE INDEX generations_slots ON generations(model_slot, started_at);
CREATE UNIQUE INDEX generations_one_active ON generations(site_id) WHERE status IN ('queued', 'running');

CREATE TABLE site_versions (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn', 'superseded')),
  document_json TEXT NOT NULL,          -- canonicalJson of the parsed SiteDocument that was rendered
  document_sha256 TEXT NOT NULL,        -- sha256Hex(document_json)
  edits_json TEXT NOT NULL,             -- OwnerEdits snapshot (provenance for review)
  generation_id TEXT REFERENCES generations(id),
  html_key TEXT NOT NULL,
  html_sha256 TEXT NOT NULL,
  stylesheet_sha256 TEXT NOT NULL,
  requested_by TEXT NOT NULL,           -- owner id
  requested_at INTEGER NOT NULL,
  reviewed_by TEXT,                     -- admin email
  reviewed_at INTEGER,
  review_note TEXT,
  UNIQUE (site_id, number)
) STRICT;
CREATE INDEX site_versions_status ON site_versions(status, requested_at);

CREATE TABLE leads (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  created_at INTEGER NOT NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  service TEXT,
  message TEXT,
  spam INTEGER NOT NULL DEFAULT 0 CHECK (spam IN (0, 1)),
  email_status TEXT NOT NULL CHECK (email_status IN ('pending', 'sent', 'failed', 'skipped')),
  email_error TEXT,
  ip_hash TEXT NOT NULL
) STRICT;
CREATE INDEX leads_site ON leads(site_id, created_at);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
) STRICT;

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,                  -- 'admin:<email>' | 'owner:<id>' | 'system'
  action TEXT NOT NULL,                 -- one of AUDIT_ACTIONS
  site_id TEXT,
  detail_json TEXT
) STRICT;
CREATE INDEX audit_site ON audit_log(site_id, at);

CREATE TABLE dev_outbox (               -- written only by LogMailer (development/test); never in production
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  text TEXT NOT NULL,
  tag TEXT NOT NULL
) STRICT;
