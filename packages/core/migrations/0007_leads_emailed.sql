-- S1: the contact form counts today's leads whose email was tried, across all sites (apps/sites/src/form.ts),
-- on every stored post. D1 bills every row a query scans; without this index that count reads the whole leads
-- table. A partial index holds only the leads the count wants. SQLite uses it only when the query's WHERE
-- implies the index's, so these terms are copied from the query exactly: apps/sites/test/lead-index.workerd.test.ts
-- asks the database for the plan of that very SQL.
CREATE INDEX leads_emailed ON leads(created_at) WHERE spam = 0 AND email_error IS NOT 'daily_cap';
