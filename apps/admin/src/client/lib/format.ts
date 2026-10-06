import type { TakedownView } from "../../settings-view.ts";

export const when = (ms: number | null): string => (ms === null ? "" : new Date(ms).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }));
export const dollars = (microusd: number): string => `$${(microusd / 1_000_000).toFixed(2)}`;
const MICROUSD_PER_CENT = 10_000;
/** An upper bound (an "Up to" figure or a maximum) in dollars: rounded UP to the cent in integer cents, so it never shows less than the bound. Exact 0 is "$0.00". */
export const dollarsUp = (microusd: number): string => {
  const cents = Math.ceil(microusd / MICROUSD_PER_CENT);
  return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
};
/** The columns that decide what one AI writing job's cost line may say. */
export interface JobCostInput {
  status: "queued" | "running" | "succeeded" | "failed";
  modelSlot: 0 | 1;
  costMicrousd: number;
}

/**
 * The cost line of one finished-or-not AI writing job, or null while it has not finished (no cost is known yet).
 * A finished job with model_slot 0 sent no provider call: the job gives its slot back only when it knows that
 * (packages/generation/src/job.ts:278 `releaseSlot = spend.attempts === 0 && !trace.costUnknown`), so "$0.00" is true.
 * A finished job that kept model_slot 1 with a recorded cost is an upper bound ("Up to"); with cost 0 it may still have been
 * billed (our own code threw after a call, or the sweeper ended the row and records no cost), so its cost is unknown.
 * Never decided by `attempts`: both of those rows record attempts 0.
 */
export function jobCostText(job: JobCostInput): string | null {
  if (job.status === "queued" || job.status === "running") return null;
  if (job.modelSlot === 0) return dollars(0);
  return job.costMicrousd > 0 ? `Up to ${dollarsUp(job.costMicrousd)}` : "Cost unknown";
}

/**
 * The settings page's "Spent today": the recorded cost is an upper bound, and the jobs that took a model slot today without a
 * recorded cost (running, or finished with cost 0: see jobCostText) are not in it, so they are named.
 * `modelCalls` counts today's model_slot 1 jobs; `unknownJobs` those not finished with a recorded cost.
 */
export function spentTodayText(spentMicrousd: number, modelCalls: number, unknownJobs: number): string {
  if (modelCalls === 0 && spentMicrousd === 0) return dollars(0);
  const upTo = `Up to ${dollarsUp(spentMicrousd)}`;
  if (unknownJobs === 0) return upTo;
  return `${upTo}, not counting ${unknownJobs === 1 ? "1 job" : `${unknownJobs} jobs`} whose cost is unknown`;
}

/** After a restore: photos deleted by a takedown with "Also delete this site's photos" stay missing (Plan 2 decision 29). */
export const restoredText = (missingPhotos: number): string =>
  missingPhotos === 0
    ? "Site restored."
    : `Site restored. ${missingPhotos === 1 ? "1 photo on it was" : `${missingPhotos} photos on it were`} deleted when it was taken down and will not show. Ask the owner to upload new photos and publish again.`;
/** The settings page's worst case per day; null means Plan 3 has no price for the configured model. */
export const worstCaseText = (microusd: number | null): string =>
  microusd === null ? "Unknown: no price is recorded for this model (check MODEL_PROVIDER and MODEL_ID)" : dollarsUp(microusd);

export const FLAG_REASON: Record<"web_address" | "at_sign" | "other_phone" | "phishing_word", string> = {
  web_address: "contains a web address",
  at_sign: "contains an @ sign",
  other_phone: "contains a phone number that is not the business's",
  phishing_word: "contains a word scammers use (password, bank, gift card…)",
};

export interface TakedownResult {
  tone: "success" | "warning";
  text: string;
  /** True: show the "Finish the takedown" button. */
  cleanupFailed: boolean;
  /** The owner's notice failed on the call that took the site down; a later "Finish" keeps saying so (its own answer is always null). */
  ownerNotEmailed: boolean;
}

export const NOT_EMAILED = "Owner not emailed — contact them.";
const CLEANUP_FAILED = "Clean-up did not finish. The site is offline; old page files stay in storage until you finish it.";

/**
 * What to tell the admin after a takedown, or after "Finish the takedown" (`previous` is then the earlier result). The
 * "owner not emailed" line shows only for false, never for null (no notice was due). An unfinished clean-up is only
 * storage: the site's LIVE pointer is deleted first (A16), so the site is already offline and nothing is shown.
 */
export function takedownResult(view: TakedownView, previous: TakedownResult | null): TakedownResult {
  const cleanupFailed = view.cleanupFailed === true;
  const ownerNotEmailed = view.noticeSent === false || previous?.ownerNotEmailed === true;
  const parts = [
    ...(previous === null ? ["Site taken down. It stops being served within about a minute."] : []),
    ...(ownerNotEmailed ? [NOT_EMAILED] : []),
    ...(cleanupFailed ? [CLEANUP_FAILED] : previous === null ? [] : ["Clean-up finished."]),
  ];
  return { tone: ownerNotEmailed || cleanupFailed ? "warning" : "success", text: parts.join(" "), cleanupFailed, ownerNotEmailed };
}

/** The Invites screen's notice after a revoke: "revoked" only when it worked; otherwise the server's own words (an already used invite says so). */
export const revokeNotice = (res: { ok: true } | { ok: false; error: { message: string } }, email: string): { tone: "success" | "error"; text: string } =>
  res.ok ? { tone: "success", text: `Invite for ${email} revoked.` } : { tone: "error", text: res.error.message };
