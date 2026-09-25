import { Facts, factSections, SiteDocument } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { FIXTURES, loadFixture } from "../../../fixtures/index.ts";
import { templateDraft } from "../src/template.ts";
import { bindServiceNames, checkDraft } from "../src/validate.ts";
import { dropNulls } from "../src/wire-schema.ts";
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

  it("binds every Plan 1 fixture's service names, retyped exactly, to the owner's names", () => {
    for (const fixture of FIXTURES) {
      const facts = Facts.parse(loadFixture(fixture).facts);
      const names = facts.services.map((service) => service.name);
      const bound = bindServiceNames(facts, withServices(facts, names)) as { copy: { serviceDescriptions: Array<{ service: string }> } };
      expect(bound.copy.serviceDescriptions.map((entry) => entry.service), fixture).toEqual(names);
    }
  });
});
