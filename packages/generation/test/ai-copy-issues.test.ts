import { AiDraft, composeDocument, EMPTY_EDITS, ownerEditedPaths, type OwnerEdits } from "@asksite/core";
import { DAYS, Facts, SiteDocument } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import * as publicApi from "../src/index.ts";
import { aiCopyIssues } from "../src/index.ts";
import { templateAnswer } from "../src/template.ts";
import { checkDraft } from "../src/validate.ts";
import { FULL_SNAPSHOT } from "./support/samples.ts";

// Plan 4 composes the page from the stored draft and the owner's edits with the CURRENT facts, and SiteDocument runs again; the
// AI-only rules (ai-claims.ts) ran once at generation against the snapshot's facts. aiCopyIssues is the export that runs them again
// over the composed copy, skipping what the owner wrote (ownerEditedPaths, as core computes it).

const on = FULL_SNAPSHOT.facts; // licences, insured, emergency247 and freeEstimates all on
const base = JSON.parse(JSON.stringify(templateAnswer(on, FULL_SNAPSHOT.brief)));
const off = (change: Record<string, unknown>): Facts => Facts.parse({ ...on, ...change });
const NO_FREE = off({ freeEstimates: false });

/** [the AI's sentence, facts it was written with, facts now, the words the refusal names] */
const CASES: ReadonlyArray<readonly [string, Facts, Facts, readonly string[]]> = [
  ["Liability coverage on every job we take", on, off({ insured: false }), ["Liability"]],
  ["Fully ins. crew for every repair", on, off({ insured: false }), ["ins."]],
  ["Lic. plumbers on every job", on, off({ licences: [] }), ["Lic."]],
  ["Help after hours and on holidays", on, off({ emergency247: false }), ["after hours"]],
  [
    "Open daily for your calls",
    off({ emergency247: false, hours: [{ days: [...DAYS], opens: "08:00", closes: "17:00" }] }),
    off({ emergency247: false, hours: [{ days: DAYS.slice(0, 5), opens: "08:00", closes: "17:00" }] }),
    ["Open daily"],
  ],
  ["Stress-free estimates for every job", on, NO_FREE, ["free"]],
  ["No fees for estimates, ever", on, NO_FREE, ["No fees"]],
  ["Estimates are on the house", on, NO_FREE, ["on the house"]],
];

/** What Plan 4 does: the answer checked and stored with the snapshot's facts, then composed with the facts of today. */
function composed(sentence: string, factsThen: Facts, factsNow: Facts, edits: OwnerEdits = EMPTY_EDITS) {
  const answer = { ...base, copy: { ...base.copy, ctaText: "Request a quote", heroSubheadline: sentence } };
  const checked = checkDraft(factsThen, answer);
  if (!checked.ok) throw new Error(`the sentence was refused at generation: ${JSON.stringify(checked.issues)}`);
  const ai = { generationId: "g1", draft: AiDraft.parse(JSON.parse(JSON.stringify(checked.draft))) };
  const doc = composeDocument(factsNow, ai, edits);
  return { ai, doc, parsed: SiteDocument.safeParse(doc) };
}

const message = (words: readonly string[]): string => `Copy states something the owner's facts do not back: ${words.map((w) => JSON.stringify(w)).join(", ")}`;

describe("aiCopyIssues: AI wording that a fact no longer backs", () => {
  it.each(CASES)("refuses %s once the fact is off, and SiteDocument alone still accepts it (the gap)", (sentence, factsThen, factsNow, words) => {
    const { doc, parsed } = composed(sentence, factsThen, factsNow);
    expect(parsed.success).toBe(true); // the gap this export closes
    expect(aiCopyIssues(factsNow, (doc as SiteDocument).copy, [])).toEqual([
      { path: ["copy", "heroSubheadline"], code: "custom", message: message(words) },
    ]);
  });

  it.each(CASES)("reports nothing for %s while the fact is on", (sentence, factsThen) => {
    const { doc } = composed(sentence, factsThen, factsThen);
    expect(aiCopyIssues(factsThen, (doc as SiteDocument).copy, [])).toEqual([]);
  });

  it("uses the facts it is given, not the facts the draft was generated with", () => {
    const { doc } = composed("Stress-free estimates for every job", on, NO_FREE);
    const copy = (doc as SiteDocument).copy;
    expect(aiCopyIssues(on, copy, [])).toEqual([]);
    expect(aiCopyIssues(NO_FREE, copy, [])).toHaveLength(1);
  });

  it("gives the same issues as checkDraft's own check (shape and message)", () => {
    const answer = { ...base, copy: { ...base.copy, ctaText: "Request a quote", heroSubheadline: "Estimates are on the house" } };
    const refused = checkDraft(NO_FREE, answer);
    expect(refused.ok).toBe(false);
    const { doc } = composed("Estimates are on the house", on, NO_FREE);
    expect(aiCopyIssues(NO_FREE, (doc as SiteDocument).copy, [])).toEqual(refused.ok ? [] : refused.issues);
  });
});

