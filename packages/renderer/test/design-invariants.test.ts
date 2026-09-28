import { DESIGN_IDS, FONT_IDS, PALETTE_IDS, SECTION_VARIANTS, SiteDocument, Theme, type SiteDocumentInput } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { FIXTURE_FORM_ACTION, FIXTURES, inDesign, loadFixture, stubStylesheets } from "../../../fixtures/index.ts";
import { BASELINE } from "../src/baseline.ts";
import { DESIGNS } from "../src/designs/index.ts";
import { render, renderDocument } from "../src/render.ts";
import { formSkeleton, invariantProblems, navLinks, variableProblems } from "./support/design-invariants.ts";

const OPTIONS = { stylesheets: stubStylesheets(), formAction: FIXTURE_FORM_ACTION };

/** The design's page for `input`, and today's page (BASELINE) for the same document. */
function pages(input: SiteDocumentInput) {
  const doc = SiteDocument.parse(input);
  return { doc, page: render(input, OPTIONS).html, baseline: renderDocument(doc, BASELINE, OPTIONS).html };
}

function withoutHeroPhoto(input: SiteDocumentInput): SiteDocumentInput {
  const { heroPhoto: _photo, ...facts } = input.facts;
  return { ...input, facts };
}

const withHeroVariant = (input: SiteDocumentInput, variant: string): SiteDocumentInput =>
  ({ ...input, layout: input.layout.map((s) => (s.id === "hero" ? { ...s, variant } : s)) }) as SiteDocumentInput;

// A12 §7 + addendum H1, for every design and every fixture.
describe.each(DESIGN_IDS)("the %s design", (design) => {
  it.each(FIXTURES)("keeps the shared invariants with fixture %s", (name) => {
    const { doc, page, baseline } = pages(inDesign(loadFixture(name), design));
    expect(invariantProblems(page, baseline, doc, DESIGNS[design])).toEqual([]);
  });

  it.each(FIXTURES)("renders the same page with either hero variant when %s has no hero photo", (name) => {
    const input = withoutHeroPhoto(inDesign(loadFixture(name), design));
    const variants = SECTION_VARIANTS.hero.map((variant) => render(withHeroVariant(input, variant), OPTIONS).html);
    expect(variants).toHaveLength(2);
    expect(new Set(variants).size).toBe(1);
  });

  it("names its custom properties --aw-<id>-* with safe values, for every palette and lettering", () => {
    for (const palette of PALETTE_IDS) {
      for (const font of FONT_IDS) expect(variableProblems(design, DESIGNS[design].variables(Theme.parse({ palette, font, design })))).toEqual([]);
    }
  });
});

describe("the invariant checks can fail (RED proof, on edited pages)", () => {
  const { doc, page, baseline } = pages(loadFixture("plumber-austin"));
  const problems = (edited: string) => invariantProblems(edited, baseline, doc, BASELINE);

  it("pass today's page", () => {
    expect(problems(page)).toEqual([]);
    expect(formSkeleton(page)).toContain("Send request");
    expect(formSkeleton(page)).toContain('<div aria-hidden="true"><label for="contact-website">Leave this field empty</label><input id="contact-website" name="website" type="text" tabindex="-1" autocomplete="off"></div>');
    expect(navLinks(page)).toContain("#faq FAQ");
  });

  it.each([
    ["an attribute before a section's id", page.replace('<section id="services"', '<section class="x" id="services"'), /^sections /],
    ["a section left out", page.replace('<section id="faq"', '<div id="faq"').replace(/(<div id="faq"[\s\S]*?)<\/section>/, "$1</div>"), /^sections /],
    ["a second <aside>", page.replace("</footer>", '</footer><aside aria-label="Hours">Open</aside>'), /^2 <aside> elements$/],
    ["a call bar without focus-outside:static", page.replace("focus-outside:static", ""), /^the call bar lacks focus-outside:static$/],
    ["a dropped required", page.replace('autocomplete="name" required', 'autocomplete="name"'), /^the contact form differs/],
    ['a renamed "Send request"', page.replace(">Send request<", ">Send<"), /^the contact form differs/],
    ["a honeypot field keyboard focus can reach", page.replace('name="website" type="text" tabindex="-1"', 'name="website" type="text"'), /^the contact form differs/],
    ["a honeypot not hidden from screen readers", page.replace('overflow-hidden" aria-hidden="true"><label for="contact-website"', 'overflow-hidden"><label for="contact-website"'), /^the contact form differs/],
    ["a renamed id", page.replace('id="contact-message"', 'id="message"').replace('for="contact-message"', 'for="message"'), /^ids /],
    ["a duplicate id", page.replace('<main id="main">', '<main id="main"><p id="top">x</p>'), /^duplicate ids$/],
    ["a relabelled menu link", page.replaceAll('href="#faq">FAQ<', 'href="#faq">Questions<'), /^navigation /],
    [
      "a reordered Main nav",
      page.replaceAll('href="#reviews">Reviews<', "\u0000").replaceAll('href="#faq">FAQ<', 'href="#reviews">Reviews<').replaceAll("\u0000", 'href="#faq">FAQ<'),
      /^navigation /,
    ],
    ['a nav that is not labelled "Main"', page.replace('<nav aria-label="Main"', '<nav aria-label="Site"'), /^navigation /],
    ["an FAQ item that is not exclusive", page.replace('name="faq"', ""), /details\[name=faq\]/],
    ["a second comment", page.replace("<main", "<!-- x --><main"), /^the one comment/],
    ["changed JSON-LD", page.replace('"@type":"Plumber"', '"@type":"LocalBusiness"'), /^JSON-LD differs/],
  ])("catch %s", (_, edited, problem) => {
    expect(edited).not.toBe(page);
    expect(problems(edited).filter((found) => problem.test(found))).toHaveLength(1);
  });

  // What a design may change (A12-0 round-2 rulings): the checks must not fail these.
  it.each([
    [
      "a Main nav whose aria-label is not its first attribute",
      page.replace('<nav aria-label="Main" class="order-last lg:order-none">', '<nav class="order-last lg:order-none" aria-label="Main">'),
    ],
    [
      "a honeypot wrapper that differs only in class (the per-design e2e checks keep it off-screen and out of the tab order)",
      page.replace('class="absolute -left-[9999px] h-px w-px overflow-hidden" aria-hidden="true"', 'class="hp" aria-hidden="true"'),
    ],
    ["extra links in the Main nav", page.replace('<ul class="hidden items-center gap-1 lg:flex">', '<a href="#top">Open the menu</a>\n<ul class="hidden items-center gap-1 lg:flex">')],
  ])("allow %s", (_, edited) => {
    expect(edited).not.toBe(page);
    expect(problems(edited)).toEqual([]);
  });

  it("catch unsafe or misnamed custom properties", () => {
    expect(variableProblems("impact", { "--aw-impact-accent": "#B91C1C", "--aw-impact-heading-font": "Georgia, serif" })).toEqual([]);
    expect(variableProblems("impact", { "--aw-refined-accent": "#000" })).toEqual(["name --aw-refined-accent"]);
    expect(variableProblems("impact", { "--aw-color-primary": "#000" })).toEqual(["name --aw-color-primary"]);
    for (const value of ["red;}", "</style>", "url(x)", "https://x.example", "\\75 rl(x)", "{"]) {
      expect(variableProblems("impact", { "--aw-impact-x": value })).toEqual(["value of --aw-impact-x"]);
    }
  });
});
