import { Facts, factSections, SiteDocument } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { FIXTURES, loadFixture } from "../../../fixtures/index.ts";
import { templateDraft } from "../src/template.ts";
import { bindServiceNames, checkDraft, normalizeEnumCase } from "../src/validate.ts";
import { AI_DRAFT_JSON_SCHEMA, dropNulls, toWireSchema } from "../src/wire-schema.ts";
import { BRIEF, FULL_FACTS, MINIMAL_FACTS } from "./support/samples.ts";

describe("checkDraft", () => {
  const draft = templateDraft(FULL_FACTS, BRIEF);

  it("accepts a draft that makes a valid SiteDocument with these facts", () => {
    expect(checkDraft(FULL_FACTS, draft)).toEqual({ ok: true, draft });
  });

  it("returns the parsed draft: copy trimmed and NFKC-normalised", () => {
    const loose = { ...draft, copy: { ...draft.copy, heroHeadline: "  Plumbing help  " } };
    const result = checkDraft(FULL_FACTS, loose);
    expect(result.ok && result.draft.copy.heroHeadline).toBe("Plumbing help");
  });

  it("reports schema problems with their paths", () => {
    const result = checkDraft(FULL_FACTS, { ...draft, copy: { ...draft.copy, heroHeadline: "Call 555-0100" } });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.map((i) => i.path.join("."))).toContain("copy.heroHeadline");
  });

  it("reports claims the facts do not back, checked against these facts", () => {
    const claim = { ...draft, copy: { ...draft.copy, ctaText: "Request a quote", heroSubheadline: "Licensed and insured plumbers." } };
    expect(checkDraft(FULL_FACTS, claim).ok).toBe(true);
    const services = MINIMAL_FACTS.services.map((s) => ({ service: s.name, description: "Done well." }));
    const result = checkDraft(MINIMAL_FACTS, { ...claim, copy: { ...claim.copy, serviceDescriptions: services } });
    expect(!result.ok && result.issues.map((i) => i.path.join("."))).toEqual(["copy.heroSubheadline"]);
  });

  it("reports a layout that leaves out an owner-fact section", () => {
    const result = checkDraft(FULL_FACTS, { ...draft, layout: [{ id: "hero", variant: "photo" }] });
    expect(!result.ok && result.issues.map((i) => i.path.join("."))).toContain("layout");
  });

  it("reports a non-object answer without throwing", () => {
    expect(checkDraft(FULL_FACTS, undefined).ok).toBe(false);
    expect(checkDraft(FULL_FACTS, "text").ok).toBe(false);
    expect(checkDraft(FULL_FACTS, { copy: { serviceDescriptions: [null, "x", { service: 5 }] } }).ok).toBe(false);
  });

  // Owner names a model cannot retype byte for byte: a pasted non-breaking space, an iPhone
  // apostrophe, a decomposed accent, fullwidth letters, and a double space with other casing.
  const OWNER_NAMES = ["Men’s shirts", "Diseño de jardines", "ＡＣ repair", "Drain  Cleaning"];
  const withServices = (facts: Facts, services: string[]) => {
    const base = templateDraft(facts, BRIEF);
    return { ...base, copy: { ...base.copy, serviceDescriptions: services.map((service) => ({ service, description: "Done well." })) } };
  };

  it("puts the owner's exact service name back where the model retyped it loosely", () => {
    const facts = Facts.parse({ ...MINIMAL_FACTS, services: OWNER_NAMES.map((name) => ({ name })) });
    const result = checkDraft(facts, withServices(facts, ["Men's shirts", "Diseño de jardines", "AC repair", "drain cleaning"]));
    expect(result.ok && result.draft.copy.serviceDescriptions.map((d) => d.service)).toEqual(OWNER_NAMES);
  });

  it("leaves a different, missing or reordered name for SiteDocument to report", () => {
    const facts = Facts.parse({ ...MINIMAL_FACTS, services: [{ name: "Drain cleaning" }, { name: "Leak repair" }] });
    for (const names of [["Drain cleaning", "Leak repairs"], ["Leak repair", "Drain cleaning"], ["Drain cleaning"]]) {
      const result = checkDraft(facts, withServices(facts, names));
      expect(!result.ok && result.issues.map((i) => i.path.join("."))).toEqual(["copy.serviceDescriptions"]);
    }
  });

  it("never changes the model's answer object", () => {
    const loose = withServices(FULL_FACTS, ["DRAIN CLEANING", "LEAK REPAIR"]);
    const before = JSON.stringify(loose);
    expect(checkDraft(FULL_FACTS, loose).ok).toBe(true);
    expect(JSON.stringify(loose)).toBe(before);
  });

  it("accepts a layout that adds about and faq after the owner-fact sections (prompt line, P3-A1)", () => {
    for (const facts of [FULL_FACTS, MINIMAL_FACTS]) {
      const base = templateDraft(facts, BRIEF);
      const order = ["hero", ...factSections(facts), "about", "faq"];
      const layout = order.map((id) => base.layout.find((section) => section.id === id)!);
      const faq = [{ question: "Can you help with a slow drain?", answer: "Yes. Tell us what you are seeing and we will talk you through the options." }];
      const result = checkDraft(facts, { ...base, copy: { ...base.copy, faq }, layout });
      expect(result.ok).toBe(true);
      expect(result.ok && result.draft.layout.map((section) => section.id)).toEqual(order);
    }
  });

  it("accepts about in the layout when the model left the about text out (null, removed by dropNulls)", () => {
    const answer = dropNulls({ ...draft, copy: { ...draft.copy, about: null } });
    const result = checkDraft(FULL_FACTS, answer);
    expect(result.ok).toBe(true);
    expect(result.ok && result.draft.layout.some((s) => s.id === "about")).toBe(true);
    expect(result.ok && result.draft.copy.about).toBeUndefined();
  });

  it("binds an owner service name that holds a lone surrogate (the model only sees U+FFFD)", () => {
    const facts = Facts.parse({ ...MINIMAL_FACTS, services: [{ name: "Tile \uD800 care" }] });
    const result = checkDraft(facts, withServices(facts, ["Tile \uFFFD care"]));
    expect(result.ok && result.draft.copy.serviceDescriptions[0]!.service).toBe("Tile \uD800 care");
  });

  it("binds by position, so entries swapped between two loosely equal owner names are accepted, each under the name at its position", () => {
    const facts = Facts.parse({ ...MINIMAL_FACTS, services: [{ name: "Drain cleaning" }, { name: "drain  Cleaning" }] });
    const base = templateDraft(facts, BRIEF);
    const serviceDescriptions = [
      { service: "drain  Cleaning", description: "Written for the name in lower case." },
      { service: "Drain cleaning", description: "Written for the name in title case." },
    ];
    const result = checkDraft(facts, { ...base, copy: { ...base.copy, serviceDescriptions } });
    expect(result.ok && result.draft.copy.serviceDescriptions).toEqual([
      { service: "Drain cleaning", description: "Written for the name in lower case." },
      { service: "drain  Cleaning", description: "Written for the name in title case." },
    ]);
  });

  it("returns the model's own hero variant even when the facts have a hero photo (Decision 7: SiteDocument applies the photo later)", () => {
    const centered = { ...draft, layout: draft.layout.map((s) => (s.id === "hero" ? { id: "hero", variant: "centered" } : s)) };
    const hero = (layout: ReadonlyArray<{ id: string }>) => layout.find((s) => s.id === "hero");
    expect(hero(SiteDocument.parse({ facts: FULL_FACTS, ...centered, hidden: [] }).layout)).toEqual({ id: "hero", variant: "photo" });
    const result = checkDraft(FULL_FACTS, centered);
    expect(result.ok && hero(result.draft.layout)).toEqual({ id: "hero", variant: "centered" });
  });

  it("binds an owner name with an inch mark (U+2033 double prime) to the model's straight double quote, and the other way round", () => {
    // NFKC splits U+2033 into two primes, so the quote marks are folded before NFKC.
    for (const [owner, model] of [["3/4\u2033 water lines", '3/4" water lines'], ['3/4" water lines', "3/4\u2033 water lines"]] as const) {
      const facts = Facts.parse({ ...MINIMAL_FACTS, services: [{ name: owner }] });
      const result = checkDraft(facts, withServices(facts, [model]));
      expect(result.ok && result.draft.copy.serviceDescriptions[0]!.service).toBe(owner);
    }
  });

  it("still folds the primes NFKC makes, as before: U+2034 and U+2057 bind to three and four apostrophes", () => {
    for (const [owner, model] of [["Size 1\u2034 fittings", "Size 1''' fittings"], ["Size 1\u2057 fittings", "Size 1'''' fittings"]] as const) {
      const facts = Facts.parse({ ...MINIMAL_FACTS, services: [{ name: owner }] });
      const result = checkDraft(facts, withServices(facts, [model]));
      expect(result.ok && result.draft.copy.serviceDescriptions[0]!.service).toBe(owner);
    }
  });

  it("binds every Plan 1 fixture's service names, retyped exactly, to the owner's names, and reports two different names swapped", () => {
    for (const fixture of FIXTURES) {
      const facts = Facts.parse(loadFixture(fixture).facts);
      const names = facts.services.map((service) => service.name);
      const bound = bindServiceNames(facts, withServices(facts, names)) as { copy: { serviceDescriptions: Array<{ service: string }> } };
      expect(bound.copy.serviceDescriptions.map((entry) => entry.service), fixture).toEqual(names);
      // Two different names swapped are not one name retyped, so they stay as written and SiteDocument reports them.
      const result = checkDraft(facts, withServices(facts, [names[1]!, names[0]!, ...names.slice(2)]));
      expect(!result.ok && result.issues.map((i) => i.path.join(".")), fixture).toEqual(["copy.serviceDescriptions"]);
    }
  });
});