describe("aiCopyIssues: owner-edited fields are skipped", () => {
  const OWNER_WORD = "Stress-free estimates for every job";

  it("skips a field whose path is in ownerEditedPaths and reports the AI's other fields", () => {
    const answer = { ...base, copy: { ...base.copy, ctaText: "Request a quote", heroSubheadline: "Estimates are on the house" } };
    const checked = checkDraft(on, answer);
    if (!checked.ok) throw new Error("refused");
    const ai = { generationId: "g1", draft: AiDraft.parse(JSON.parse(JSON.stringify(checked.draft))) };
    const edits: OwnerEdits = { ...EMPTY_EDITS, baseGenerationId: "g1", copy: { heroHeadline: OWNER_WORD } };
    const doc = composeDocument(NO_FREE, ai, edits) as SiteDocument;
    const paths = ownerEditedPaths(ai, edits);
    expect(paths).toEqual(["copy.heroHeadline"]);
    // the owner's "free" is not reported; the AI's "on the house" is
    expect(aiCopyIssues(NO_FREE, doc.copy, paths)).toEqual([{ path: ["copy", "heroSubheadline"], code: "custom", message: message(["on the house"]) }]);
    // with no skip list the owner's field would be reported too
    expect(aiCopyIssues(NO_FREE, doc.copy, []).map((i) => i.path.join("."))).toEqual(["copy.heroHeadline", "copy.heroSubheadline"]);
  });

  it("skips an edited section intro, the about text and the cta text by their paths", () => {
    const { ai } = composed("Request a quote today", on, on);
    const edits: OwnerEdits = { ...EMPTY_EDITS, baseGenerationId: "g1", copy: { about: "Free quotes, always", ctaText: "Free quote", sectionIntros: { services: "No fees, ever" } } };
    const doc = composeDocument(NO_FREE, ai, edits) as SiteDocument;
    const paths = ownerEditedPaths(ai, edits);
    expect(paths).toEqual(["copy.ctaText", "copy.about", "copy.sectionIntros.services"].sort((a, b) => paths.indexOf(a) - paths.indexOf(b)));
    expect(aiCopyIssues(NO_FREE, doc.copy, paths)).toEqual([]);
    expect(aiCopyIssues(NO_FREE, doc.copy, []).length).toBeGreaterThanOrEqual(3);
  });

  it("skips an edited service description by the service name, and only that one", () => {
    const { ai } = composed("Request a quote today", on, on);
    const edits: OwnerEdits = { ...EMPTY_EDITS, baseGenerationId: "g1", copy: { serviceDescriptions: { "Drain cleaning": "Free camera look at every drain" } } };
    const doc = composeDocument(NO_FREE, ai, edits) as SiteDocument;
    const paths = ownerEditedPaths(ai, edits);
    expect(paths).toEqual(["copy.serviceDescriptions.Drain cleaning"]);
    expect(aiCopyIssues(NO_FREE, doc.copy, paths)).toEqual([]);
    // the other service keeps its AI description, so the same word there is still reported
    const other = { ...doc.copy, serviceDescriptions: doc.copy.serviceDescriptions.map((d) => (d.service === "Leak repair" ? { ...d, description: "Free leak checks" } : d)) };
    expect(aiCopyIssues(NO_FREE, other, paths).map((i) => i.path.join("."))).toEqual(["copy.serviceDescriptions.1.description"]);
  });

  it("skips an edited faq as a whole", () => {
    const { ai } = composed("Request a quote today", on, on);
    const edits: OwnerEdits = { ...EMPTY_EDITS, baseGenerationId: "g1", copy: { faq: [{ question: "Is the estimate free?", answer: "Yes, free of charge" }] } };
    const doc = composeDocument(NO_FREE, ai, edits) as SiteDocument;
    expect(aiCopyIssues(NO_FREE, doc.copy, ownerEditedPaths(ai, edits))).toEqual([]);
  });

  it("does not skip edits made on an older draft (core reports no path for them)", () => {
    // The AI's own heroSubheadline holds a claim the facts no longer back, and the edit (on an older draft) targets that very field:
    // core applies no such edit and reports no path, so the AI's claim must still be reported. A skip taken from the edit alone would hide it.
    const { ai } = composed("Estimates are on the house", on, on);
    const edits: OwnerEdits = { ...EMPTY_EDITS, baseGenerationId: "older", copy: { heroSubheadline: "Call us today" } };
    const doc = composeDocument(NO_FREE, ai, edits) as SiteDocument;
    expect(ownerEditedPaths(ai, edits)).toEqual([]);
    expect(aiCopyIssues(NO_FREE, doc.copy, ownerEditedPaths(ai, edits))).toEqual([
      { path: ["copy", "heroSubheadline"], code: "custom", message: message(["on the house"]) },
    ]);
  });
});

describe("the public API", () => {
  it("exports aiCopyIssues and aiClaims, and keeps the claim rules' other functions private", () => {
    expect(typeof publicApi.aiCopyIssues).toBe("function");
    // aiClaims is public by d5's 2026-10-07 ruling: the owner app shows owners the exact unbacked phrases it matched. Only it and aiCopyIssues are public.
    expect(typeof publicApi.aiClaims).toBe("function");
    expect(["aiClaimIssues", "sevenDaysBacking"].filter((name) => name in publicApi)).toEqual([]);
  });
});
