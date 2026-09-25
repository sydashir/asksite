import { AiDraft, toIssues, type Issue } from "@asksite/core";
import { SiteDocument, type Facts } from "@asksite/site-schema";
import { wellFormed } from "./model-facts.ts";

export type DraftCheck = { ok: true; draft: AiDraft } | { ok: false; issues: Issue[] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Curly single quotes and primes read as ', curly double quotes and double primes as ". */
const foldQuotes = (text: string): string =>
  text.replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'").replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"');

/**
 * A name as a model may fairly retype it: compatibility forms, case, curly quotes and spacing do not
 * count. Quote marks are folded before NFKC, which would split U+2033 (an inch mark) into two primes,
 * and again after it, for the primes NFKC makes (U+2034 and U+2057 become three and four).
 */
const looseName = (name: string): string =>
  foldQuotes(foldQuotes(wellFormed(name)).normalize("NFKC").toLowerCase()).replace(/\s+/g, " ").trim();

/**
 * Plan 1 requires copy.serviceDescriptions[i].service to equal facts.services[i].name exactly,
 * and a model cannot always retype a name byte for byte (a pasted non-breaking space, an iPhone
 * apostrophe, decomposed accents, fullwidth letters). Where the entry at position i matches the
 * owner's name at position i loosely, the owner's exact name is put back; anything else stays as
 * the model wrote it, so a missing, extra or reordered entry is still reported. One exception: the
 * binding goes by position, so when two owner names are loosely equal (such as "Drain cleaning" and
 * "drain  Cleaning") and the model swaps their entries, each entry gets the exact name at its
 * position and nothing is reported; each description then shows under the other of those two
 * names, which read the same. The name is never rendered (the page shows the name from facts, and
 * the description at the same position). Returns a new value; never mutates `json`.
 */
export function bindServiceNames(facts: Facts, json: unknown): unknown {
  if (!isRecord(json) || !isRecord(json.copy) || !Array.isArray(json.copy.serviceDescriptions)) return json;
  const names = facts.services.map((s) => s.name);
  const serviceDescriptions = json.copy.serviceDescriptions.map((entry: unknown, i: number) => {
    const name = names[i];
    const matches = isRecord(entry) && typeof entry.service === "string" && name !== undefined && looseName(entry.service) === looseName(name);
    return matches ? { ...entry, service: name } : entry;
  });
  return { ...json, copy: { ...json.copy, serviceDescriptions } };
}

/**
 * The single acceptance test for AI output (design §6.1): the answer, with its service names bound
 * to the owner's (bindServiceNames), must be an AiDraft, and SiteDocument must accept it with these
 * facts and no hidden sections. That runs every Plan 1 rule: caps, no digits or links, Latin
 * script, hidden characters, the claim checker, the owner-fact sections and one description per
 * service. Returns the parsed draft.
 */
export function checkDraft(facts: Facts, json: unknown): DraftCheck {
  const shape = AiDraft.safeParse(bindServiceNames(facts, json));
  if (!shape.success) return { ok: false, issues: toIssues(shape.error) };
  const doc = SiteDocument.safeParse({ facts, ...shape.data, hidden: [] });
  if (!doc.success) return { ok: false, issues: toIssues(doc.error) };
  return { ok: true, draft: shape.data };
}
