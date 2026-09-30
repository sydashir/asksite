import type { Issue } from "@asksite/core";
import type { StepId } from "./route.ts";
import type { Path } from "./values.ts";

// Plain-language messages for every issue the schemas, the server and the claim checker return.
// A message may carry a fix: the questionnaire step and field that make the problem go away
// (e.g. "licensed" is allowed once a licence is added).

export interface Fix {
  step: StepId;
  field: Path;
  label: string;
}

export interface OwnerMessage {
  text: string;
  fix?: Fix;
}

const CLAIM_PREFIX = "Copy states something the owner's facts do not back: ";

const CLAIM_HINTS: ReadonlyArray<{ test: RegExp; hint: (word: string) => string; fix?: Fix }> = [
  { test: /^licen/i, hint: () => "To say “licensed”, add your license.", fix: { step: "trust", field: ["facts", "licences"], label: "Add a license" } },
  { test: /^insur/i, hint: () => "To say “insured”, check “We are insured”.", fix: { step: "trust", field: ["facts", "insured"], label: "Say you are insured" } },
  {
    test: /emergenc|clock|night|any.?time/i,
    hint: () => "To mention emergencies or round-the-clock service, turn on 24/7 emergency service.",
    fix: { step: "services", field: ["facts", "emergency247"], label: "Turn on 24/7 emergency service" },
  },
  {
    // "seven days a week" and the rest of the full-week phrase: backed by hours on every day or by 24/7 (A8c).
    test: /^seven\b.*\bweek$/i,
    hint: (word) => `To say “${word}”, set opening hours for all 7 days, or turn on 24/7 emergency service.`,
    fix: { step: "area", field: ["facts", "hours"], label: "Set your hours" },
  },
  {
    test: /free|charge|cost|complimentary/i,
    hint: () => "To say “free”, turn on free estimates.",
    fix: { step: "services", field: ["facts", "freeEstimates"], label: "Turn on free estimates" },
  },
  { test: /^bond/i, hint: () => "Please remove “bonded”: some states do not allow advertising the bond." },
  {
    test: /^(since|years?|decades?|established|founded|generations?)$/i,
    hint: (word) => `Your “Since” year shows on its own once you add your years in business. Please remove “${word}” here.`,
    fix: { step: "trust", field: ["facts", "yearFounded"], label: "Add your years in business" },
  },
  {
    test: /^(reviews?|says?|said)$|[“”„«»‘"]/i,
    hint: (word) => `Real reviews go in your answers, not in the wording. Please remove “${word}”.`,
    fix: { step: "trust", field: ["facts", "testimonials"], label: "Add real reviews" },
  },
  { test: /^(guarantee|warrant)/i, hint: (word) => `Please remove “${word}”: we cannot show guarantees we cannot check.` },
  {
    test: /day|weekend/i,
    hint: (word) => `Your opening hours show on their own. Please remove “${word}”.`,
    fix: { step: "area", field: ["facts", "hours"], label: "Set your hours" },
  },
  { test: /^(cheapest|lowest|dollars?|bucks|cents)$/i, hint: (word) => `Prices show from your services list. Please remove “${word}”.` },
  { test: /\.(com|net|org|us|biz|info|co|io)$/i, hint: (word) => `Web addresses cannot go in the wording. Please remove “${word}”.` },
  { test: /./, hint: (word) => `Please remove “${word}”: we cannot show ratings, awards or numbers we cannot check.` },
];

function claimWords(message: string): string[] {
  return [...message.slice(CLAIM_PREFIX.length).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1] ?? ""}"`) as string);
}

function claimMessage(message: string): OwnerMessage {
  const hints = claimWords(message).map((word) => {
    const rule = CLAIM_HINTS.find((r) => r.test.test(word)) ?? CLAIM_HINTS[CLAIM_HINTS.length - 1]!;
    return { text: rule.hint(word), fix: rule.fix };
  });
  const text = [...new Set(hints.map((h) => h.text))].join(" ");
  const fix = hints.find((h) => h.fix !== undefined)?.fix;
  return fix === undefined ? { text } : { text, fix };
}

const key = (path: Path): string => path.map((p) => (typeof p === "number" ? "#" : p)).join(".");

