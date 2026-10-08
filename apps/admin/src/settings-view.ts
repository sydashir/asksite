import type { AdminSettings } from "@asksite/core";

/**
 * What GET and PUT /api/admin/settings answer: design §4.2 `AdminSettings`, except that the worst
 * case is null when Plan 3 has no recorded price for the configured model (its decision 11). The
 * Worker, the settings page and the tests all use this one type.
 */
export type SettingsView = Omit<AdminSettings, "worstCaseDailyMicrousd"> & {
  worstCaseDailyMicrousd: number | null;
  /**
   * Today's jobs that took a model slot (modelCallsToday counts them) and are NOT finished with a recorded cost: still running, or
   * finished with cost 0 (our own code threw after a call, or the sweeper ended the row). Their cost is not in spentTodayMicrousd.
   */
  unknownCostJobsToday: number;
};

/**
 * What GET /api/admin/sign-in-emails answers (A11b item 1): the sign-in links made since 00:00 UTC (one login_tokens
 * row each), the day's cap for them (LOGIN_EMAILS_PER_DAY), and when the cap was reached (null while it is not). At
 * the cap the owner app sends no more sign-in emails until 00:00 UTC. A failed send: the owner app keeps a link whose
 * send ended "unavailable" (it may have been delivered), marked and not counted in today's total, and deletes the link
 * on any other failure; the admin's own "Send sign-in link" deletes its link on any failure.
 */
export interface SignInEmailsView {
  sentToday: number;
  dailyCap: number;
  capReachedAt: number | null;
}

/**
 * What POST /api/admin/sites/:siteId/takedown answers once the takedown has committed: whether the owner's notice
 * email went out. false means the owner was NOT told (for example the email service's daily cap was reached), so the
 * admin must contact them by hand; null means no notice was due because the site was already down before this call
 * (a re-run never emails twice). The takedown itself stands either way.
 */
export interface TakedownView {
  noticeSent: boolean | null;
  /**
   * Present (true) when a step after the commit (the LIVE delete or the media purge) still failed after one retry in the same call.
   * The page and photos are gated on taken_down_at, but until the LIVE object is deleted the business name (and, on the 429 page,
   * the phone) can still show on the 404, form thank-you and 429 pages. Finish the takedown re-runs it; Task 27 item 42 is the ops backstop.
   */
  cleanupFailed?: true;
}

/**
 * What one run of Delete the account deleted, as @asksite/publishing's deleteOwner counts it (restated here, once: the client imports no
 * publishing code, and the Worker's deps.ts imports this). `attempts` above 1 means earlier runs deleted part and these are THIS run's counts.
 */
export interface OwnerDeletionCounts {
  attempts: number;
  siteIds: string[];
  rows: { sites: number; site_versions: number; generations: number; uploads: number; leads: number; invites: number; sessions: number; login_tokens: number; dev_outbox: number; owners: 1 };
  objects: { work: number; live: number; media: number };
  auditRedacted: number;
}

/**
 * What POST /api/admin/owners/:ownerId/delete answers once the owner is gone. `alreadyDeleted` is true when an earlier call finished it
 * (counts is then null: nothing was deleted by this one).
 */
export interface OwnerDeletionView {
  deleted: true;
  alreadyDeleted: boolean;
  counts: OwnerDeletionCounts | null;
}
