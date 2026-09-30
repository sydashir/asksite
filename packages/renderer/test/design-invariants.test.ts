import {
  DESIGN_IDS,
  FONT_IDS,
  HIDEABLE_SECTIONS,
  NEEDS_A_FACT,
  NEVER_IN_COPY,
  PALETTE_IDS,
  SECTION_VARIANTS,
  SiteDocument,
  Theme,
  type HideableSectionId,
  type SiteDocumentInput,
} from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { FIXTURE_FORM_ACTION, FIXTURES, inDesign, loadFixture, stubStylesheets } from "../../../fixtures/index.ts";
import { BASELINE } from "../src/baseline.ts";
import type { Design } from "../src/design.ts";
import { DESIGNS } from "../src/designs/index.ts";
import { html } from "../src/html.ts";
import { render, renderDocument } from "../src/render.ts";
import {
  CREDENTIAL_CLAIMS,
  formSkeleton,
  invariantProblems,
  navLinks,
  pageClaims,
  ROUND_THE_CLOCK,
  SERVICE_HOURS,
  STAR_RATING,
  variableProblems,
} from "./support/design-invariants.ts";

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

const withHidden = (input: SiteDocumentInput, hidden: readonly HideableSectionId[]): SiteDocumentInput => ({ ...input, hidden: [...hidden] });

/** What an owner can hide (amendment A6): each hideable section alone, then all of them. */
const HIDE_SETS: readonly (readonly HideableSectionId[])[] = [...HIDEABLE_SECTIONS.map((id) => [id]), HIDEABLE_SECTIONS];

