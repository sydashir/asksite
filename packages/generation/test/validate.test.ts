import { Facts, factSections } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { templateDraft } from "../src/template.ts";
import { checkDraft } from "../src/validate.ts";
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
    const wanted = new Set(["hero", ...factSections(FULL_FACTS), "about", "faq"]);
    const layout = draft.layout.filter((section) => wanted.has(section.id));
    const faq = [{ question: "Can you help with a slow drain?", answer: "Yes. Tell us what you are seeing and we will talk you through the options." }];
    const result = checkDraft(FULL_FACTS, { ...draft, copy: { ...draft.copy, faq }, layout });
    expect(result.ok).toBe(true);
    expect(result.ok && result.draft.layout.map((s) => s.id)).toEqual(layout.map((s) => s.id));
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
});