const BY_PATH: Record<string, string> = {
  "facts.businessName": "Enter your business name (at least 2 characters).",
  "facts.trade": "Choose the kind of work you do.",
  "facts.phone": "Enter a 10-digit US phone number, like (512) 555-0142.",
  "facts.email": "Enter an email address, like name@example.com.",
  "facts.location.city": "Enter your city.",
  "facts.location.state": "Choose your state.",
  "facts.location.postalCode": "Enter a 5-digit ZIP code, or leave it empty.",
  "facts.yearFounded": "Enter the number of whole years you have been in business, like 12.",
  "facts.services": "Add at least one service.",
  "facts.services.#.startingPrice": "Enter a whole number of dollars, like 89, or leave it empty.",
  "facts.serviceArea.places": "Add at least one city or ZIP code you serve.",
  "facts.hours.#.opens": "Please enter a time.",
  "facts.hours.#.closes": "Please enter a time.",
  "facts.hours": "Each day can have only one set of hours.",
  "facts.heroPhoto.url": "Choose this photo again from your uploads.",
  "facts.photos.#.url": "Choose this photo again from your uploads.",
  "facts.socialLinks.#.url": "Enter the full link to your page on that site, starting with https://.",
  "brief.tone": "Choose how your website should sound.",
  "brief.goal": "Choose what visitors should do first.",
};

const BY_CODE: Record<string, OwnerMessage> = {
  attestation_required: {
    text: "Check the box to confirm these reviews are from real customers.",
    fix: { step: "trust", field: ["brief", "reviewsAreReal"], label: "Confirm your reviews" },
  },
  slug_missing: { text: "Choose a web address for your website.", fix: { step: "address", field: ["slug"], label: "Choose a web address" } },
  slug_invalid: { text: "Please choose a different web address.", fix: { step: "address", field: ["slug"], label: "Choose a web address" } },
  not_generated: { text: "Build your website before publishing it." },
  photo_ref: { text: "Choose this photo again from your uploads.", fix: { step: "photos", field: ["facts", "photos"], label: "Go to your photos" } },
};

/** The limit in zod's size message ("Too big: expected number to be <=100000"), which zod writes from the issue's maximum or minimum. */
const limitOf = (issue: Issue): string | undefined => /(<=|>=)\s*(\d+)/.exec(issue.message)?.[2];

const dollars = (n: string): string => Number(n).toLocaleString("en-US");

/**
 * Fields whose message depends on the issue, not only on the field (approved amendment, task-12-extra.md). The
 * price limits come from the issue, so they follow the schema.
 */
const BY_PATH_AND_ISSUE = new Map<string, (issue: Issue) => string | undefined>([
  [
    "facts.services.#.startingPrice",
    (issue) => {
      const n = limitOf(issue);
      if (issue.code === "too_big" && n !== undefined) return `Please enter a price of $${dollars(n)} or less.`;
      if (issue.code === "too_small" && n !== undefined) return `Please enter a price of at least $${dollars(n)}.`;
      // z.int() on a number with cents: "Invalid input: expected int, received number".
      if (issue.code === "invalid_type" && /\bexpected int\b/.test(issue.message)) return "Please enter whole dollars, no cents.";
      return undefined;
    },
  ],
]);

/** The opening-hours entry an issue is on, when the issue is at that entry's opening or closing time. */
function timeEntry(issue: Issue): number | undefined {
  const [root, list, entry, field] = issue.path;
  const atTime = issue.path.length === 4 && root === "facts" && list === "hours" && (field === "opens" || field === "closes");
  return atTime && typeof entry === "number" ? entry : undefined;
}

/** The order check ("closes must be later than opens", site-schema facts.ts) is the one custom issue at a closing time. */
const isOrderCheck = (issue: Issue): boolean => timeEntry(issue) !== undefined && issue.path[3] === "closes" && issue.code === "custom";

