import { SCOPE_OPTIONS, TRADE_OPTIONS } from "../../../../app/src/client/lib/labels.ts";
import { CONFIRM_EMAIL_MISMATCH } from "../../messages.ts";
import type { OwnerDeletionView, TakedownView } from "../../settings-view.ts";

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

/** The columns of one AI writing job's line on the site page. */
export interface JobLineInput extends JobCostInput {
  createdAt: number;
  kind: string;
  usedFallback: boolean;
  provider: string | null;
  model: string | null;
  attempts: number;
}

/**
 * One AI writing job's line. When its cost is unknown the provider, model and attempts are not stated either: a swept or rejected row
 * keeps "no model" and 0 attempts although a paid call may have been made (see jobCostText), so only "Cost unknown" is said for them.
 */
export function jobLineText(job: JobLineInput): string {
  const cost = jobCostText(job);
  const head = `${when(job.createdAt)}: ${job.kind}, ${job.status}${job.usedFallback ? " (starter wording)" : ""}`;
  if (cost === "Cost unknown") return `${head} · ${cost}`;
  return `${head} · ${job.provider ?? "no model"} ${job.model ?? ""}${cost === null ? "" : ` · ${cost}`} · ${job.attempts} attempts`;
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
  /** True: the clean-up did not finish, and the text says so (the down-site form is where "Finish the takedown" is pressed). */
  cleanupFailed: boolean;
  /** The owner's notice failed on this call (`noticeSent` false). A Finish from the down-site form passes no earlier result, so it never repeats this. */
  ownerNotEmailed: boolean;
}

export const NOT_EMAILED = "Owner not emailed — contact them.";
const CLEANUP_FAILED = "Clean-up did not finish. The site is offline; old page files stay in storage until you finish it.";

/**
 * What to tell the admin after a takedown, or after the down-site form's "Finish the takedown" (`previous` is then always the re-run marker, never an earlier result). The
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

/** What is wrong with the email typed to confirm Delete the account, or null. Spaces and letter case do not matter (the server compares the same way). */
export function confirmEmailProblem(typed: string, ownerEmail: string): string | null {
  const email = typed.trim().toLowerCase();
  if (email === "") return "Type the owner's email to confirm.";
  return email === ownerEmail.trim().toLowerCase() ? null : CONFIRM_EMAIL_MISMATCH;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The confirm dialog's text: names the owner and how many sites go. */
export const deleteDialogText = (ownerEmail: string, sites: number): string =>
  `This permanently deletes the account of ${ownerEmail} and its ${plural(sites, "site", "sites")}: every version, photo, message from visitors and AI writing job. It cannot be undone.`;

/** What the result screen says: nothing (an earlier press finished it), or what THIS run deleted; above one attempt, earlier attempts deleted the rest. */
export function deletionResultText(view: OwnerDeletionView): string {
  if (view.alreadyDeleted || view.counts === null) return "This account was already deleted. Nothing more was deleted.";
  const { rows, attempts } = view.counts;
  const list = `${plural(rows.sites, "site", "sites")}, ${plural(rows.site_versions, "version", "versions")}, ${plural(rows.uploads, "photo", "photos")}, ${plural(rows.leads, "message", "messages")} and ${plural(rows.generations, "AI writing job", "AI writing jobs")}`;
  const base = `Deleted ${list}, and the account.`;
  return attempts > 1 ? `${base} This was attempt ${attempts}: earlier attempts deleted the rest, so these are only what this one deleted.` : base;
}

const factsOf = (document: unknown): Record<string, unknown> => {
  const facts = typeof document === "object" && document !== null ? (document as { facts?: unknown }).facts : undefined;
  return typeof facts === "object" && facts !== null ? (facts as Record<string, unknown>) : {};
};

/** The kind of business, with the owner's own words for "Other" (free text, as typed), in the owner app's labels. */
export function businessTypeText(document: unknown): string {
  const { trade, tradeOther } = factsOf(document);
  const label = TRADE_OPTIONS.find((option) => option.value === trade)?.label ?? "(none)";
  return trade === "other" && typeof tradeOther === "string" ? `${label}: “${tradeOther}”` : label;
}

/** Where the business serves customers, in the owner app's labels; a document with no scope serves specific places. */
export function serviceScopeText(document: unknown): string {
  const scope = factsOf(document)["serviceAreaScope"] ?? "places";
  return SCOPE_OPTIONS.find((option) => option.value === scope)?.label ?? "(unknown)";
}
