-- B1-15 (T27 #57): sign-in links whose email send ended "unavailable".

-- The owner app keeps such a link, because the provider may have delivered it (F26), and marks it here with the time
-- the send failed (Unix epoch ms); every other link reads NULL. The day's cap on sign-in emails for all owners
-- (LOGIN_EMAILS_PER_DAY: apps/app/src/worker/routes/auth.ts, and the admin's count in
-- apps/admin/src/worker/routes/sign-in.ts) skips marked links, so an email outage cannot use it up for every owner.
-- Each owner's own caps (5 an hour, 10 a day) still count them, and the link still signs in. Numbered 0009 because
-- 0008 is reserved by the pages lane. Nullable with no default: no table rewrite, and every existing row reads NULL.
ALTER TABLE login_tokens ADD COLUMN send_failed_at INTEGER;
