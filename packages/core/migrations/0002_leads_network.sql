-- A15: the contact form counts one network's leads today, on one site and across all sites
-- (apps/sites/src/form.ts). D1 bills every row a query scans; without this index the count across
-- all sites reads the whole leads table on every post, including posts it refuses.
CREATE INDEX leads_network ON leads(ip_hash, created_at);
