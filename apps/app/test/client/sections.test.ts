import { composeDocument, EMPTY_EDITS, OwnerEdits, OwnerEditsBody, SECTION_IDS } from "@asksite/core";
import { render, sitePages, type DesignStylesheets } from "@asksite/renderer";
import { DEFAULT_SECTION_ORDER, SiteDocument, type SectionId } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { DESIGN_CSS, FIXTURES, loadFixture, stubStylesheets } from "../../../../fixtures/index.ts";
import { editsForAi, isAllowedKey, withCopy, withServiceDescription } from "../../src/client/lib/edits.ts";
import { issuesAt } from "../../src/client/lib/messages.ts";
import { buildPreview, checkDraft, previewDesign, stylesheetLoader } from "../../src/client/lib/preview.ts";
import { canMove, listedSections, moveSection, pageRemovedByHiding, sectionHasContent, sectionOfCopy, sectionsByPage, setHidden } from "../../src/client/lib/sections.ts";

// The renderer's DOM ids for each section (Plan 1 Task 10 DOM_ID).
const DOM_ID: Record<SectionId, string> = {
  hero: "top", trust: "credentials", services: "services", testimonials: "reviews", gallery: "our-work",
  about: "about", serviceArea: "service-area", faq: "faq", contact: "contact",
};

describe("sectionHasContent", () => {
  it.each(FIXTURES)("matches the sections the renderer shows across its pages for %s", (name) => {
    const doc = SiteDocument.parse(loadFixture(name));
    const site = render(doc, { stylesheets: stubStylesheets(""), formAction: "https://x.example/f", siteUrl: "https://x.example/" });
    const planned = new Set(sitePages(doc).flatMap((page) => page.sections.map((section) => section.id)));
    for (const id of SECTION_IDS) {
      const shown = site.pages.some((page) => page.html.includes(`<section id="${DOM_ID[id]}"`));
      expect([id, shown]).toEqual([id, planned.has(id)]);
      expect([id, sectionHasContent(doc, id)]).toEqual([id, shown]);
    }
  });
});