// Anthropic structured outputs, "Enum value casing" (platform.claude.com/docs/en/build-with-claude/structured-outputs,
// checked 2026-09-27): "Structured outputs don't guarantee the capitalization of string `enum` and `const` values ...
// Compare enum values case-insensitively, and avoid enum values that differ only in capitalization."
describe("enum case (P3-11 m)", () => {
  const draft = templateDraft(FULL_FACTS, BRIEF);
  const WIRE = toWireSchema(AI_DRAFT_JSON_SCHEMA);
  const hero = draft.layout[0]!;
  const withHero = (section: unknown) => ({ ...draft, layout: [section, ...draft.layout.slice(1)] });
  const deepFreeze = <T>(value: T): T => {
    if (value !== null && typeof value === "object") Object.values(value).forEach(deepFreeze);
    return Object.freeze(value);
  };

  it("accepts a section id in another case or with spaces around it, as the schema's member: \"Hero\" and \" HERO \" become \"hero\"", () => {
    for (const id of ["Hero", " HERO "]) {
      const result = checkDraft(FULL_FACTS, withHero({ id, variant: hero.variant }));
      expect(result.ok && result.draft.layout[0]!.id, id).toBe("hero");
    }
  });

  it("accepts a whole layout whose ids (discriminators) and variants are in another case, each in its own branch", () => {
    // serviceArea is camelCase in the schema: the match ignores case on both sides.
    expect(draft.layout.map((section) => section.id)).toContain("serviceArea");
    const shouted = draft.layout.map(({ id, variant }) => ({ id: id.toUpperCase(), variant: ` ${variant.toUpperCase()}` }));
    const result = checkDraft(FULL_FACTS, { ...draft, layout: shouted });
    expect(result.ok && result.draft.layout).toEqual(draft.layout);
  });

  it("accepts palette and font in another case (checks the two field values only)", () => {
    const result = checkDraft(FULL_FACTS, { ...draft, theme: { ...draft.theme, palette: " Navy-Orange", font: "CLEAN " } });
    expect(result.ok && result.draft.theme.palette).toBe("navy-orange");
    expect(result.ok && result.draft.theme.font).toBe("clean");
  });

  it("leaves an object that fits no union branch, and a string that matches no member, for validation to report", () => {
    const wrong = { id: "HERO", variant: "band" }; // band is a trust variant, so neither the hero nor the trust branch fits
    expect(normalizeEnumCase(WIRE, { layout: [wrong] })).toEqual({ layout: [wrong] });
    const layout = checkDraft(FULL_FACTS, withHero(wrong));
    expect(!layout.ok && layout.issues.map((i) => i.path.join("."))).toContain("layout.0.id");
    const theme = checkDraft(FULL_FACTS, { ...draft, theme: { ...draft.theme, palette: "Navy Orange" } });
    expect(!theme.ok && theme.issues.map((i) => i.path.join("."))).toEqual(["theme.palette"]);
  });

  it("leaves an object that two union branches fit unchanged, and normalizes it when only one fits (synthetic schema)", () => {
    const withX = { type: "object", properties: { kind: { type: "string", enum: ["a"] }, x: { type: "string", enum: ["p"] } } };
    const withY = { type: "object", properties: { kind: { type: "string", enum: ["a"] }, y: { type: "string" } } };
    const value = { kind: "A", x: "P" };
    expect(normalizeEnumCase({ anyOf: [withX, withY] }, value)).toBe(value);
    expect(normalizeEnumCase({ anyOf: [withX, { type: "null" }] }, value)).toEqual({ kind: "a", x: "p" });
  });

  it("changes nothing when two members differ only in case (ambiguity guard, synthetic schema)", () => {
    const schema = { type: "string", enum: ["a", "A", "b"] };
    expect(["a", "A", " a ", "B ", "c"].map((value) => normalizeEnumCase(schema, value))).toEqual(["a", "A", " a ", "b", "c"]);
  });

  it("replaces a string at a union position only when exactly one member of all its branches matches (synthetic schema)", () => {
    const schema = { anyOf: [{ type: "string", enum: ["red", "Blue"] }, { type: "string", enum: ["blue", "green", "red"] }, { type: "null" }] };
    expect(["RED", "Green", "BLUE", "blue", "pink", null].map((value) => normalizeEnumCase(schema, value))).toEqual(["red", "green", "BLUE", "blue", "pink", null]);
  });

  it("never touches free text, even text that equals an enum member in another case: copy fields and service names", () => {
    const facts = Facts.parse({ ...MINIMAL_FACTS, services: [{ name: "Gallery" }, { name: "Split" }] });
    const base = templateDraft(facts, BRIEF);
    const answer = {
      ...base,
      copy: {
        ...base.copy,
        heroHeadline: "Hero",
        ctaText: "Photo",
        about: "Navy-Orange",
        sectionIntros: { ...base.copy.sectionIntros, faq: "Accordion" },
        serviceDescriptions: [
          { service: " GALLERY ", description: "Clean" },
          { service: "split", description: "Friendly" },
        ],
        faq: [{ question: "Hero", answer: "Sturdy" }],
      },
    };
    const before = JSON.stringify(answer);
    expect(normalizeEnumCase(WIRE, answer)).toBe(answer);
    expect(JSON.stringify(answer)).toBe(before);
  });

  it("leaves a non-string at an enum position unchanged, for validation to report", () => {
    for (const palette of [5, null, true, ["NAVY-ORANGE"], { value: "NAVY-ORANGE" }]) {
      const answer = { ...draft, theme: { ...draft.theme, palette } };
      expect(normalizeEnumCase(WIRE, answer), JSON.stringify(palette)).toBe(answer);
      const result = checkDraft(FULL_FACTS, answer);
      expect(!result.ok && result.issues.map((i) => i.path.join(".")), JSON.stringify(palette)).toEqual(["theme.palette"]);
    }
  });

  it("never mutates its input: it returns the input itself when nothing changes, and new objects only along the path to a change", () => {
    const answer = deepFreeze({ ...draft, theme: { ...draft.theme, font: "Sturdy" } });
    const before = JSON.stringify(answer);
    const out = normalizeEnumCase(WIRE, answer) as typeof answer;
    expect(JSON.stringify(answer)).toBe(before);
    expect(out.theme.font).toBe("sturdy");
    expect(out).not.toBe(answer);
    expect(out.copy).toBe(answer.copy);
    expect(out.layout).toBe(answer.layout);
    expect(normalizeEnumCase(WIRE, draft)).toBe(draft);
  });

  it("follows the schema's properties only: an unknown key keeps its value, a missing key stays missing, an own __proto__ stays an own data key", () => {
    const answer = JSON.parse('{"theme":{"palette":"NAVY-ORANGE","extra":"CLEAN","__proto__":{"polluted":true}}}') as { theme: object };
    const out = normalizeEnumCase(WIRE, answer) as { theme: Record<string, unknown> };
    expect(out.theme.palette).toBe("navy-orange");
    expect(out.theme.extra).toBe("CLEAN");
    expect(Object.keys(out.theme)).toEqual(Object.keys(answer.theme));
    expect(Object.hasOwn(out.theme, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(out.theme)).toBe(Object.prototype);
    expect("polluted" in out.theme).toBe(false);
  });
});
