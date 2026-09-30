import { Brief, type Issue, type SiteView } from "@asksite/core";
import { Facts } from "@asksite/site-schema";
import { STEPS, type StepId } from "./route.ts";
import { asArray, asRecord, type Path } from "./values.ts";

const under = (root: string, issues: ReadonlyArray<{ path: PropertyKey[]; code: string; message: string }>): Issue[] =>
  issues.map((i) => ({ path: [root, ...i.path.map((p) => (typeof p === "symbol" ? String(p) : p))], code: i.code, message: i.message }));

/** The opening-hours entry an issue is on, when the issue is at that entry's opening or closing time. */
function timeEntry(issue: Issue): number | undefined {
  const [root, list, entry, field] = issue.path;
  const atTime = issue.path.length === 4 && root === "facts" && list === "hours" && (field === "opens" || field === "closes");
  return atTime && typeof entry === "number" ? entry : undefined;
}

/**
 * The opening-hours order check ("closes must be later than opens", code custom at the closing time) also runs
 * on an empty or malformed time ("08:00" < "" is false) and then gives the wrong reason. It is kept only for two
 * valid times: an entry with another issue at either time loses it, so each time field shows exactly one
 * message (approved amendment, task-12-extra.md).
 */
function withoutFalseOrder(issues: readonly Issue[]): Issue[] {
  const badTimes = new Set<number>();
  for (const issue of issues) {
    const entry = timeEntry(issue);
    if (entry !== undefined && issue.code !== "custom") badTimes.add(entry);
  }
  return issues.filter((issue) => {
    const entry = timeEntry(issue);
    return !(entry !== undefined && issue.code === "custom" && badTimes.has(entry));
  });
}

/**
 * Everything wrong with the answers right now, checked in the browser with the same schemas the
 * server uses, plus the server's photo-reference issues from the last save and two questionnaire
 * rules: review attestation (§3.1 step 4) and a chosen web address.
 */
export function answerIssues(draft: { facts: unknown; brief: unknown }, view: Pick<SiteView, "slug">, serverPhotoIssues: readonly Issue[]): Issue[] {
  const facts = Facts.safeParse(draft.facts);
  const brief = Brief.safeParse(draft.brief);
  const issues: Issue[] = [
    ...(facts.success ? [] : withoutFalseOrder(under("facts", facts.error.issues))),
    ...(brief.success ? [] : under("brief", brief.error.issues)),
    ...serverPhotoIssues,
  ];
  const reviews = asArray(asRecord(draft.facts)["testimonials"]).length;
  if (reviews > 0 && asRecord(draft.brief)["reviewsAreReal"] !== true) {
    issues.push({ path: ["brief", "reviewsAreReal"], code: "attestation_required", message: "Confirm that your reviews are real" });
  }
  if (view.slug === null) issues.push({ path: ["slug"], code: "slug_missing", message: "Choose a web address" });
  return issues;
}

const STEP_PATHS: Record<StepId, Path[]> = {
  business: [["facts", "businessName"], ["facts", "trade"], ["facts", "phone"], ["facts", "email"], ["facts", "location"]],
  services: [["facts", "services"], ["facts", "freeEstimates"], ["facts", "emergency247"]],
  area: [["facts", "serviceArea"], ["facts", "hours"]],
  trust: [["facts", "licences"], ["facts", "insured"], ["facts", "yearFounded"], ["facts", "testimonials"], ["brief", "reviewsAreReal"]],
  photos: [["facts", "heroPhoto"], ["facts", "photos"], ["facts", "socialLinks"]],
  words: [["brief", "differentiator"], ["brief", "tone"], ["brief", "goal"], ["brief", "notes"], ["brief", "comments"]],
  address: [["slug"]],
};

export function stepOf(issue: Issue): StepId | null {
  // Each step's own "Anything we should know?" box is brief.comments.<step>: its problems belong there.
  const [root, part, key] = issue.path;
  if (root === "brief" && part === "comments" && (STEPS as readonly unknown[]).includes(key)) return key as StepId;
  for (const [step, prefixes] of Object.entries(STEP_PATHS) as Array<[StepId, Path[]]>) {
    if (prefixes.some((prefix) => prefix.every((p, i) => issue.path[i] === p))) return step;
  }
  return null;
}

export const issuesForStep = (issues: readonly Issue[], step: StepId): Issue[] => issues.filter((i) => stepOf(i) === step);