describe("moving and hiding (U1: owners reorder within a page, never across pages)", () => {
  // The default order: Home (hero, trust, testimonials), Services (services, faq), About, Gallery, Contact (contact, serviceArea).
  const order = [...DEFAULT_SECTION_ORDER];
  const all = [...DEFAULT_SECTION_ORDER];

  it("is the page map's order until the owner reorders", () => {
    expect(order).toEqual(["hero", "trust", "testimonials", "services", "faq", "about", "gallery", "contact", "serviceArea"]);
  });

  it("moves the FAQ up on the Services page by swapping it with services", () => {
    expect(moveSection(order, all, "faq", -1)).toEqual(["hero", "trust", "testimonials", "faq", "services", "about", "gallery", "contact", "serviceArea"]);
    expect(moveSection(order, all, "serviceArea", -1)).toEqual(["hero", "trust", "testimonials", "services", "faq", "about", "gallery", "serviceArea", "contact"]);
  });

  it("refuses to move the last section of a page down, and the first of a page up: it never leaves its page", () => {
    expect(moveSection(order, all, "testimonials", 1)).toEqual(order); // last on Home: Services' first section is next in the order
    expect(moveSection(order, all, "services", -1)).toEqual(order); // first on Services: Home's last section is before it
    expect(moveSection(order, all, "faq", 1)).toEqual(order);
    expect(moveSection(order, all, "about", -1)).toEqual(order); // alone on its page
    expect(moveSection(order, all, "about", 1)).toEqual(order);
    expect(canMove(order, all, "faq", -1)).toBe(true);
    expect(canMove(order, all, "faq", 1)).toBe(false);
    expect(canMove(order, all, "about", 1)).toBe(false);
  });

  it("skips sections that have no content: the neighbour is the next listed section of the same page", () => {
    const listed: SectionId[] = ["hero", "services", "faq", "about", "contact", "serviceArea"]; // no trust, testimonials, gallery
    expect(moveSection(order, listed, "serviceArea", -1)).toEqual(["hero", "trust", "testimonials", "services", "faq", "about", "gallery", "serviceArea", "contact"]);
    expect(moveSection(order, listed, "services", -1)).toEqual(order);
    expect(canMove(["hero", "services"], ["hero", "services"], "hero", 1)).toBe(false);
  });

  it("never moves the hero or anything above it", () => {
    expect(moveSection(order, all, "trust", -1)).toEqual(order);
    expect(moveSection(order, all, "hero", 1)).toEqual(order);
    expect(canMove(order, all, "trust", -1)).toBe(false);
    expect(canMove(order, all, "hero", 1)).toBe(false);
  });

  it("keeps a saved order a full SectionOrder, with the other pages' sections where they were", () => {
    const moved = moveSection(["hero", "testimonials", "trust", "services", "faq", "gallery", "about", "contact", "serviceArea"], all, "serviceArea", -1);
    expect(moved).toEqual(["hero", "testimonials", "trust", "services", "faq", "gallery", "about", "serviceArea", "contact"]);
    expect([...moved].sort()).toEqual([...SECTION_IDS].sort());
    expect(moved[0]).toBe("hero");
  });

  it("groups the listed sections by page in the page map's order, leaving out a page with none", () => {
    expect(sectionsByPage(order, ["hero", "services", "faq", "contact", "serviceArea"])).toEqual([
      { page: "home", sections: ["hero"] },
      { page: "services", sections: ["services", "faq"] },
      { page: "contact", sections: ["contact", "serviceArea"] },
    ]);
    // Within a page the owner's order decides.
    expect(sectionsByPage(["hero", "trust", "testimonials", "faq", "services", "about", "gallery", "serviceArea", "contact"], all)[1]).toEqual({ page: "services", sections: ["faq", "services"] });
  });

  it("says which page hiding a section takes out of the menu", () => {
    expect(pageRemovedByHiding(all, [], "about")).toBe("about");
    expect(pageRemovedByHiding(all, [], "gallery")).toBe("gallery");
    expect(pageRemovedByHiding(all, [], "faq")).toBeNull(); // Services still has its services
    expect(pageRemovedByHiding(all, [], "trust")).toBeNull(); // Home always stays
    expect(pageRemovedByHiding(all, [], "serviceArea")).toBeNull(); // Contact always stays
    expect(pageRemovedByHiding(["hero", "services", "contact", "serviceArea"], [], "about")).toBeNull(); // no About content: nothing to remove
  });

  it("knows which section each wording field belongs to, so the preview can follow the owner", () => {
    expect(sectionOfCopy(["copy", "heroHeadline"])).toBe("hero");
    expect(sectionOfCopy(["copy", "ctaText"])).toBe("hero");
    expect(sectionOfCopy(["copy", "serviceDescriptions", 0, "description"])).toBe("services");
    expect(sectionOfCopy(["copy", "sectionIntros", "services"])).toBe("services");
    expect(sectionOfCopy(["copy", "faq", 2, "answer"])).toBe("faq");
    expect(sectionOfCopy(["copy", "sectionIntros", "faq"])).toBe("faq");
    expect(sectionOfCopy(["copy", "about"])).toBe("about");
    expect(sectionOfCopy(["copy", "sectionIntros", "gallery"])).toBe("gallery");
    expect(sectionOfCopy(["copy", "sectionIntros", "contact"])).toBe("contact");
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

  it("asks OwnerEdits itself whether a service name can be a description key: 40 code points yes, 41 no, however many UTF-16 units", () => {
    expect(isAllowedKey("\u{1F527}".repeat(40))).toBe(true);
    expect(isAllowedKey("\u{1F527}".repeat(41))).toBe(false);
    expect(isAllowedKey("a".repeat(39) + "\u{1F527}")).toBe(true); // 40 code points, 41 UTF-16 units
    expect(isAllowedKey("a".repeat(41))).toBe(false);
  });

  it("checks the draft on its own (no sheets needed), with the same issues buildPreview returns", () => {
    const good = checkDraft(ai, { facts: fixture.facts, brief: {}, edits: EMPTY_EDITS });
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.doc.copy.heroHeadline).toBe(fixture.copy.heroHeadline);
    const edits = withCopy(ai, EMPTY_EDITS, (c) => ({ ...c, heroHeadline: "Call 555" }));
    const bad = checkDraft(ai, { facts: fixture.facts, brief: {}, edits });
    const viaBuild = buildPreview(ai, { facts: fixture.facts, brief: {}, edits }, site, "localhost:8789", DESIGN_CSS);
    expect(bad.ok).toBe(false);
    expect(viaBuild.ok).toBe(false);
    if (!bad.ok && !viaBuild.ok) expect(viaBuild.issues).toEqual(bad.issues);
    const hours = checkDraft(ai, { facts: { ...fixture.facts, hours: [{ days: ["Monday"], opens: "08:00", closes: "" }] }, brief: {}, edits: EMPTY_EDITS });
    expect(hours.ok).toBe(false);
    if (!hours.ok) expect(issuesAt(hours.issues, ["facts", "hours", 0, "closes"])).toHaveLength(1);
  });

  it("renders the draft exactly as composeDocument + render would, or returns the issues", () => {
    const edits = withCopy(ai, EMPTY_EDITS, (c) => ({ ...c, heroHeadline: "Drains   cleared\nfast" }));
    const preview = buildPreview(ai, { facts: fixture.facts, brief: {}, edits }, site, "localhost:8789", DESIGN_CSS);
    expect(preview.ok).toBe(true);
    if (preview.ok) {
      const html = (page: string) => preview.pages.find((p) => p.page === page)?.html ?? "";
      expect(preview.pages.map((p) => p.page)).toEqual(sitePages(preview.doc).map((p) => p.id));
      expect(html("home")).toContain("Drains cleared fast");
      // The form is on the Contact page, and its action is the site's own (the reserved "preview" host before a slug is chosen).
      expect(html("contact")).toContain('action="https://preview.localhost:8789/_f/1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed"');
      expect(html("contact")).toContain('<link rel="canonical" href="https://preview.localhost:8789/contact">');
      const expected = SiteDocument.parse(composeDocument(fixture.facts, ai, edits));
      expect(listedSections(preview.doc)).toEqual(listedSections(expected));
    }
    const bad = buildPreview(ai, { facts: fixture.facts, brief: {}, edits: withCopy(ai, EMPTY_EDITS, (c) => ({ ...c, heroHeadline: "Call 555" })) }, { id: "x", slug: null }, "localhost:8789", DESIGN_CSS);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues[0]?.path).toEqual(["copy", "heroHeadline"]);
  });

  it("renders the canonical addresses of the site's own host once a web address is chosen", () => {
    const preview = buildPreview(ai, { facts: fixture.facts, brief: {}, edits: EMPTY_EDITS }, { id: site.id, slug: "joes-plumbing" }, "localhost:8789", DESIGN_CSS);
    expect(preview.ok).toBe(true);
    if (preview.ok) expect(preview.pages[0]?.html).toContain('<link rel="canonical" href="https://joes-plumbing.localhost:8789/">');
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
        for (const { html } of preview.pages) {
          expect(html).toContain(`/* sheet of ${design} */`);
          expect(html).not.toContain(`/* sheet of ${other} */`);
        }
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
