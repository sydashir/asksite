import { render } from "@asksite/renderer";
import { SiteDocument, type SiteDocumentInput } from "@asksite/site-schema";
import { describe, expect, expectTypeOf, it } from "vitest";
import { FIXTURES, loadFixture } from "../../../fixtures/index.ts";
import {
  AiDraft,
  canonicalJson,
  composeDocument,
  documentSha256,
  EMPTY_EDITS,
  mediaUrl,
  OwnerEdits,
  ownerEditedPaths,
  photoRefIssues,
  SECTION_IDS,
  SectionOrder,
  type CopyEdits,
  type CurrentAi,
} from "../src/index.ts";

const GEN = "11111111-1111-4111-8111-111111111111";
const OLD_GEN = "22222222-2222-4222-8222-222222222222";

/** A fixture split the way the app stores it: owner facts, and the AI draft from generation GEN. */
function split(input: SiteDocumentInput): { facts: unknown; ai: CurrentAi } {
  const { facts, copy, layout, theme } = input;
  return { facts, ai: { generationId: GEN, draft: AiDraft.parse({ copy, layout, theme }) } };
}

const edits = (patch: Partial<OwnerEdits> = {}): OwnerEdits => ({ ...EMPTY_EDITS, baseGenerationId: GEN, ...patch });
const issuesOf = (doc: unknown) => {
  const result = SiteDocument.safeParse(doc);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("composeDocument", () => {
  it.each(FIXTURES)("with no edits, %s composes to a document that renders the same page", (name) => {
    const fixture = loadFixture(name);
    const { facts, ai } = split(fixture);
    const composed = SiteDocument.parse(composeDocument(facts, ai, EMPTY_EDITS));
    const options = { stylesheet: "/* css */", formAction: "https://joes.asksite.example/_f/x" };
    expect(render(composed, options)).toBe(render(fixture, options));
  });

  it("stays valid when the owner adds a first photo, review and licence after generation", () => {
    const fixture = loadFixture("cleaning-minimal");
    const { facts, ai } = split({
      ...fixture,
      layout: [
        { id: "hero", variant: "centered" },
        { id: "services", variant: "cards" },
        { id: "serviceArea", variant: "split" },
        { id: "contact", variant: "card" },
      ],
    });
    const grown = {
      ...(facts as Record<string, unknown>),
      photos: [{ url: "https://media.asksite.example/a/b.webp", alt: "Clean kitchen", width: 1600, height: 1200 }],
      testimonials: [{ quote: "Spotless.", name: "Ana" }],
      licences: [{ label: "City business licence", number: "BL-1" }],
    };
    const composed = composeDocument(grown, ai, EMPTY_EDITS);
    expect(composed.layout.map((s) => s.id)).toEqual(["hero", "services", "serviceArea", "trust", "testimonials", "gallery", "about", "faq", "contact"]);
    expect(issuesOf(composed)).toEqual([]);
  });

  it("puts missing sections at the end when the AI layout has no contact section", () => {
    const { facts, ai } = split(loadFixture("cleaning-minimal"));
    const noContact = { ...ai, draft: { ...ai.draft, layout: ai.draft.layout.filter((s) => s.id !== "contact") } };
    expect(composeDocument(facts, noContact, EMPTY_EDITS).layout.at(-1)).toEqual({ id: "contact", variant: "card" });
  });

  it("applies wording edits with whitespace collapsed, and null removes an optional field", () => {
    const { facts, ai } = split(loadFixture("plumber-austin"));
    const composed = composeDocument(facts, ai, edits({
      copy: {
        heroHeadline: "Honest   plumbing\n\nfor Austin homes",
        about: null,
        sectionIntros: { services: null, faq: "Answers\tbefore you call." },
      },
    }));
    expect(composed.copy.heroHeadline).toBe("Honest plumbing for Austin homes");
    expect(composed.copy).not.toHaveProperty("about");
    expect(composed.copy.sectionIntros).not.toHaveProperty("services");
    expect(composed.copy.sectionIntros?.faq).toBe("Answers before you call.");
    expect(composed.copy.sectionIntros?.gallery).toBe(ai.draft.copy.sectionIntros.gallery);
    expect(issuesOf(composed)).toEqual([]);
  });

  it("still runs every Plan 1 copy rule on owner edits", () => {
    const { facts, ai } = split(loadFixture("plumber-austin"));
    const composed = composeDocument(facts, ai, edits({ copy: { heroHeadline: "Call 512-555-0142 now" } }));
    expect(issuesOf(composed)).toEqual(["copy.heroHeadline: Copy must not contain numbers, currency symbols, @ or links; facts come from the owner"]);
  });

  it("ignores copy and order edits made for an older generation, but keeps hidden and theme", () => {
    const { facts, ai } = split(loadFixture("plumber-austin"));
    const stale = edits({
      baseGenerationId: OLD_GEN,
      copy: { heroHeadline: "Old wording" },
      order: ["hero", "faq", ...SECTION_IDS.filter((id) => id !== "hero" && id !== "faq")],
      hidden: ["faq"],
      theme: { palette: "charcoal-red", font: "sturdy" },
    });
    const composed = composeDocument(facts, ai, stale);
    expect(composed.copy.heroHeadline).toBe(ai.draft.copy.heroHeadline);
    expect(composed.layout.map((s) => s.id)).toEqual(ai.draft.layout.map((s) => s.id));
    expect(composed.hidden).toEqual(["faq"]);
    expect(composed.theme).toEqual({ palette: "charcoal-red", font: "sturdy" });
    expect(ownerEditedPaths(ai, stale)).toEqual([]);
  });

  it("sorts the layout into the owner's order and keeps each variant", () => {
    const { facts, ai } = split(loadFixture("plumber-austin"));
    const order = ["hero", "faq", "services", "trust", "testimonials", "gallery", "about", "serviceArea", "contact"] as const;
    const composed = composeDocument(facts, ai, edits({ order: [...order] }));
    expect(composed.layout).toEqual([
      { id: "hero", variant: "photo" },
      { id: "faq", variant: "accordion" },
      { id: "services", variant: "cards" },
      { id: "trust", variant: "band" },
      { id: "testimonials", variant: "grid" },
      { id: "gallery", variant: "grid" },
      { id: "about", variant: "plain" },
      { id: "serviceArea", variant: "split" },
      { id: "contact", variant: "card" },
    ]);
  });

  it("matches service descriptions by name, including names that are Object.prototype keys", () => {
    const fixture = loadFixture("cleaning-minimal");
    const services = [{ name: "constructor" }, { name: "__proto__" }, { name: "toString" }];
    const { facts, ai } = split({
      ...fixture,
      facts: { ...fixture.facts, services },
      copy: {
        ...fixture.copy,
        serviceDescriptions: services.map((s) => ({ service: s.name, description: `AI text for ${s.name.replaceAll("_", "")}.` })),
      },
    });
    const owner = OwnerEdits.parse(JSON.parse(JSON.stringify({ ...edits(), copy: { serviceDescriptions: { constructor: "Owner  text." } } })));
    const composed = composeDocument(facts, ai, owner);
    expect(composed.copy.serviceDescriptions).toEqual([
      { service: "constructor", description: "Owner text." },
      { service: "__proto__", description: "AI text for proto." },
      { service: "toString", description: "AI text for toString." },
    ]);
    expect(issuesOf(composed)).toEqual([]);
  });

  it("keeps the owner's description for a service named __proto__ added after generation", () => {
    const { facts, ai } = split(loadFixture("cleaning-minimal"));
    const grown = { ...(facts as Record<string, unknown>), services: [{ name: "House cleaning" }, { name: "Move-out cleaning" }, { name: "__proto__" }] };
    // A saved edit arrives as JSON, and JSON.parse keeps "__proto__" as an ordinary own key.
    const owner = OwnerEdits.parse({ ...edits(), copy: JSON.parse('{"serviceDescriptions":{"__proto__":"Owner  text."}}') });
    const composed = composeDocument(grown, ai, owner);
    expect(composed.copy.serviceDescriptions.at(-1)).toEqual({ service: "__proto__", description: "Owner text." });
    expect(issuesOf(composed)).toEqual([]);
    expect(ownerEditedPaths(ai, owner)).toEqual(["copy.serviceDescriptions.__proto__"]);
  });

  it("leaves a new service's description empty so the document reports it", () => {
    const fixture = loadFixture("cleaning-minimal");
    const { facts, ai } = split(fixture);
    const grown = { ...(facts as Record<string, unknown>), services: [{ name: "House cleaning" }, { name: "Move-out cleaning" }, { name: "Window washing" }] };
    const composed = composeDocument(grown, ai, EMPTY_EDITS);
    expect(composed.copy.serviceDescriptions.at(-1)).toEqual({ service: "Window washing", description: "" });
    expect(issuesOf(composed)).toContain("copy.serviceDescriptions.2.description: Too small: expected string to have >=1 characters");
  });

  it("gives an empty service list when facts are not usable yet", () => {
    const { ai } = split(loadFixture("cleaning-minimal"));
    expect(composeDocument(null, ai, EMPTY_EDITS).copy.serviceDescriptions).toEqual([]);
    expect(composeDocument({ services: "oops" }, ai, EMPTY_EDITS).copy.serviceDescriptions).toEqual([]);
  });

  it("replaces the FAQ list with the owner's list", () => {
    const { facts, ai } = split(loadFixture("plumber-austin"));
    const composed = composeDocument(facts, ai, edits({ copy: { faq: [{ question: "Do you  clean up?", answer: "Always." }] } }));
    expect(composed.copy.faq).toEqual([{ question: "Do you clean up?", answer: "Always." }]);
  });

  it("never shares state: EMPTY_EDITS is frozen and the document gets its own hidden list", () => {
    expect([Object.isFrozen(EMPTY_EDITS), Object.isFrozen(EMPTY_EDITS.copy), Object.isFrozen(EMPTY_EDITS.hidden)]).toEqual([true, true, true]);
    const { facts, ai } = split(loadFixture("cleaning-minimal"));
    const owner = edits({ hidden: ["faq"] });
    const composed = composeDocument(facts, ai, owner);
    expect(composed.hidden).toEqual(["faq"]);
    expect(composed.hidden).not.toBe(owner.hidden);
  });
});

describe("SectionOrder", () => {
  it("accepts every section once with the hero first", () => {
    expect(SectionOrder.safeParse([...SECTION_IDS]).success).toBe(true);
  });

  it.each([
    ["a partial order", SECTION_IDS.slice(0, 5)],
    ["a duplicate", ["hero", "faq", "faq", ...SECTION_IDS.slice(3)]],
    ["hero not first", [...SECTION_IDS.slice(1), "hero"]],
  ])("rejects %s", (_label, order) => {
    expect(SectionOrder.safeParse(order).success).toBe(false);
  });
});

describe("OwnerEdits service descriptions", () => {
  const withDescriptions = (value: unknown) => ({ ...edits(), copy: { serviceDescriptions: value } });
  const issuePaths = (value: unknown) => {
    const result = OwnerEdits.safeParse(value);
    return result.success ? [] : result.error.issues.map((i) => i.path.join("."));
  };

  it("keeps a __proto__ service name as plain data that never touches a prototype", () => {
    expectTypeOf<CopyEdits["serviceDescriptions"]>().toEqualTypeOf<Record<string, string> | undefined>();
    const parsed = OwnerEdits.parse(withDescriptions(JSON.parse('{"__proto__":"Owner text."}'))).copy.serviceDescriptions ?? {};
    expect([Object.hasOwn(parsed, "__proto__"), Object.getPrototypeOf(parsed) === Object.prototype]).toEqual([true, true]);
    expect(issuePaths(withDescriptions(JSON.parse('{"__proto__":{"polluted":true}}')))).toEqual(["copy.serviceDescriptions.__proto__"]);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });

  it("still refuses a long service name, a long description and anything but a plain object", () => {
    const long = "x".repeat(41);
    expect(issuePaths(withDescriptions({ [long]: "Text." }))).toEqual([`copy.serviceDescriptions.${long}`]);
    expect(issuePaths(withDescriptions({ Drains: "x".repeat(2001) }))).toEqual(["copy.serviceDescriptions.Drains"]);
    const notObjects: Array<[unknown, string]> = [[[["Drains", "Text."]], "array"], ["Text.", "string"], [null, "null"], [new Map([["Drains", "Text."]]), "Map"]];
    for (const [value, received] of notObjects) {
      const result = OwnerEdits.safeParse(withDescriptions(value));
      expect(result.error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`)).toEqual([`copy.serviceDescriptions: Invalid input: expected record, received ${received}`]);
    }
  });
});

describe("ownerEditedPaths", () => {
  it("lists exactly the copy fields the owner set", () => {
    const { ai } = split(loadFixture("plumber-austin"));
    const paths = ownerEditedPaths(ai, edits({
      copy: { heroHeadline: "x", about: null, sectionIntros: { faq: "y" }, serviceDescriptions: { "Drain cleaning": "z" }, faq: [] },
    }));
    expect(paths).toEqual(["copy.heroHeadline", "copy.about", "copy.sectionIntros.faq", "copy.serviceDescriptions.Drain cleaning", "copy.faq"]);
    expect(ownerEditedPaths(ai, edits())).toEqual([]);
  });
});

describe("documentSha256", () => {
  it.each(FIXTURES)("is unchanged by re-parsing %s", async (name) => {
    const parsed = SiteDocument.parse(loadFixture(name));
    const reparsed = SiteDocument.parse(parsed);
    expect(canonicalJson(reparsed)).toBe(canonicalJson(parsed));
    expect(await documentSha256(reparsed)).toBe(await documentSha256(parsed));
  });

  it("ignores key order", async () => {
    const parsed = SiteDocument.parse(loadFixture("hvac-phoenix"));
    const reordered = JSON.parse(JSON.stringify({ theme: parsed.theme, layout: parsed.layout, hidden: parsed.hidden, copy: parsed.copy, facts: parsed.facts }));
    expect(await documentSha256(reordered)).toBe(await documentSha256(parsed));
  });
});

describe("photoRefIssues", () => {
  const siteId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  const up = { id: "0b0c2d3e-4f50-4a6b-8c7d-8e9fa0b1c2d3", width: 1600, height: 1200 };
  const url = mediaUrl("asksite.example", siteId, up.id);
  const photo = { url, alt: "A job", width: 1600, height: 1200 };

  it("accepts photos that are this site's uploads with matching sizes", () => {
    expect(photoRefIssues({ heroPhoto: photo, photos: [photo] }, siteId, "asksite.example", [up])).toEqual([]);
  });

  it("flags outside URLs, deleted uploads and size mismatches", () => {
    const issues = photoRefIssues(
      { heroPhoto: { ...photo, url: "https://evil.example/x.webp" }, photos: [photo, { ...photo, width: 10 }] },
      siteId,
      "asksite.example",
      [],
    );
    expect(issues.map((i) => [i.path.join("."), i.code])).toEqual([
      ["facts.heroPhoto.url", "photo_ref"],
      ["facts.photos.0.url", "photo_ref"],
      ["facts.photos.1.url", "photo_ref"],
    ]);
    const sized = photoRefIssues({ photos: [{ ...photo, height: 1 }] }, siteId, "asksite.example", [up]);
    expect(sized).toEqual([{ path: ["facts", "photos", 0, "url"], code: "photo_ref", message: "This photo's size does not match the upload; choose it again" }]);
  });

  it("flags another site's upload", () => {
    const other = mediaUrl("asksite.example", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", up.id);
    expect(photoRefIssues({ photos: [{ ...photo, url: other }] }, siteId, "asksite.example", [up])).toHaveLength(1);
  });

  it("returns nothing for facts that are not an object yet", () => {
    expect(photoRefIssues(null, siteId, "asksite.example", [up])).toEqual([]);
  });
});
