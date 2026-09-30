import type { AdminSettings } from "@asksite/core";

/**
 * What GET and PUT /api/admin/settings answer: design §4.2 `AdminSettings`, except that the worst
 * case is null when Plan 3 has no recorded price for the configured model (its decision 11). The
 * Worker, the settings page and the tests all use this one type.
 */
export type SettingsView = Omit<AdminSettings, "worstCaseDailyMicrousd"> & { worstCaseDailyMicrousd: number | null };

/**
 * What GET /api/admin/sign-in-emails answers (A11b item 1): the sign-in links made since 00:00 UTC (one login_tokens
 * row each, a link that failed to send is removed), the day's cap for them (LOGIN_EMAILS_PER_DAY), and when the cap
 * was reached (null while it is not). At the cap the owner app sends no more sign-in emails until 00:00 UTC.
 */
export interface SignInEmailsView {
  sentToday: number;
  dailyCap: number;
  capReachedAt: number | null;
}

/**
 * What POST /api/admin/sites/:siteId/takedown answers once the takedown has committed: whether the owner's notice
 * email went out. false means the owner was NOT told (for example the email service's daily cap was reached), so the
 * admin must contact them by hand. The takedown itself stands either way.
 */
export interface TakedownView {
  noticeSent: boolean;
  /** Present (true) when a step after the commit (the LIVE delete or the media purge) threw: the site is offline but its cleanup did not finish, so cleanup did not finish. The leftover LIVE object or media is NOT served (the sites Worker gates on taken_down_at) and is removed by the Task 27 ops clean-up sweep (task-27-checklist item 42). */
  cleanupFailed?: true;
}