function byLengthCode(issue: Issue): string | null {
  const n = limitOf(issue);
  if (issue.code === "too_big" && n !== undefined) {
    // The one map is copy.serviceDescriptions: "Too big: expected map to have <=12 entries" (A8c-2).
    if (issue.message.includes("map")) return `You can describe at most ${n} services.`;
    return issue.message.includes("items") ? `You can add up to ${n}.` : `Please use ${n} characters or fewer.`;
  }
  if (issue.code === "too_small" && n !== undefined) {
    if (issue.message.includes("items")) return "Please add at least one.";
    return n === "1" ? "Please fill this in." : `Please use at least ${n} characters.`;
  }
  return null;
}

export function ownerMessage(issue: Issue): OwnerMessage {
  const coded = BY_CODE[issue.code];
  if (coded !== undefined) return coded;
  if (issue.message.startsWith(CLAIM_PREFIX)) return claimMessage(issue.message);
  if (issue.message.startsWith("Copy must not contain numbers")) {
    return {
      text: "Numbers, prices, @ and web links cannot go in the wording. Your phone number, prices and “Since” year show on the page from your answers.",
      fix: { step: "business", field: ["facts", "phone"], label: "See your answers" },
    };
  }
  if (issue.message.startsWith("AI copy must use Latin script")) return { text: "Please use English letters here." };
  if (/invisible|control/i.test(issue.message)) return { text: "This text has hidden characters. Please delete it and type it again." };
  if (isOrderCheck(issue)) return { text: "Closing time must be after opening time." };
  const field = key(issue.path);
  const specific = BY_PATH_AND_ISSUE.get(field)?.(issue);
  if (specific !== undefined) return { text: specific };
  const pathText = BY_PATH[field];
  if (pathText !== undefined && issue.code !== "too_big") return { text: pathText };
  const lengthText = byLengthCode(issue);
  if (lengthText !== null) return { text: lengthText };
  if (issue.code === "invalid_type") return { text: "Please fill this in." };
  if (issue.code === "invalid_value") return { text: "Please choose one." };
  if (issue.message === "Must be an absolute https:// URL") return { text: "Enter a full web address starting with https://." };
  if (issue.message === "Link must point at that network's own site") return { text: "This link must go to that network's own site." };
  return { text: "Please check this answer." };
}

/** A too_big issue's limit, or undefined for any other issue. */
function maximumOf(issue: Issue): number | undefined {
  const n = issue.code === "too_big" ? limitOf(issue) : undefined;
  return n === undefined ? undefined : Number(n);
}

/**
 * The issues to show the owner and to count. Pass every issue list that is shown or counted through it
 * (answerIssues does; so must the lists the server returns and the editor's preview list).
 *
 * - The opening-hours order check also runs on an empty or malformed time ("08:00" < "" is false) and then gives
 *   the wrong reason. It is kept only for two valid times: an entry with another issue at either time loses it,
 *   so each time field shows exactly one message (approved amendment, task-12-extra.md; review I-1).
 * - From 2^53 up, z.int() adds its own safe-integer limit (<=9007199254740991) next to the field's own maximum.
 *   Of several too_big issues at one field only the tightest is kept, so a very long price shows only the
 *   "$100,000 or less" message, once (review I-2).
 */
export function issuesToShow(issues: readonly Issue[]): Issue[] {
  const badTimes = new Set<number>();
  const tightest = new Map<string, number>();
  for (const issue of issues) {
    const entry = timeEntry(issue);
    if (entry !== undefined && !isOrderCheck(issue)) badTimes.add(entry);
    const max = maximumOf(issue);
    const at = JSON.stringify(issue.path);
    if (max !== undefined) tightest.set(at, Math.min(max, tightest.get(at) ?? max));
  }
  return issues.filter((issue) => {
    const entry = timeEntry(issue);
    if (entry !== undefined && isOrderCheck(issue)) return !badTimes.has(entry);
    const max = maximumOf(issue);
    return max === undefined || max === tightest.get(JSON.stringify(issue.path));
  });
}

/** Issues at `path` exactly (one field). */
export const issuesAt = (issues: readonly Issue[], path: Path): Issue[] =>
  issues.filter((i) => i.path.length === path.length && path.every((p, n) => i.path[n] === p));

/** Issues at `path` or below it (a whole list or group). */
export const issuesUnder = (issues: readonly Issue[], path: Path): Issue[] => issues.filter((i) => path.every((p, n) => i.path[n] === p));
