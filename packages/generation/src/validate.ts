import { AiAnswer, draftFromAnswer, toIssues, type AiDraft, type Issue } from "@asksite/core";
import { SiteDocument, type Facts } from "@asksite/site-schema";
import { wellFormed } from "./model-facts.ts";
import { AI_DRAFT_JSON_SCHEMA, toWireSchema } from "./wire-schema.ts";

export type DraftCheck = { ok: true; draft: AiDraft } | { ok: false; issues: Issue[] };

type Schema = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The schema the model answers to, as the adapters send it: there `const` is a one-value `enum` and `oneOf` is `anyOf`. */
const WIRE_SCHEMA = toWireSchema(AI_DRAFT_JSON_SCHEMA);

const branchesOf = (node: Schema): Schema[] => (Array.isArray(node.anyOf) ? node.anyOf.filter(isRecord) : []);

/** Every value an `enum` allows at this position, its anyOf branches' included. */
const enumValues = (node: Schema): unknown[] => [...(Array.isArray(node.enum) ? node.enum : []), ...branchesOf(node).flatMap(enumValues)];

/** The one member that `value` names, ignoring case and surrounding spaces; `value` itself when none or several match. */
function enumMember(node: Schema, value: string): string {
  const wanted = value.trim().toLowerCase();
  const matches = new Set(enumValues(node).filter((member): member is string => typeof member === "string" && member.toLowerCase() === wanted));
  return matches.size === 1 ? [...matches][0]! : value;
}

/** A union branch fits an object when each of its enum-typed properties accepts the object's value there, case normalized. */
function fits(branch: Schema, value: Record<string, unknown>): boolean {
  if (!isRecord(branch.properties)) return false;
  return Object.entries(branch.properties).every(([key, child]) => {
    if (!isRecord(child)) return true;
    const allowed = enumValues(child);
    return allowed.length === 0 || allowed.includes(normalizeEnumCase(child, Object.hasOwn(value, key) ? value[key] : undefined));
  });
}

/** `value` with its schema-known properties normalized; the same object when none changed. */
function withProperties(properties: Schema, value: Record<string, unknown>): Record<string, unknown> {
  let changed = false;
  const entries = Object.entries(value).map(([key, child]): [string, unknown] => {
    const schema = Object.hasOwn(properties, key) ? properties[key] : undefined;
    const normal = isRecord(schema) ? normalizeEnumCase(schema, child) : child;
    if (!Object.is(normal, child)) changed = true;
    return [key, normal];
  });
  // Object.fromEntries defines own data properties, so an own "__proto__" key stays data and never sets a prototype.
  return changed ? Object.fromEntries(entries) : value;
}

/**
 * Anthropic documents that structured outputs may change the case of an `enum` or `const` value ("Compare enum
 * values case-insensitively", structured-outputs, "Enum value casing"). This walks `schema` (the wire form) alongside
 * `value` and, at each enum position, replaces a string whose trimmed, case-insensitive form matches exactly one
 * member with that member; no match or several (members that differ only in case) leave it as written, for
 * validation to report. At a union (anyOf) position a string is matched against the members of every branch, and
 * an object is followed into the one branch whose enum-typed properties all accept its values (so a section's id in
 * another case picks its branch); when no branch or several fit, or the value is an array, it stays as written.
 * Arrays follow `items`, objects follow `properties` only: keys are never added, and a key the schema does not name
 * keeps its value. Free text (every non-enum string, service names included) is never changed. Pure: the input is
 * never mutated; the result is the input itself when nothing changed, with new objects and arrays only on the path
 * to a changed value.
 */
export function normalizeEnumCase(schema: Schema, value: unknown): unknown {
  if (typeof value === "string") return enumMember(schema, value);
  const branches = branchesOf(schema);
  if (branches.length > 0) {
    if (!isRecord(value)) return value;
    const fitting = branches.filter((branch) => fits(branch, value));
    return fitting.length === 1 ? normalizeEnumCase(fitting[0]!, value) : value;
  }
  if (Array.isArray(value)) {
    const items = schema.items;
    if (!isRecord(items)) return value;
    const normal = value.map((item: unknown) => normalizeEnumCase(items, item));
    return normal.some((item, i) => !Object.is(item, value[i])) ? normal : value;
  }
  if (isRecord(value) && isRecord(schema.properties)) return withProperties(schema.properties, value);
  return value;
}

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
 * The single acceptance test for AI output (design §6.1): the answer, with the case of its enum values
 * normalized (normalizeEnumCase) and its service names bound to the owner's (bindServiceNames), must be
 * an AiAnswer (no page design: A12), and SiteDocument must accept the draft it makes with these facts and
 * no hidden sections. That runs every Plan 1 rule: caps, no digits or links, Latin script, hidden
 * characters, the claim checker, the owner-fact sections and one description per service. The two steps
 * touch different positions (enum values; the free-text service names), so their order does not change the
 * result. Returns the draft to store: the parsed answer on the trade's design (draftFromAnswer).
 */
export function checkDraft(facts: Facts, json: unknown): DraftCheck {
  const shape = AiAnswer.safeParse(bindServiceNames(facts, normalizeEnumCase(WIRE_SCHEMA, json)));
  if (!shape.success) return { ok: false, issues: toIssues(shape.error) };
  const draft = draftFromAnswer(shape.data, facts.trade);
  const doc = SiteDocument.safeParse({ facts, ...draft, hidden: [] });
  if (!doc.success) return { ok: false, issues: toIssues(doc.error) };
  return { ok: true, draft };
}