// A12 §7 + addendum H1, for every design and every fixture.
describe.each(DESIGN_IDS)("the %s design", (design) => {
  it.each(FIXTURES)("keeps the shared invariants with fixture %s", (name) => {
    const { doc, page, baseline } = pages(inDesign(loadFixture(name), design));
    expect(invariantProblems(page, baseline, doc, DESIGNS[design])).toEqual([]);
  });

  // A section the owner hid is gone from <main> and from every link (A6), in every design.
  it.each(FIXTURES)("keeps the shared invariants with fixture %s when the owner hides sections", (name) => {
    const problems = HIDE_SETS.map((hidden) => {
      const { doc, page, baseline } = pages(withHidden(inDesign(loadFixture(name), design), hidden));
      return { hidden, problems: invariantProblems(page, baseline, doc, DESIGNS[design]) };
    });
    expect(problems).toEqual(HIDE_SETS.map((hidden) => ({ hidden, problems: [] })));
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
  // The edits apply to today's page (BASELINE), which no design build changes.
  const { doc, baseline: page } = pages(loadFixture("plumber-austin"));
  const problems = (edited: string) => invariantProblems(edited, page, doc, BASELINE);

  it("pass today's page", () => {
    expect(problems(page)).toEqual([]);
    expect(formSkeleton(page)).toContain("Send request");
    expect(formSkeleton(page)).toContain('<div aria-hidden="true"><label for="contact-website">Leave this field empty</label><input id="contact-website" name="website" type="text" tabindex="-1" autocomplete="off"></div>');
    expect(navLinks(page)).toContain("#faq FAQ");
  });

  it.each([
    ["an attribute before a section's id", page.replace('<section id="services"', '<section class="x" id="services"'), /^sections /],
    ["a section left out", page.replace('<section id="faq"', '<div id="faq"').replace(/(<div id="faq"[\s\S]*?)<\/section>/, "$1</div>"), /^sections /],
    ["a <body> that does not name the design", page.replace('<body data-design="impact" ', "<body "), /^<body> does not name the design$/],
    ["a second <aside>", page.replace("</footer>", '</footer><aside aria-label="Hours">Open</aside>'), /^2 <aside> elements$/],
    ['a call bar not labelled "Call us"', page.replace('<aside aria-label="Call us"', '<aside aria-label="Call"'), /^the <aside> is not labelled "Call us"$/],
    ["a call bar that does not call the business", page.replace(/(<aside\b[^>]*>[\s\S]*?)href="tel:[^"]*"/, '$1href="#contact"'), /^the call bar does not call the business$/],
    ["a comment that is not the design's attribution", page.replace(BASELINE.attribution, "<!-- Portions adapted from elsewhere. -->"), /^the one comment is not the design's attribution$/],
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
    ["a link to an element the page lacks", page.replace("</footer>", '<p><a href="#quote">Get a quote</a></p>\n</footer>'), /^in-page links to missing ids \["#quote"\]$/],
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
    ["a Main nav with one list of links (no separate phone menu)", page.replace(/<details class="group relative lg:hidden">[\s\S]*?<\/details>\n/, "")],
    ["extra links in the Main nav", page.replace('<ul class="hidden items-center gap-1 lg:flex">', '<a href="#top">Open the menu</a>\n<ul class="hidden items-center gap-1 lg:flex">')],
    // The Bold r4 mockup closes its :target phone menu with href="#", which leads to the top of the page.
    ["a link to the top of the page (href=\"#\")", page.replace('<ul class="hidden items-center gap-1 lg:flex">', '<a href="#">Close the menu</a>\n<ul class="hidden items-center gap-1 lg:flex">')],
  ])("allow %s", (_, edited) => {
    expect(edited).not.toBe(page);
    expect(problems(edited)).toEqual([]);
  });

  // A design that draws today's header from the whole layout instead of the sections the page shows
  // passes every other check, yet links sections the page leaves out (A12-0 round-2 attack, I-2).
  const leaky: Design = { ...BASELINE, header: (ctx) => BASELINE.header({ ...ctx, sections: ctx.doc.layout }) };
  it.each([
    ["the owner hid", withHidden(loadFixture("plumber-austin"), ["testimonials", "gallery"]), ["#reviews", "#our-work"]],
    ["that have no content", loadFixture("cleaning-minimal"), ["#reviews", "#our-work", "#about", "#faq"]],
  ])("catch a design whose navigation links sections %s", (_, input, dead) => {
    const doc = SiteDocument.parse(input);
    const baseline = renderDocument(doc, BASELINE, OPTIONS).html;
    expect(invariantProblems(renderDocument(doc, leaky, OPTIONS).html, baseline, doc, leaky)).toEqual([`in-page links to missing ids ${JSON.stringify(dead)}`]);
  });

  it("catch a section the owner hid that is still on the page as another element (with its link)", () => {
    const doc = SiteDocument.parse(withHidden(loadFixture("plumber-austin"), ["testimonials"]));
    const baseline = renderDocument(doc, BASELINE, OPTIONS).html;
    const edited = baseline.replace("</main>", '<p><a href="#reviews">Read our reviews</a></p>\n<div id="reviews"><p>Great work, fair price.</p></div>\n</main>');
    expect(edited).not.toBe(baseline);
    expect(invariantProblems(edited, baseline, doc, BASELINE)).toEqual(['left-out sections keep ids ["reviews"]']);
  });

  // The honesty rule (design §2.2; Plan 1 decisions 5 and 7): a page states no credential the owner's facts
  // do not back, and never the contractor bond. BASELINE's own module tests pin it for today's text; a design
  // build replaces those modules, so the shared check compares the design's text with today's (A12-0
  // round-4 rulings: attack3 I-1, review3 I-1).
  const boasting: Design = {
    ...BASELINE,
    footer: (ctx) => html`${BASELINE.footer(ctx)}\n<p>Licensed, insured and bonded. Free estimates and emergency service. Satisfaction guaranteed.</p>`,
  };
  it.each([
    ["plumber-austin", ["bonded", "guaranteed"]],
    ["hvac-phoenix", ["bonded", "guaranteed", "free"]],
    ["roofing-extreme", ["bonded", "guaranteed"]],
    ["cleaning-minimal", ["bonded", "guaranteed", "licensed", "insured", "emergency", "free"]],
    ["electrical-xss", ["bonded", "guaranteed", "emergency", "free"]],
  ] as const)("catch a design whose own text states claims no owner fact backs, on %s", (name, claims) => {
    const doc = SiteDocument.parse(loadFixture(name));
    const baseline = renderDocument(doc, BASELINE, OPTIONS).html;
    expect(invariantProblems(renderDocument(doc, boasting, OPTIONS).html, baseline, doc, boasting)).toEqual([`unbacked claims ${JSON.stringify(claims)}`]);
  });

  it.each([
    ["an entity between the words", "<p>Licensed &amp; insured</p>", ["licensed", "insured"]],
    ["a badge label only a screen reader reads", '<p><svg aria-label="Certified and bonded" width="1" height="1"></svg></p>', ["bonded", "certified"]],
    ["a warranty and a price boast", "<ul><li>Lifetime warranty</li><li>Lowest prices in town</li></ul>", ["warranty", "lowest"]],
    ["round-the-clock hours", "<p>Open 7 days a week, day or night.</p>", ["day or night"]],
    ["a 24/7 pill", '<p><span class="pill">24/7</span> Call now</p>', ["24/7"]],
    ["a claim inside quotation marks", '<p>"Fully insured crew"</p>', ["insured"]],
    // Digits and symbols, which site-schema's word lists leave out (A12-0 round-5 rulings, review4 I-1).
    ["a star row that screen readers skip", '<p><span aria-hidden="true">\u2605\u2605\u2605\u2605\u2605</span> Loved by our neighbors</p>', ["\u2605"]],
    ["a 5-star claim", "<p>5-star service</p>", ["5-star"]],
    ["a 4.9-star rating", "<p>4.9 stars on Google</p>", ["4.9 stars"]],
    ["24-hour opening", "<p>Open 24 hours</p>", ["24 hours"]],
    ["24-hour service", "<p>24-hour service</p>", ["24-hour"]],
    ["same-day service", "<p>Same-day service</p>", ["same-day"]],
    ["two claims of one kind in one text", "<p>Same-day or next-day visits, 24 hrs</p>", ["same-day", "next-day", "24 hrs"]],
  ])("catch %s on cleaning-minimal", (_, extra, claims) => {
    const doc = SiteDocument.parse(loadFixture("cleaning-minimal"));
    const baseline = renderDocument(doc, BASELINE, OPTIONS).html;
    const edited = baseline.replace("</footer>", `${extra}\n</footer>`);
    expect(edited).not.toBe(baseline);
    expect(invariantProblems(edited, baseline, doc, BASELINE)).toEqual([`unbacked claims ${JSON.stringify(claims)}`]);
  });

  // The probe of A12-0 review4 I-1, as a design whose own text adds a star rating and 24-hour and same-day
  // service, on every fixture. hvac-phoenix's owner is open around the clock, so today's page already says
  // "Open 24 hours" there, and that one is not the design's claim.
  const starry: Design = {
    ...BASELINE,
    footer: (ctx) =>
      html`${BASELINE.footer(ctx)}\n<p><span aria-hidden="true">\u2605\u2605\u2605\u2605\u2605</span> 5-star service, 4.9 stars on Google</p>\n<p>Open 24 hours. Same-day service.</p>`,
  };
  it.each(FIXTURES)("catch a design whose own text states a star rating and 24-hour and same-day service, on %s", (name) => {
    const doc = SiteDocument.parse(loadFixture(name));
    const baseline = renderDocument(doc, BASELINE, OPTIONS).html;
    const claims = ["\u2605", "5-star", "4.9 stars", ...(name === "hvac-phoenix" ? [] : ["24 hours"]), "same-day"];
    expect(invariantProblems(renderDocument(doc, starry, OPTIONS).html, baseline, doc, starry)).toEqual([`unbacked claims ${JSON.stringify(claims)}`]);
  });

  it("allow a design to repeat the owner's own 24-hour opening, however it spaces it", () => {
    const doc = SiteDocument.parse(loadFixture("hvac-phoenix"));
    const baseline = renderDocument(doc, BASELINE, OPTIONS).html;
    const edited = baseline.replace("</footer>", "<p>Open 24 hours</p>\n<p>Open 24&nbsp;HOURS</p>\n</footer>");
    expect(edited).not.toBe(baseline);
    expect(invariantProblems(edited, baseline, doc, BASELINE)).toEqual([]);
  });

  it("allow a design to repeat a claim the owner's facts back, in quotation marks too", () => {
    const edited = page.replace("</footer>", '<p>Licensed and insured. Free estimates. 24/7 emergency service.</p>\n<p>"Licensed and insured"</p>\n</footer>');
    expect(edited).not.toBe(page);
    expect(problems(edited)).toEqual([]);
  });

  // Why the check is relative: owner words the claim checker never reads (a real review) can hold a claim
  // word, and every design shows them too.
  it("today's pages state only the claims of the owner's own reviews and opening hours", () => {
    const claims = FIXTURES.map((name) => {
      const doc = SiteDocument.parse(loadFixture(name));
      return [name, pageClaims(renderDocument(doc, BASELINE, OPTIONS).html, doc.facts)];
    });
    expect(claims).toEqual(FIXTURES.map((name) => [name, name === "hvac-phoenix" ? ["warranty", "24 hours"] : []]));
    const hvac = loadFixture("hvac-phoenix").facts;
    expect(JSON.stringify(hvac.testimonials)).toContain("registered the warranty for us");
    expect(hvac.hours).toContainEqual(expect.objectContaining({ opens: "00:00", closes: "23:59" })); // shown as "Open 24 hours"
  });

  it("allow a design to show today's review in its own quotation marks", () => {
    const doc = SiteDocument.parse(loadFixture("hvac-phoenix"));
    const baseline = renderDocument(doc, BASELINE, OPTIONS).html;
    const review = "Clean install, great crew, and they registered the warranty for us.";
    const edited = baseline.replace(`>${review}<`, `>"${review}"<`);
    expect(edited).not.toBe(baseline);
    expect(invariantProblems(edited, baseline, doc, BASELINE)).toEqual([]);
  });

  it("read the credential claims: every NEEDS_A_FACT pattern, and NEVER_IN_COPY's bond, rating, guarantee and price words only", () => {
    expect(CREDENTIAL_CLAIMS).toEqual([NEVER_IN_COPY[0], NEVER_IN_COPY[1], NEVER_IN_COPY[4], NEVER_IN_COPY[5], ...NEEDS_A_FACT.map((n) => n.pattern)]);
    // NEVER_IN_COPY's other patterns guard AI copy only. A curly quote or a quoted caption (decorative in the
    // Classic and Modern mockups), review words, years, weekdays and web addresses state no credential.
    const doc = SiteDocument.parse(loadFixture("cleaning-minimal"));
    expect(pageClaims("<p>\u201c</p><figcaption>\"Kitchen\" after</figcaption><p>Reviews since 1990, Monday. mop.com</p>", doc.facts)).toEqual([]);
  });

  it('read "24/7" as the round-the-clock claim, backed only by the 24/7 fact', () => {
    const texts = ["Open 24/7", "24 / 7 service", "24/7/365", "Call 124/7", "Back in 24/72 h", "Open 24 hours"];
    expect(texts.map((text) => ROUND_THE_CLOCK.pattern.exec(text)?.[0] ?? null)).toEqual(["24/7", "24 / 7", "24/7", null, null, null]);
    const withFact = SiteDocument.parse(loadFixture("plumber-austin")).facts;
    const without = SiteDocument.parse(loadFixture("electrical-xss")).facts;
    expect([withFact.emergency247, without.emergency247]).toEqual([true, false]);
    expect([pageClaims("<p>Open 24/7</p>", withFact), pageClaims("<p>Open 24/7</p>", without)]).toEqual([[], ["24/7"]]);
  });

  it("read star ratings, and 24-hour, same-day and next-day service, in symbols, digits and words", () => {
    const read = (pattern: RegExp, texts: readonly string[]) => texts.map((text) => pattern.exec(text)?.[0] ?? null);
    const stars = ["\u2605\u2605\u2605\u2605\u2606", "\u2B50 Google", "\u272A", "5-star", "5 Stars", "4.9-star", "4.9 stars", "5 out of 5 stars", "10 \u2013 star", "5\u2011star"];
    expect(read(STAR_RATING, stars)).toEqual(["\u2605", "\u2B50", "\u272A", "5-star", "5 Stars", "4.9-star", "4.9 stars", "5 out of 5 stars", "10 \u2013 star", "5\u2011star"]);
    expect(read(STAR_RATING, ["Star Plumbing", "the star of the show", "Superstar crew", "5 starters", "A5 star", "\u2726 New"])).toEqual([null, null, null, null, null, null]);
    const hours = ["Open 24 hours", "24-hour service", "24 hr line", "24hrs", "24\u2011hour", "Same-day service", "same day", "Next\u2013Day visits"];
    expect(read(SERVICE_HOURS, hours)).toEqual(["24 hours", "24-hour", "24 hr", "24hrs", "24\u2011hour", "Same-day", "same day", "Next\u2013Day"]);
    expect(read(SERVICE_HOURS, ["Open 24/7", "124 hours", "Since 2024, hours vary", "some days", "same-daylight", "Monday"])).toEqual([null, null, null, null, null, null]);
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
