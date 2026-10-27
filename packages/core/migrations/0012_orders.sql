-- Phase 2 shop, step 1 (pages lane proposal 1.7): orders placed on a site's shop (apps/sites/src/order.ts).
-- Money is integer US cents. Prices are never read from the browser: items_json is the snapshot the Worker priced from the
-- live version's approved catalog.
CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  number INTEGER NOT NULL,                     -- per site, from 1001; shown to the client, staff and the buyer
  version_id TEXT NOT NULL,                    -- the live version whose catalog priced it (provenance)
  created_at INTEGER NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,                                  -- optional on the order form; NULL when not given
  email TEXT NOT NULL,
  fulfilment TEXT NOT NULL CHECK (fulfilment IN ('pickup', 'delivery', 'shipping')),
  address_json TEXT,                           -- NULL for pickup; {line1, line2?, city, state, zip}
  note TEXT,
  items_json TEXT NOT NULL,                    -- [{productId, variantId, name, variantLabel, unitCents, qty, lineCents}]
  subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents > 0),
  currency TEXT NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),
  cart_id TEXT NOT NULL,                       -- the cart cookie's random id: the repeat check (and step 2's one open payment per cart)
  cart_hash TEXT NOT NULL,                     -- what the buyer saw: version, lines and unit prices
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'cancelled')), -- staff cancel fake or mistaken orders
  status_at INTEGER,
  status_by TEXT,                              -- 'admin:<email>'
  spam INTEGER NOT NULL DEFAULT 0 CHECK (spam IN (0, 1)),
  -- 'held' = a card order waiting for payment (step 2): never retried, never counted, emailed only once paid. It is in the
  -- CHECK now because changing a CHECK later means rebuilding the table.
  email_status TEXT NOT NULL CHECK (email_status IN ('pending', 'sent', 'failed', 'skipped', 'held')),
  email_error TEXT,
  ip_hash TEXT NOT NULL,                       -- the visitor's /64 (an IPv4 address whole), as leads: the burst limit's key
  net_hash TEXT NOT NULL,                      -- the visitor's /48 (an IPv4 address whole): the daily per-network cap's key
  UNIQUE (site_id, number)
) STRICT;
CREATE INDEX orders_site ON orders(site_id, created_at);
CREATE INDEX orders_network ON orders(net_hash, site_id, created_at);
CREATE INDEX orders_cart ON orders(site_id, cart_id, created_at);
-- The order-email count reads only the orders whose email was tried, by email state alone: spam found at insert is stored
-- 'skipped' (never tried), and an order staff mark as spam after its email went out still used its slot. SQLite uses a
-- partial index only when the query's WHERE implies the index's, so the count copies these terms exactly (as 0007 does).
CREATE INDEX orders_emailed ON orders(created_at) WHERE email_status IN ('pending', 'sent', 'failed') AND email_error IS NOT 'daily_cap';

-- Staff's per-site pause of orders (abuse without a takedown). NULL = open.
ALTER TABLE sites ADD COLUMN orders_paused_at INTEGER;
ALTER TABLE sites ADD COLUMN orders_paused_by TEXT;

-- The client's order address (proposal 1.8). Staff type it. It is confirmed only when the client reads back, on a staff
-- phone call, the code emailed to it. Every write of order_email bumps order_email_rev and clears the confirmation and the
-- code in the same statement, so a code sent to an earlier address never confirms a later one. A shop takes orders only
-- while its address is confirmed.
ALTER TABLE sites ADD COLUMN order_email TEXT;
ALTER TABLE sites ADD COLUMN order_email_rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sites ADD COLUMN order_email_confirmed_at INTEGER;
ALTER TABLE sites ADD COLUMN order_email_confirmed_by TEXT;
ALTER TABLE sites ADD COLUMN order_email_code_hash TEXT;     -- HMAC of the code and the rev it was sent for; never the code
ALTER TABLE sites ADD COLUMN order_email_code_expires_at INTEGER;
ALTER TABLE sites ADD COLUMN order_email_code_tries INTEGER NOT NULL DEFAULT 0;

-- The new sites columns are nullable or NOT NULL with a constant DEFAULT, as ADD COLUMN requires: no table rewrite, and
-- every existing site reads NULL, rev 0 and 0 tries (0011_auth_version.sql explains why).
