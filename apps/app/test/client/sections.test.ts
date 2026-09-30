import { composeDocument, EMPTY_EDITS, OwnerEdits, OwnerEditsBody, SECTION_IDS } from "@asksite/core";
import { render, type DesignStylesheets } from "@asksite/renderer";
import { SiteDocument, type SectionId } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { DESIGN_CSS, FIXTURES, loadFixture, stubStylesheets } from "../../../../fixtures/index.ts";
import { editsForAi, withCopy, withServiceDescription } from "../../src/client/lib/edits.ts";
import { issuesAt } from "../../src/client/lib/messages.ts";
import { buildPreview, previewDesign, stylesheetLoader } from "../../src/client/lib/preview.ts";
import { listedSections, moveSection, sectionHasContent, setHidden } from "../../src/client/lib/sections.ts";

// The renderer's DOM ids for each section (Plan 1 Task 10 DOM_ID).
const DOM_ID: Record<SectionId, string> = {
  hero: "top", trust: "credentials", services: "services", testimonials: "reviews", gallery: "our-work",
  about: "about", serviceArea: "service-area", faq: "faq", contact: "contact",
};

describe("sectionHasContent", () => {
  it.each(FIXTURES)("matches the sections the renderer actually shows for %s", (name) => {
    const doc = SiteDocument.parse(loadFixture(name));
    const html = render(doc, { stylesheets: stubStylesheets(""), formAction: "https://x.example/f" }).html;
    for (const id of SECTION_IDS) {
      const shown = html.includes(`<section id="${DOM_ID[id]}"`);
      expect([id, sectionHasContent(doc, id)]).toEqual([id, shown]);
    }
  });
});

describe("moving and hiding", () => {
  const order: SectionId[] = ["hero", "trust", "services", "testimonials", "gallery", "about", "serviceArea", "faq", "contact"];
  const listed: SectionId[] = ["hero", "services", "about", "serviceArea", "contact"];

  it("swaps with the listed neighbour and leaves empty sections in place", () => {
    expect(moveSection(order, listed, "about", -1)).toEqual(["hero", "trust", "about", "testimonials", "gallery", "services", "serviceArea", "faq", "contact"]);
    expect(moveSection(order, listed, "contact", 1)).toEqual(order);
  });

  it("never moves the hero or anything above it", () => {
    expect(moveSection(order, listed, "services", -1)).toEqual(order);
    expect(moveSection(order, listed, "hero", 1)).toEqual(order);
  });

  it("hides and shows a section once", () => {
    expect(setHidden(["faq"], "about", true)).toEqual(["faq", "about"]);
    expect(setHidden(["faq", "about"], "about", true)).toEqual(["faq", "about"]);
    expect(setHidden(["faq", "about"], "faq", false)).toEqual(["about"]);
  });
});

