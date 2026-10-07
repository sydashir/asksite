import { EMPTY_EDITS, type CopyEdits, type GenerationView, type Issue, type SiteView, type VersionSummary } from "@asksite/core";
import type { Copy } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { VALID_BRIEF, VALID_FACTS } from "../support/facts.ts";
import { json, readyOwner, useAppHarness } from "../support/harness.ts";

// Handoff 1b (DECIDED web-maker-d5, 2026-10-07): AI-only claim words in AI-written wording (packages/generation ai-claims.ts) are
// checked against the CURRENT answers at save, in the site view and before publishing, not only when the wording was written.
// A save is never refused; publishing is, with the same 422 publish_invalid as other claim issues, naming the field.

const h = useAppHarness();

type Saved = { rev: number; issues: SiteView["issues"] };
type ErrorJson = { error: { code: string; issues?: Issue[] } };

const LICENCE = { label: "Master Plumber", number: "M-40211" };
const EVERY_DAY = [{ days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"], opens: "08:00", closes: "18:00" }];
const SIX_DAYS = [{ days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"], opens: "08:00", closes: "18:00" }];

/** The owner's line for an AI-claim issue (the DECIDED text), with the claim words as the owner sees them in the wording. */
const owed = (...phrases: string[]) => `${phrases.map((p) => `“${p}”`).join(", ")} isn't backed by your answers. Edit this wording or update your answers.`;

/** Puts `text` at `field` of an AI draft's copy (only the fields these tests use). */
function copyWith(field: Field, text: string): Partial<Copy> {
  switch (field) {
    case "heroSubheadline":
    case "heroHeadline":
    case "about":
      return { [field]: text };
    case "services-intro":
      return { sectionIntros: { services: text, contact: "Tell us what you need and we will get back to you." } };
    case "drain-cleaning":
      return { serviceDescriptions: [{ service: "Drain cleaning", description: text }, { service: "Water heaters", description: "Done carefully by our team." }] };
    case "faq-answer":
      return { faq: [{ question: "Do you clean up after the job?", answer: text }] };
  }
}

/** The owner's own wording for the same field, as the editor saves it. */
function editOf(field: Field, text: string): CopyEdits {
  switch (field) {
    case "heroSubheadline":
    case "heroHeadline":
    case "about":
      return { [field]: text };
    case "services-intro":
      return { sectionIntros: { services: text } };
    case "drain-cleaning":
      return { serviceDescriptions: { "Drain cleaning": text } };
    case "faq-answer":
      return { faq: [{ question: "Do you clean up after the job?", answer: text }] };
  }
}

type Field = "heroSubheadline" | "heroHeadline" | "about" | "services-intro" | "drain-cleaning" | "faq-answer";

const PATH: Record<Field, Array<string | number>> = {
  heroSubheadline: ["copy", "heroSubheadline"],
  heroHeadline: ["copy", "heroHeadline"],
  about: ["copy", "about"],
  "services-intro": ["copy", "sectionIntros", "services"],
  "drain-cleaning": ["copy", "serviceDescriptions", 0, "description"],
  "faq-answer": ["copy", "faq", 0, "answer"],
};

/**
 * A built site whose AI wording has `text` at `field`, written while `facts` held, with a web address. The build is asked for
 * like the Questionnaire's Build (no kind: these tests are about the wording, not the request).
 */
async function aiOwner(facts: object, field: Field, text: string) {
  const owner = await readyOwner(h, facts, VALID_BRIEF);
  const started = await h.call("POST", `/api/sites/${owner.siteId}/generations`, { cookie: owner.cookie, body: {} });
  expect(started.status).toBe(202);
  const { generation } = await json<{ generation: GenerationView }>(started);
  expect((await h.call("POST", `/__test/generations/${generation.id}/finish`, { body: { status: "succeeded", copy: copyWith(field, text) } })).status).toBe(200);
  const slug = await h.call("PUT", `/api/sites/${owner.siteId}/slug`, { cookie: owner.cookie, body: { rev: owner.rev, slug: `ai-${crypto.randomUUID().slice(0, 8)}` } });
  expect(slug.status).toBe(200);
  let rev = (await json<{ rev: number }>(slug)).rev;
  const save = async (body: object) => {
    const res = await h.call("PATCH", `/api/sites/${owner.siteId}/draft`, { cookie: owner.cookie, body: { rev, ...body } });
    expect(res.status).toBe(200);
    const saved = await json<Saved>(res);
    rev = saved.rev;
    return saved;
  };
  const view = async () => json<SiteView>(await h.call("GET", `/api/sites/${owner.siteId}`, { cookie: owner.cookie }));
  const publish = () => h.call("POST", `/api/sites/${owner.siteId}/publish-requests`, { cookie: owner.cookie, body: { rev } });
  const versions = async () => (await (await h.db()).prepare("SELECT COUNT(*) AS n FROM site_versions WHERE site_id = ?").bind(owner.siteId).first<{ n: number }>())?.n;
  return { ...owner, generationId: generation.id, save, view, publish, versions };
}

/**
 * One case per AI-only claim family that a fact backs (ai-claims.ts NEEDS_A_FACT_IN_AI_COPY, in its order). Each wording passes
 * SiteDocument's own claims check (claims.ts), so only the AI-only check can flag it; `on` backs the claim, `off` is the answers
 * after the owner turned that fact off.
 */
const FAMILIES: ReadonlyArray<{ family: string; field: Field; text: string; phrase: string; on: object; off: object }> = [
  { family: "“lic.” (a licence)", field: "heroSubheadline", text: "Lic. plumbers who clean up after the job.", phrase: "Lic.", on: { licences: [LICENCE] }, off: { licences: [] } },
  { family: "“liability” and “ins.” (insured)", field: "about", text: "Liability coverage on the work we do in your home.", phrase: "Liability", on: { insured: true }, off: { insured: false } },
  { family: "“lic & ins” (both facts)", field: "drain-cleaning", text: "A lic & ins crew clears the line.", phrase: "lic & ins", on: { licences: [LICENCE], insured: true }, off: { licences: [LICENCE], insured: false } },
  { family: "“lic and insured” (both facts)", field: "faq-answer", text: "Yes. Our lic and insured crew tidies up.", phrase: "lic and insured", on: { licences: [LICENCE], insured: true }, off: { licences: [], insured: true } },
  { family: "the every-day words (hours on all seven days, or 24/7)", field: "services-intro", text: "Open daily for local homes.", phrase: "Open daily", on: { hours: EVERY_DAY }, off: { hours: SIX_DAYS } },
  { family: "the after-hours and holiday words (24/7 service)", field: "heroSubheadline", text: "After-hours help for burst pipes.", phrase: "After-hours", on: { emergency247: true }, off: { emergency247: false } },
  { family: "“free” in any form (free estimates)", field: "heroSubheadline", text: "Stress-free repairs from a local team.", phrase: "free", on: { freeEstimates: true }, off: { freeEstimates: false } },
  { family: "“no fees” and the like (free estimates)", field: "about", text: "No fees to come and take a look at the job.", phrase: "No fees", on: { freeEstimates: true }, off: { freeEstimates: false } },
];

describe("AI-only claims are checked against the answers as they are now (handoff 1b)", () => {
  it.each(FAMILIES)("$family: turned off, the save is stored and flags the field, the site view shows it, publishing is refused; back on, or the wording edited, clears it", async ({ field, text, phrase, on, off }) => {
    const factsOn = { ...VALID_FACTS, ...on };
    const factsOff = { ...VALID_FACTS, ...off };
    const owner = await aiOwner(factsOn, field, text);
    const issue: Issue = { path: PATH[field], code: "ai_claim", message: owed(phrase) };

    // While the fact holds, the wording is fine.
    expect((await owner.save({ facts: factsOn })).issues.document).toEqual([]);

    // The owner turns the fact off: the save is stored (never refused), and its answer names the field.
    const saved = await owner.save({ facts: factsOff });
    expect(saved.issues).toEqual({ facts: [], brief: [], photos: [], document: [issue] });
    const view = await owner.view();
    expect(view.facts).toEqual(factsOff);
    expect(view.rev).toBe(saved.rev);
    // The site view the editor loads shows the same issue.
    expect(view.issues.document).toEqual([issue]);

    // Publishing is refused, naming the field, and nothing is stored.
    const refused = await owner.publish();
    expect(refused.status).toBe(422);
    expect((await json<ErrorJson>(refused)).error).toEqual({ code: "publish_invalid", message: "A few things need fixing before this can be published", issues: [issue] });
    expect(await owner.versions()).toBe(0);

    // The owner rewrites that wording: it is theirs now, so the AI-only check skips it.
    const edited = await owner.save({ edits: { ...EMPTY_EDITS, baseGenerationId: owner.generationId, copy: editOf(field, "Careful work, done properly.") } });
    expect(edited.issues.document).toEqual([]);
    expect((await owner.view()).issues.document).toEqual([]);
    // Back to the AI's wording: flagged again.
    expect((await owner.save({ edits: { ...EMPTY_EDITS, baseGenerationId: owner.generationId } })).issues.document).toEqual([issue]);

    // The owner turns the fact back on: nothing to fix, and publishing goes through.
    expect((await owner.save({ facts: factsOn })).issues.document).toEqual([]);
    expect((await owner.view()).issues.document).toEqual([]);
    const sent = await owner.publish();
    expect(sent.status).toBe(201);
    expect((await json<{ version: VersionSummary }>(sent)).version.status).toBe("pending");
    await h.backgroundDone(`/api/sites/${owner.siteId}/publish-requests`);
  });

  it("a claim no answer can back (“background checked”) is flagged whatever the answers; only editing the wording clears it", async () => {
    const owner = await aiOwner(VALID_FACTS, "heroHeadline", "Background checked plumbers");
    const issue: Issue = { path: ["copy", "heroHeadline"], code: "ai_claim", message: owed("Background checked") };
    expect((await owner.save({ facts: { ...VALID_FACTS, insured: true, freeEstimates: true, emergency247: true, licences: [LICENCE] } })).issues.document).toEqual([issue]);
    expect((await owner.view()).issues.document).toEqual([issue]);
    const refused = await owner.publish();
    expect(refused.status).toBe(422);
    expect((await json<ErrorJson>(refused)).error.issues).toEqual([issue]);
    expect((await owner.save({ edits: { ...EMPTY_EDITS, baseGenerationId: owner.generationId, copy: { heroHeadline: "Plumbers you can reach" } } })).issues.document).toEqual([]);
    expect((await owner.publish()).status).toBe(201);
    await h.backgroundDone(`/api/sites/${owner.siteId}/publish-requests`);
  });

  it("one line per field: every claim word in it, each in curly quotes, joined by a comma", async () => {
    const owner = await aiOwner({ ...VALID_FACTS, freeEstimates: true, emergency247: true }, "heroSubheadline", "Stress-free after-hours help.");
    const saved = await owner.save({ facts: { ...VALID_FACTS, freeEstimates: false, emergency247: false } });
    // ai-claims.ts lists the every-day/after-hours words before "free" (NEEDS_A_FACT_IN_AI_COPY order).
    expect(saved.issues.document).toEqual([{ path: ["copy", "heroSubheadline"], code: "ai_claim", message: owed("after-hours", "free") }]);
  });

  it("the owner's own wording with the same word is not held to the AI-only list, but still meets SiteDocument's claims check", async () => {
    const owner = await aiOwner({ ...VALID_FACTS, licences: [LICENCE] }, "heroSubheadline", "Careful, tidy work from a local team you can reach.");
    const noLicence = { ...VALID_FACTS, licences: [] };
    // The owner writes "Lic." themselves: AI-only words are the model's rule, not the owner's (ai-claims.ts), so nothing is flagged.
    const own = await owner.save({ facts: noLicence, edits: { ...EMPTY_EDITS, baseGenerationId: owner.generationId, copy: { heroSubheadline: "Lic. plumbers who clean up after the job." } } });
    expect(own.issues.document).toEqual([]);
    expect((await owner.view()).issues.document).toEqual([]);
    // The owner's "Licensed" still meets the normal claims check: SiteDocument's own issue, not an AI-claim one.
    const licensed = await owner.save({ edits: { ...EMPTY_EDITS, baseGenerationId: owner.generationId, copy: { heroSubheadline: "Licensed plumbers who clean up after the job." } } });
    expect(licensed.issues.document).toEqual([{ path: ["copy", "heroSubheadline"], code: "custom", message: 'Copy states something the owner\'s facts do not back: "Licensed"' }]);
    const refused = await owner.publish();
    expect(refused.status).toBe(422);
    expect((await json<ErrorJson>(refused)).error.issues).toEqual(licensed.issues.document);
  });

  it("only a valid page is checked: while SiteDocument refuses the page, its own issues are the ones listed", async () => {
    const owner = await aiOwner({ ...VALID_FACTS, freeEstimates: true }, "heroSubheadline", "Stress-free repairs from a local team.");
    // A number in the owner's headline makes the page invalid; the AI wording's claim is listed once the page is valid again.
    const invalid = await owner.save({ facts: { ...VALID_FACTS, freeEstimates: false }, edits: { ...EMPTY_EDITS, baseGenerationId: owner.generationId, copy: { heroHeadline: "Call 555 today" } } });
    expect([...new Set(invalid.issues.document.map((i) => `${i.path.join(".")} ${i.code}`))]).toEqual(["copy.heroHeadline custom"]);
    const valid = await owner.save({ edits: { ...EMPTY_EDITS, baseGenerationId: owner.generationId, copy: { heroHeadline: "Call us today" } } });
    expect(valid.issues.document).toEqual([{ path: ["copy", "heroSubheadline"], code: "ai_claim", message: owed("free") }]);
  });
});