describe("edits and preview", () => {
  const fixture = SiteDocument.parse(loadFixture("plumber-austin"));
  const ai = { generationId: "g2", draft: { copy: fixture.copy, layout: fixture.layout, theme: fixture.theme } };
  const site = { id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed", slug: null };
  const modern = { ...EMPTY_EDITS, theme: { ...fixture.theme, design: "modern" as const } };

  it("starts fresh copy edits on a newer AI draft but keeps the look and hidden sections", () => {
    const old = { ...EMPTY_EDITS, baseGenerationId: "g1", copy: { heroHeadline: "Old" }, hidden: ["faq" as const], theme: { palette: "green-amber" as const, font: "sturdy" as const, design: "modern" as const } };
    // A12 heads-up: no toEqual on a whole OwnerEdits that holds a theme; copy and theme are checked on their own.
    const next = editsForAi(ai, old);
    expect(next).toMatchObject({ baseGenerationId: "g2", order: null, hidden: ["faq"] });
    expect(next.copy).toEqual({});
    expect(next.theme).toBe(old.theme);
    expect(editsForAi(ai, { ...old, order: [...SECTION_IDS] }).order).toBeNull();
    expect(withCopy(ai, old, (c) => ({ ...c, ctaText: "Call us" })).copy).toEqual({ ctaText: "Call us" });
  });

  it("keeps the copy and order edits while the AI draft stays the same", () => {
    const current = { ...EMPTY_EDITS, baseGenerationId: "g2", copy: { ctaText: "Call us" }, order: [...SECTION_IDS] };
    expect(editsForAi(ai, current)).toBe(current);
    const next = withCopy(ai, current, (c) => ({ ...c, heroHeadline: "Drains cleared fast" }));
    expect(next.copy).toEqual({ ctaText: "Call us", heroHeadline: "Drains cleared fast" });
    expect(next.order).toBe(current.order);
  });

  it("keys service descriptions by the current service names only, so renamed or removed services never count toward the cap (A8c-2)", () => {
    const copy = { ctaText: "Call us", serviceDescriptions: { Drains: "Old text.", "Old name": "Renamed since.", Removed: "Deleted since." } };
    expect(withServiceDescription(copy, ["Drains", "Water heaters"], "Water heaters", "New text.")).toEqual({
      ctaText: "Call us",
      serviceDescriptions: { Drains: "Old text.", "Water heaters": "New text." },
    });
    // Twelve described services (Facts' maximum), then one renamed and described again: still twelve keys.
    const names = Array.from({ length: 12 }, (_, i) => `Service ${i + 1}`);
    const twelve = { serviceDescriptions: Object.fromEntries(names.map((name) => [name, "Done well."])) };
    const renamed = names.map((name, i) => (i === 0 ? "Renamed service" : name));
    const next = withServiceDescription(twelve, renamed, "Renamed service", "Done well.");
    expect(Object.keys(next.serviceDescriptions ?? {})).toHaveLength(12);
    expect(OwnerEdits.safeParse({ ...EMPTY_EDITS, copy: next }).success).toBe(true);
  });

  describe("withServiceDescription never emits a key OwnerEdits refuses", () => {
    const accepted = (copy: ReturnType<typeof withServiceDescription>) => OwnerEditsBody.safeParse({ ...EMPTY_EDITS, copy }).success;

    it("does not write a service name the key schema refuses (41 characters)", () => {
      const long = "a".repeat(41);
      const next = withServiceDescription({ ctaText: "Call us" }, [long, "Drains"], long, "Typed text.");
      expect(Object.keys(next.serviceDescriptions ?? {})).not.toContain(long);
      expect(next.ctaText).toBe("Call us");
      expect(accepted(next)).toBe(true);
    });

    it("drops a stored key the schema refuses on the next write", () => {
      const long = "b".repeat(41);
      const stale = { serviceDescriptions: { [long]: "Stale.", Drains: "Kept." } };
      const next = withServiceDescription(stale, [long, "Drains", "Water heaters"], "Water heaters", "New.");
      expect(next.serviceDescriptions).toEqual({ Drains: "Kept.", "Water heaters": "New." });
      expect(accepted(next)).toBe(true);
    });

    it("measures the name as the schema does: zod 4.6.5 counts code points, so 40 astral characters (80 UTF-16 units) pass and 41 are refused", () => {
      const forty = "\u{1F527}".repeat(40);
      const fortyOne = "\u{1F527}".repeat(41);
      expect(forty).toHaveLength(80); // UTF-16 units: a UTF-16 measure would refuse this name
      const ok = withServiceDescription({}, [forty], forty, "Fine.");
      expect(ok.serviceDescriptions).toEqual({ [forty]: "Fine." });
      expect(accepted(ok)).toBe(true);
      const refused = withServiceDescription({}, [fortyOne], fortyOne, "Fine.");
      expect(Object.keys(refused.serviceDescriptions ?? {})).toEqual([]);
      expect(accepted(refused)).toBe(true);
    });
  });

  it("renders the draft exactly as composeDocument + render would, or returns the issues", () => {
    const edits = withCopy(ai, EMPTY_EDITS, (c) => ({ ...c, heroHeadline: "Drains   cleared\nfast" }));
    const preview = buildPreview(ai, { facts: fixture.facts, brief: {}, edits }, site, "localhost:8789", DESIGN_CSS);
    expect(preview.ok).toBe(true);
    if (preview.ok) {
      expect(preview.html).toContain("Drains cleared fast");
      expect(preview.html).toContain('action="https://preview.localhost:8789/_f/1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed"');
      const expected = SiteDocument.parse(composeDocument(fixture.facts, ai, edits));
      expect(listedSections(preview.doc)).toEqual(listedSections(expected));
    }
    const bad = buildPreview(ai, { facts: fixture.facts, brief: {}, edits: withCopy(ai, EMPTY_EDITS, (c) => ({ ...c, heroHeadline: "Call 555" })) }, { id: "x", slug: null }, "localhost:8789", DESIGN_CSS);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues[0]?.path).toEqual(["copy", "heroHeadline"]);
  });

  it("counts an empty closing time once (issuesToShow, Task 12 I-1 ruling (a))", () => {
    const facts = { ...fixture.facts, hours: [{ days: ["Monday"], opens: "08:00", closes: "" }] };
    const preview = buildPreview(ai, { facts, brief: {}, edits: EMPTY_EDITS }, site, "localhost:8789", DESIGN_CSS);
    expect(preview.ok).toBe(false);
    if (!preview.ok) expect(issuesAt(preview.issues, ["facts", "hours", 0, "closes"]).map((i) => i.code)).toEqual(["invalid_format"]);
  });

  it("picks the owner's design, else the AI draft's, and inlines that design's sheet (P4-20 amendment)", () => {
    const sheets = stubStylesheets((design) => `/* sheet of ${design} */`);
    const draft = (edits: OwnerEdits) => ({ facts: fixture.facts, brief: {}, edits });
    // plumber-austin's AI design, impact, is also DEFAULT_DESIGN; an AI draft in refined tells "the AI draft's design" from "the default".
    const refinedAi = { ...ai, draft: { ...ai.draft, theme: { ...ai.draft.theme, design: "refined" as const } } };
    expect(ai.draft.theme.design).toBe("impact");
    expect(previewDesign(ai, EMPTY_EDITS)).toBe("impact");
    expect(previewDesign(refinedAi, EMPTY_EDITS)).toBe("refined");
    expect(previewDesign(ai, modern)).toBe("modern");
    for (const [aiDraft, edits, design, other] of [[ai, EMPTY_EDITS, "impact", "modern"], [refinedAi, EMPTY_EDITS, "refined", "impact"], [ai, modern, "modern", "impact"]] as const) {
      const preview = buildPreview(aiDraft, draft(edits), site, "localhost:8789", sheets);
      expect(preview.ok).toBe(true);
      if (preview.ok) {
        expect(preview.doc.theme.design).toBe(design);
        expect(preview.html).toContain(`/* sheet of ${design} */`);
        expect(preview.html).not.toContain(`/* sheet of ${other} */`);
      }
    }
  });
});

describe("the stylesheet loader (P4-20 amendment)", () => {
  const sheets: DesignStylesheets = stubStylesheets();

  it("imports the sheets at most once, however often it is asked", async () => {
    let imports = 0;
    const load = stylesheetLoader(async () => {
      imports += 1;
      return { DESIGN_CSS: sheets };
    });
    const [first, second] = await Promise.all([load(), load()]);
    expect(first).toBe(sheets);
    expect(second).toBe(sheets);
    expect(await load()).toBe(sheets);
    expect(imports).toBe(1);
  });

  it("keeps no failed import, so trying again imports again", async () => {
    let imports = 0;
    const load = stylesheetLoader(async () => {
      imports += 1;
      if (imports === 1) throw new TypeError("Failed to fetch dynamically imported module");
      return { DESIGN_CSS: sheets };
    });
    await expect(load()).rejects.toThrow("Failed to fetch dynamically imported module");
    expect(await load()).toBe(sheets);
    expect(await load()).toBe(sheets);
    expect(imports).toBe(2);
  });

  it("hands over the real DESIGN_CSS of @asksite/site-css by default", async () => {
    expect(await stylesheetLoader()()).toBe(DESIGN_CSS);
  });
});
