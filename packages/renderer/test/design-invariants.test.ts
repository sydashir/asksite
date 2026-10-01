import {
  Copy,
  DESIGN_IDS,
  Facts,
  FONT_IDS,
  HIDEABLE_SECTIONS,
  NEEDS_A_FACT,
  NEVER_IN_COPY,
  PAGE_IDS,
  PALETTE_IDS,
  SECTION_VARIANTS,
  proseIn,
  SiteDocument,
  Theme,
  unbackedClaims,
  type DesignId,
  type HideableSectionId,
  type PageId,
  type SiteDocumentInput,
} from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { FIXTURE_FORM_ACTION, FIXTURE_SITE_URL, FIXTURES, inDesign, loadFixture, stubStylesheets } from "../../../fixtures/index.ts";
import { BASELINE } from "../src/baseline.ts";
import type { Design } from "../src/design.ts";
import { DESIGNS } from "../src/designs/index.ts";
import { html } from "../src/html.ts";
import { render, renderDocument, type RenderedSite } from "../src/render.ts";
import {
  CREDENTIAL_CLAIMS,
  deadLinksOf,
  expectedSectionIds,
  formSkeleton,
  invariantProblems,
  navAnchors,
  navLinks,
  pageClaims,
  ROUND_THE_CLOCK,
  SERVICE_HOURS,
  STAR_RATING,
  variableProblems,
} from "./support/design-invariants.ts";

const OPTIONS = { stylesheets: stubStylesheets(), formAction: FIXTURE_FORM_ACTION, siteUrl: FIXTURE_SITE_URL };

/** The design's site for `input`, and today's site (BASELINE) for the same document. */
function sites(input: SiteDocumentInput) {
  const doc = SiteDocument.parse(input);
  return { doc, site: render(input, OPTIONS), baseline: renderDocument(doc, BASELINE, OPTIONS) };
}

/** What `design` draws for `input`, checked against today's site. */
function problemsOf(input: SiteDocumentInput, design: Design): string[] {
  const { doc, baseline } = sites(input);
  return invariantProblems(renderDocument(doc, design, OPTIONS), baseline, doc, design);
}

function withoutHeroPhoto(input: SiteDocumentInput): SiteDocumentInput {
  const { heroPhoto: _photo, ...facts } = input.facts;
  return { ...input, facts };
}

const withHeroVariant = (input: SiteDocumentInput, variant: string): SiteDocumentInput =>
  ({ ...input, layout: input.layout.map((s) => (s.id === "hero" ? { ...s, variant } : s)) }) as SiteDocumentInput;

/**
 * The document with `change` applied to its facts (a credential switched off) and every copy text that would now state a
 * claim no fact backs replaced by a neutral one, so the document is still valid (SiteDocument refuses such copy). The
 * rest of the copy is the AI's own words, unchanged.
 */
function switchedOff(input: SiteDocumentInput, change: (facts: SiteDocumentInput["facts"]) => SiteDocumentInput["facts"]): SiteDocumentInput {
  const facts = change(input.facts);
  const checked = Facts.parse(facts);
  const copy = structuredClone(input.copy) as Record<string, unknown>;
  for (const [path, text] of proseIn(Copy.parse(copy))) {
    if (unbackedClaims(text, checked).length === 0) continue;
    const parent = path.slice(0, -1).reduce<Record<string, unknown>>((node, key) => node[key] as Record<string, unknown>, copy);
    const key = String(path.at(-1));
    parent[key] = key === "question" ? "Do you do careful work?" : key === "ctaText" ? "Careful, honest work." : "Careful work, done right.";
  }
  return { ...input, facts, copy } as SiteDocumentInput;
}

/** The document with every credential the owner could have switched off, so no credential word is backed. */
const unbacked = (input: SiteDocumentInput): SiteDocumentInput =>
  switchedOff(input, ({ yearFounded: _year, ...facts }) => ({ ...facts, insured: false, licences: [], emergency247: false, freeEstimates: false }));

const withHidden = (input: SiteDocumentInput, hidden: readonly HideableSectionId[]): SiteDocumentInput => ({ ...input, hidden: [...hidden] });

/** What an owner can hide (amendment A6): each hideable section alone, then all of them. */
const HIDE_SETS: readonly (readonly HideableSectionId[])[] = [...HIDEABLE_SECTIONS.map((id) => [id]), HIDEABLE_SECTIONS];

// A12 §7 + addendum H1, with A16's per-page invariants, for every design and every fixture.
describe.each(DESIGN_IDS)("the %s design", (design) => {
  it.each(FIXTURES)("keeps the shared invariants on every page of fixture %s", (name) => {
    const { doc, site, baseline } = sites(inDesign(loadFixture(name), design));
    expect(invariantProblems(site, baseline, doc, DESIGNS[design])).toEqual([]);
  });

  // A section the owner hid is gone from its page and from every link (A6), and a page left empty is gone too, in every design.
  it.each(FIXTURES)("keeps the shared invariants with fixture %s when the owner hides sections", (name) => {
    const problems = HIDE_SETS.map((hidden) => {
      const { doc, site, baseline } = sites(withHidden(inDesign(loadFixture(name), design), hidden));
      return { hidden, problems: invariantProblems(site, baseline, doc, DESIGNS[design]) };
    });
    expect(problems).toEqual(HIDE_SETS.map((hidden) => ({ hidden, problems: [] })));
  });

  it.each(FIXTURES)("renders the same pages with either hero variant when %s has no hero photo", (name) => {
    const input = withoutHeroPhoto(inDesign(loadFixture(name), design));
    const variants = SECTION_VARIANTS.hero.map((variant) => JSON.stringify(render(withHeroVariant(input, variant), OPTIONS).pages));
    expect(variants).toHaveLength(2);
    expect(new Set(variants).size).toBe(1);
  });

  it("names its custom properties --aw-<id>-* with safe values, for every palette and lettering", () => {
    for (const palette of PALETTE_IDS) {
      for (const font of FONT_IDS) expect(variableProblems(design, DESIGNS[design].variables(Theme.parse({ palette, font, design })))).toEqual([]);
    }
  });
});

// A16 (SD-7): no owner's site throws or holds a dead link. Every subset of what an owner can hide, with and without
// photos and an about text, for today's design and for each of the three.
describe("every owner's site renders without a throw or a dead link (A16)", () => {
  const SUBSETS = Array.from({ length: 2 ** HIDEABLE_SECTIONS.length }, (_, mask) => HIDEABLE_SECTIONS.filter((_, i) => mask & (1 << i)));

  it.each(["BASELINE", ...DESIGN_IDS] as const)("%s: every subset of what an owner can hide", (which) => {
    expect(SUBSETS).toHaveLength(64);
    const base = loadFixture("plumber-austin");
    const outcomes = SUBSETS.flatMap((hidden) =>
      [true, false].flatMap((photos) =>
        [true, false].map((about) => {
          const { copy, facts } = base;
          const input: SiteDocumentInput = {
            ...inDesign(base, which === "BASELINE" ? "impact" : which),
            hidden: [...hidden],
            facts: { ...facts, photos: photos ? facts.photos : [] },
            copy: about ? copy : (({ about: _about, ...rest }) => rest)(copy),
          };
          const doc = SiteDocument.parse(input);
          const site = renderDocument(doc, which === "BASELINE" ? BASELINE : DESIGNS[which], OPTIONS);
          const expected: PageId[] = ["home", "services", ...(about && !hidden.includes("about") ? (["about"] as const) : []), ...(photos && !hidden.includes("gallery") ? (["gallery"] as const) : []), "contact"];
          return { hidden, photos, about, pages: site.pages.map((p) => p.page), expected, dead: deadLinksOf(site) };
        }),
      ),
    );
    expect(outcomes.filter((o) => o.dead.length > 0 || o.pages.join() !== o.expected.join())).toEqual([]);
  });
});

describe("the invariant checks can fail (RED proof, on edited pages)", () => {
  // The edits apply to today's site (BASELINE), which no design build changes.
  const { doc, baseline } = sites(loadFixture("plumber-austin"));
  const at = (site: RenderedSite, path: string) => site.pages.find((p) => p.path === path)!.html;
  /** The problems the shared checks find on page `path` once its HTML is `edited`, without the path prefix. */
  const problemsAt = (path: string, edited: string, others: RenderedSite = baseline) => {
    const site: RenderedSite = { ...others, pages: others.pages.map((p) => (p.path === path ? { ...p, html: edited } : p)) };
    return invariantProblems(site, others, doc, BASELINE).filter((found) => found.startsWith(`${path}: `)).map((found) => found.slice(path.length + 2));
  };
  const home = at(baseline, "/");
  const services = at(baseline, "/services");
  const contact = at(baseline, "/contact");

  it("pass today's site", () => {
    expect(invariantProblems(baseline, baseline, doc, BASELINE)).toEqual([]);
    expect(formSkeleton(contact)).toContain("Send request");
    expect(formSkeleton(contact)).toContain('<form id="quote" action="https://forms.example.com/submit" method="post">');
    expect(formSkeleton(contact)).toContain('<div aria-hidden="true"><label for="contact-website">Leave this field empty</label><input id="contact-website" name="website" type="text" tabindex="-1" autocomplete="off"></div>');
    expect(navLinks(home)).toContain("/services Services");
    expect(navAnchors(services).filter((l) => l.current).map((l) => l.href)).toEqual(["/services", "/services"]);
  });

  it("expect each page's sections as the page map and the owner's order give them", () => {
    expect(PAGE_IDS.map((id) => expectedSectionIds(doc, id))).toEqual([
      ["top", "credentials", "services-preview", "reviews", "get-in-touch"],
      ["services", "faq", "get-in-touch"],
      ["about", "get-in-touch"],
      ["our-work", "get-in-touch"],
      ["contact", "service-area"],
    ]);
    const roofing = SiteDocument.parse(loadFixture("roofing-extreme"));
    expect(expectedSectionIds(roofing, "home")).toEqual(["top", "services-preview", "reviews", "credentials", "get-in-touch"]);
    expect(expectedSectionIds(roofing, "contact")).toEqual(["service-area", "contact"]);
    expect(expectedSectionIds(SiteDocument.parse(withHidden(loadFixture("plumber-austin"), ["testimonials"])), "home")).toEqual(["top", "credentials", "services-preview", "get-in-touch"]);
  });

  it.each([
    ["an attribute before a section's id", "/services", services.replace('<section id="services"', '<section class="x" id="services"'), /^sections /],
    ["a section left out", "/services", services.replace('<section id="faq"', '<div id="faq"').replace(/(<div id="faq"[\s\S]*?)<\/section>/, "$1</div>"), /^sections /],
    ["the closing band left out", "/about", at(baseline, "/about").replace('<section id="get-in-touch"', '<div id="get-in-touch"').replace(/(<div id="get-in-touch"[\s\S]*?)<\/section>/, "$1</div>"), /^sections /],
    ["a closing band on Contact", "/contact", contact.replace("</main>", '<section id="get-in-touch"><h2>Get in touch</h2></section></main>'), /^sections /],
    ["a <body> that does not name the design", "/", home.replace('<body data-design="impact" ', "<body "), /^<body> does not name the design$/],
    ["a second <aside>", "/", home.replace("</footer>", '</footer><aside aria-label="Hours">Open</aside>'), /^2 <aside> elements$/],
    ['a call bar not labelled "Call us"', "/", home.replace('<aside aria-label="Call us"', '<aside aria-label="Call"'), /^the <aside> is not labelled "Call us"$/],
    ["a call bar that does not call the business", "/", home.replace(/(<aside\b[^>]*>[\s\S]*?)href="tel:[^"]*"/, '$1href="#top"'), /^the call bar does not call the business$/],
    ["a call bar without the quote link", "/services", services.replace(/(<aside\b[\s\S]*?)href="\/contact#quote"/, '$1href="/contact"'), /^the call bar does not link to the quote form$/],
    ["a call bar whose quote link goes to #contact-form", "/", home.replace(/(<aside\b[\s\S]*?)href="\/contact#quote"/, '$1href="#contact-form"'), /^the call bar does not link to the quote form$/],
    ["a comment that is not the design's attribution", "/", home.replace(BASELINE.attribution, "<!-- Portions adapted from elsewhere. -->"), /^the one comment is not the design's attribution$/],
    ["a call bar without focus-outside:static", "/", home.replace("focus-outside:static", ""), /^the call bar lacks focus-outside:static$/],
    ["a dropped required", "/contact", contact.replace('autocomplete="name" required', 'autocomplete="name"'), /^the contact form differs/],
    ['a renamed "Send request"', "/contact", contact.replace(">Send request<", ">Send<"), /^the contact form differs/],
    ["a form without id=quote", "/contact", contact.replace('<form id="quote" ', "<form "), /^the contact form differs/],
    ["a honeypot field keyboard focus can reach", "/contact", contact.replace('name="website" type="text" tabindex="-1"', 'name="website" type="text"'), /^the contact form differs/],
    ["a honeypot not hidden from screen readers", "/contact", contact.replace('overflow-hidden" aria-hidden="true"><label for="contact-website"', 'overflow-hidden"><label for="contact-website"'), /^the contact form differs/],
    ["a renamed id", "/contact", contact.replace('id="contact-message"', 'id="message"').replace('for="contact-message"', 'for="message"'), /^ids /],
    ["a duplicate id", "/", home.replace('<main id="main">', '<main id="main"><p id="top">x</p>'), /^duplicate ids$/],
    ["a relabelled menu link", "/", home.replaceAll('href="/services">Services<', 'href="/services">Offerings<'), /^navigation /],
    [
      "a reordered Main nav",
      "/",
      home.replaceAll('href="/services">Services<', "\u0000").replaceAll('href="/about">About<', 'href="/services">Services<').replaceAll("\u0000", 'href="/about">About<'),
      /^navigation /,
    ],
    ['a nav that is not labelled "Main"', "/", home.replace('<nav aria-label="Main"', '<nav aria-label="Site"'), /^navigation /],
    ["a nav link without aria-current on its own page", "/services", services.replaceAll(' aria-current="page"', ""), /^aria-current /],
    ["a nav link without aria-current in the phone menu only", "/services", services.replace(/( aria-current="page")(?![\s\S]*aria-current="page")/, ""), /^aria-current /],
    ["aria-current on another page's link", "/", home.replace('href="/about">About<', 'href="/about" aria-current="page">About<'), /^aria-current /],
    ["a link to the quote form through #contact-form", "/", home.replace('href="/contact#quote">Get a free quote', 'href="#contact-form">Get a free quote'), /^links to nowhere \["#contact-form"\]$/],
    ["a quote link that is not the form's address", "/", home.replace('href="/contact#quote">Get a free quote', 'href="/contact#quote-form">Get a free quote'), /^quote links /],
    ["a second <h1>", "/", home.replace("</main>", "<h1>Welcome</h1></main>"), /^2 <h1> elements$/],
    ["no <h1>", "/", home.replace("<h1 ", "<h2 ").replace("</h1>", "</h2>"), /^0 <h1> elements$/],
    ["an <h1> outside the first section of an inner page", "/services", services.replace("<h1 ", "<h2 ").replace("</h1>", "</h2>").replace("</footer>", "<h1>Services</h1></footer>"), /^the <h1> is not in the page's first section$/],
    ["a jump from h1 to h3", "/", home.replace("</h1>", "</h1><h3>Welcome</h3>"), /^heading level jumps to h3 after h1$/],
    ["a service name left at h3 under the Services page's h1", "/services", services.replace(/<h2 class="text-xl font-bold text-heading">([^<]*)<\/h2>/, '<h3 class="text-xl font-bold text-heading">$1</h3>'), /^heading level jumps to h3 after h1$/],
    ["a <form> on Home", "/", home.replace("</main>", '<form action="https://forms.example.com/submit" method="post"><button type="submit">Send</button></form></main>'), /^1 <form> elements outside the Contact page$/],
    ["an FAQ item that is not exclusive", "/services", services.replace('name="faq"', ""), /details\[name=faq\]/],
    ["a second comment", "/", home.replace("<main", "<!-- x --><main"), /^the one comment/],
    ["changed JSON-LD", "/", home.replace('"@type":"Plumber"', '"@type":"LocalBusiness"'), /^JSON-LD differs/],
    ["a changed title", "/about", at(baseline, "/about").replace("<title>About | ", "<title>About us | "), /^title /],
    ["a changed description", "/gallery", at(baseline, "/gallery").replace("Photos of recent work", "Pictures of work"), /^description /],
    ["a canonical to another page", "/gallery", at(baseline, "/gallery").replace('href="https://fixture.asksite.example/gallery"', 'href="https://fixture.asksite.example/about"'), /^canonical /],
    ["a same-page #quote link on the Contact page (the quote link is always /contact#quote)", "/contact", contact.replace("</footer>", '<p><a href="#quote">Get a quote</a></p>\n</footer>'), /^quote links /],
    ["a link to an element the page lacks", "/", home.replace("</footer>", '<p><a href="#quote">Get a quote</a></p>\n</footer>'), /^links to nowhere \["#quote"\]$/],
    ["a link to an id on another page that is not there", "/", home.replace("</footer>", '<p><a href="/services#nope">More</a></p>\n</footer>'), /^links to nowhere \["\/services#nope"\]$/],
    ["a link to a section of another page without its path", "/", home.replace("</footer>", '<p><a href="#faq">FAQ</a></p>\n</footer>'), /^links to nowhere \["#faq"\]$/],
    ["a link to a page that does not exist", "/", home.replace("</footer>", '<p><a href="/pricing">Pricing</a></p>\n</footer>'), /^links to nowhere \["\/pricing"\]$/],
  ])("catch %s", (_, path, edited, problem) => {
    expect(edited).not.toBe(at(baseline, path));
    expect(problemsAt(path, edited).filter((found) => problem.test(found))).toHaveLength(1);
  });

  it("catch a site whose pages are not today's: a missing page, an extra one, another order", () => {
    const [first, ...rest] = baseline.pages;
    for (const pages of [rest, [...baseline.pages, { page: "home" as const, path: "/" as const, html: home }], [...rest, first!]]) {
      expect(invariantProblems({ ...baseline, pages }, baseline, doc, BASELINE)).toEqual([expect.stringMatching(/^pages /)]);
    }
  });

  // What a design may change (A12-0 round-2 rulings): the checks must not fail these.
  it.each([
    [
      "a Main nav whose aria-label is not its first attribute",
      "/",
      home.replace('<nav aria-label="Main" class="order-last lg:order-none">', '<nav class="order-last lg:order-none" aria-label="Main">'),
    ],
    [
      "a honeypot wrapper that differs only in class (the per-design e2e checks keep it off-screen and out of the tab order)",
      "/contact",
      contact.replace('class="absolute -left-[9999px] h-px w-px overflow-hidden" aria-hidden="true"', 'class="hp" aria-hidden="true"'),
    ],
    ["a Main nav with one list of links (no separate phone menu)", "/", home.replace(/<details class="group relative lg:hidden">[\s\S]*?<\/details>\n/, "")],
    ["extra links in the Main nav", "/", home.replace('<ul class="hidden items-center gap-1 lg:flex">', '<a href="#top">Open the menu</a>\n<ul class="hidden items-center gap-1 lg:flex">')],
    // The Bold r4 mockup closes its :target phone menu with href="#", which leads to the top of the page.
    ["a link to the top of the page (href=\"#\")", "/", home.replace('<ul class="hidden items-center gap-1 lg:flex">', '<a href="#">Close the menu</a>\n<ul class="hidden items-center gap-1 lg:flex">')],
    ["a link to a section of another page", "/", home.replace("</footer>", '<p><a href="/services#faq">FAQ</a></p>\n</footer>')],
  ])("allow %s", (_, path, edited) => {
    expect(edited).not.toBe(at(baseline, path));
    expect(problemsAt(path, edited)).toEqual([]);
  });

  // A design that draws its menu from every page instead of the pages the site has passes every other check, yet links pages the site leaves out
  // (A12-0 round-2 attack, I-2, as pages).
  const leaky: Design = {
    ...BASELINE,
    header: (ctx) => BASELINE.header({ ...ctx, pages: PAGE_IDS.map((id) => ctx.pages.find((p) => p.id === id) ?? { id, path: baseline.pages[0]!.path, label: id, sections: [] }) as typeof ctx.pages }),
  };
  it.each([
    ["the owner hid", withHidden(loadFixture("plumber-austin"), ["gallery", "about"]), ["/about", "/gallery"]],
    ["that have no content", loadFixture("cleaning-minimal"), ["/about", "/gallery"]],
  ])("catch a design whose navigation links pages %s", (_, input, dead) => {
    const found = problemsOf(input, leaky);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((problem) => problem.includes(`links to nowhere ${JSON.stringify(dead)}`) || problem.includes("navigation"))).toBe(true);
    expect(found.filter((problem) => problem.includes("links to nowhere"))).toHaveLength(3 + (0));
  });

  it("catch a section the owner hid that is still on the page as another element (with its link)", () => {
    const hidden = sites(withHidden(loadFixture("plumber-austin"), ["testimonials"]));
    const edited = at(hidden.baseline, "/").replace("</main>", '<p><a href="#reviews">Read our reviews</a></p>\n<div id="reviews"><p>Great work, fair price.</p></div>\n</main>');
    const site: RenderedSite = { ...hidden.baseline, pages: hidden.baseline.pages.map((p) => (p.path === "/" ? { ...p, html: edited } : p)) };
    expect(invariantProblems(site, hidden.baseline, hidden.doc, BASELINE)).toEqual(['/: left-out sections keep ids ["reviews"]']);
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
  ] as const)("catch a design whose own text states claims no owner fact backs, on every page of %s", (name, claims) => {
    const { baseline: base } = sites(loadFixture(name));
    expect(problemsOf(loadFixture(name), boasting)).toEqual(base.pages.map((p) => `${p.path}: unbacked claims ${JSON.stringify(claims)}`));
  });

  // A16 (strict): the claims check holds on every page, not only Home. A design that adds a credential to one inner page only is caught there.
  it.each([
    ["Licensed", ["licensed"]],
    ["24/7", ["24/7"]],
    ["Licensed and 24/7", ["licensed", "24/7"]],
  ])("catch a design that adds %j to the About page only", (extra, claims) => {
    const aboutOnly: Design = { ...BASELINE, section: (ctx, section) => (section.id === "about" ? html`${BASELINE.section(ctx, section)}\n<p>${extra}</p>` : BASELINE.section(ctx, section)) };
    expect(problemsOf(unbacked(loadFixture("plumber-austin")), aboutOnly)).toEqual([`/about: unbacked claims ${JSON.stringify(claims)}`]);
    expect(problemsOf(loadFixture("plumber-austin"), aboutOnly)).toEqual([]); // the owner's facts back both, so the same words are fine
  });

  it("catch a claim added to the closing band, the teaser or the call bar of one page", () => {
    const probes: Array<[string, Design]> = [
      ["the closing band", { ...BASELINE, closingBand: (ctx) => html`${BASELINE.closingBand(ctx)}\n<p>Fully licensed</p>` }],
      ["the teaser", { ...BASELINE, servicesTeaser: (ctx) => html`${BASELINE.servicesTeaser(ctx)}\n<p>Fully licensed</p>` }],
    ];
    const where = probes.map(([, design]) => problemsOf(unbacked(loadFixture("plumber-austin")), design).map((found) => found.split(":")[0]));
    expect(where).toEqual([["/", "/services", "/about", "/gallery"], ["/"]]);
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
    ["words joined by a no-break space or a no-break hyphen", "<p>Same&nbsp;day visits, 5&#8209;star crew</p>", ["5-star", "same day"]],
  ])("catch %s on cleaning-minimal", (_, extra, claims) => {
    const mini = sites(loadFixture("cleaning-minimal"));
    const edited = at(mini.baseline, "/").replace("</footer>", `${extra}\n</footer>`);
    const site: RenderedSite = { ...mini.baseline, pages: mini.baseline.pages.map((p) => (p.path === "/" ? { ...p, html: edited } : p)) };
    expect(edited).not.toBe(at(mini.baseline, "/"));
    expect(invariantProblems(site, mini.baseline, mini.doc, BASELINE)).toEqual([`/: unbacked claims ${JSON.stringify(claims)}`]);
  });

  // The probe of A12-0 review4 I-1, as a design whose own text adds a star rating and 24-hour and same-day
  // service, on every fixture. hvac-phoenix's owner is open around the clock, so today's site already says
  // "Open 24 hours" there, and that one is not the design's claim.
  const starry: Design = {
    ...BASELINE,
    footer: (ctx) =>
      html`${BASELINE.footer(ctx)}\n<p><span aria-hidden="true">\u2605\u2605\u2605\u2605\u2605</span> 5-star service, 4.9 stars on Google</p>\n<p>Open 24 hours. Same-day service.</p>`,
  };
  it.each(FIXTURES)("catch a design whose own text states a star rating and 24-hour and same-day service, on every page of %s", (name) => {
    const { baseline: base } = sites(loadFixture(name));
    const claims = ["\u2605", "5-star", "4.9 stars", ...(name === "hvac-phoenix" ? [] : ["24 hours"]), "same-day"];
    expect(problemsOf(loadFixture(name), starry)).toEqual(base.pages.map((p) => `${p.path}: unbacked claims ${JSON.stringify(claims)}`));
  });

  it("allow a design to repeat the owner's own 24-hour opening, however it spaces it", () => {
    const hvac = sites(loadFixture("hvac-phoenix"));
    const edited = at(hvac.baseline, "/contact").replace("</footer>", "<p>Open 24 hours</p>\n<p>Open 24&nbsp;HOURS</p>\n</footer>");
    const site: RenderedSite = { ...hvac.baseline, pages: hvac.baseline.pages.map((p) => (p.path === "/contact" ? { ...p, html: edited } : p)) };
    expect(edited).not.toBe(at(hvac.baseline, "/contact"));
    expect(invariantProblems(site, hvac.baseline, hvac.doc, BASELINE)).toEqual([]);
  });

  it("allow a design to repeat a claim the owner's facts back, in quotation marks too", () => {
    const edited = home.replace("</footer>", '<p>Licensed and insured. Free estimates. 24/7 emergency service.</p>\n<p>"Licensed and insured"</p>\n</footer>');
    expect(edited).not.toBe(home);
    expect(problemsAt("/", edited)).toEqual([]);
  });

  // Why the check is relative: owner words the claim checker never reads (a real review) can hold a claim
  // word, and every design shows them too. A16: a claim of today's site may sit on any of its pages, so a design may show
  // the owner's own words on another page than today's.
  it("today's sites state only the claims of the owner's own reviews and opening hours", () => {
    const claims = FIXTURES.map((name) => {
      const { doc: fixtureDoc, baseline: base } = sites(loadFixture(name));
      return [name, [...new Set(base.pages.flatMap((p) => pageClaims(p.html, fixtureDoc.facts)))]];
    });
    expect(claims).toEqual(FIXTURES.map((name) => [name, name === "hvac-phoenix" ? ["warranty", "24 hours"] : []]));
    const hvac = loadFixture("hvac-phoenix").facts;
    expect(JSON.stringify(hvac.testimonials)).toContain("registered the warranty for us");
    expect(hvac.hours).toContainEqual(expect.objectContaining({ opens: "00:00", closes: "23:59" })); // shown as "Open 24 hours"
  });

  it("allow a design to show today's review in its own quotation marks", () => {
    const hvac = sites(loadFixture("hvac-phoenix"));
    const review = "Clean install, great crew, and they registered the warranty for us.";
    const edited = at(hvac.baseline, "/").replace(`>${review}<`, `>"${review}"<`);
    const site: RenderedSite = { ...hvac.baseline, pages: hvac.baseline.pages.map((p) => (p.path === "/" ? { ...p, html: edited } : p)) };
    expect(edited).not.toBe(at(hvac.baseline, "/"));
    expect(invariantProblems(site, hvac.baseline, hvac.doc, BASELINE)).toEqual([]);
  });

  // Contract step asked by Plan 3 and the moderator (strict): a design may not print a credential word the owner's
  // facts do not back. With each credential switched off in turn, every page of the design is checked against
  // BASELINE's claims for that same document, so a word that is backed for one owner but printed for all is caught.
  const CREDENTIAL_OFF: ReadonlyArray<readonly [string, (facts: SiteDocumentInput["facts"]) => SiteDocumentInput["facts"]]> = [
    ["insured:false", (facts) => ({ ...facts, insured: false })],
    ["licences:[]", (facts) => ({ ...facts, licences: [] })],
    ["emergency247:false", (facts) => ({ ...facts, emergency247: false })],
    ["freeEstimates:false", (facts) => ({ ...facts, freeEstimates: false })],
    ["yearFounded removed", ({ yearFounded: _year, ...facts }) => facts],
    ["testimonials:[]", (facts) => ({ ...facts, testimonials: [] })],
  ];
  const credentialOff = (design: DesignId) => CREDENTIAL_OFF.map(([name, change]) => [name, switchedOff(inDesign(loadFixture("plumber-austin"), design), change)] as const);

  it("starts from a plumber whose every credential is backed, and each variant really switches one off", () => {
    const facts = Facts.parse(loadFixture("plumber-austin").facts);
    expect([facts.insured, facts.licences.length > 0, facts.emergency247, facts.freeEstimates, facts.yearFounded !== undefined, facts.testimonials.length > 0]).toEqual([true, true, true, true, true, true]);
    const off = credentialOff("impact").map(([name, input]) => [name, Facts.parse(input.facts)] as const);
    expect(off.map(([, f]) => [f.insured, f.licences.length > 0, f.emergency247, f.freeEstimates, f.yearFounded !== undefined, f.testimonials.length > 0])).toEqual([
      [false, true, true, true, true, true],
      [true, false, true, true, true, true],
      [true, true, false, true, true, true],
      [true, true, true, false, true, true],
      [true, true, true, true, false, true],
      [true, true, true, true, true, false],
    ]);
  });

  it.each(DESIGN_IDS)("keeps no unbacked credential claim with each credential switched off (%s)", (design) => {
    const problems = credentialOff(design).map(([name, input]) => {
      const { doc, site, baseline } = sites(input);
      return [name, invariantProblems(site, baseline, doc, DESIGNS[design])] as const;
    });
    expect(problems).toEqual(CREDENTIAL_OFF.map(([name]) => [name, []]));
  });

  // RED proof: a design that prints a credential for owners who have another one is caught for the owner who lacks it.
  const printsInsuredWithALicence: Design = {
    ...BASELINE,
    footer: (ctx) => html`${BASELINE.footer(ctx)}${ctx.doc.facts.licences.length > 0 && html`\n<p>Insured</p>`}`,
  };
  const PAGES_OF_PLUMBER = ["/", "/services", "/about", "/gallery", "/contact"];
  const printsFreeEstimates: Design = { ...BASELINE, footer: (ctx) => html`${BASELINE.footer(ctx)}\n<p>Free estimates</p>` };
  it.each([
    ["a footer that prints Insured whenever the owner has a licence", printsInsuredWithALicence, "insured:false", ["insured"]],
    ["a footer that always prints Free estimates", printsFreeEstimates, "freeEstimates:false", ["free"]],
  ])("catch %s, on every page, in the %s variant only", (_, probe, variant, claims) => {
    const caught = credentialOff("impact").map(([name, input]) => [name, problemsOf(input, probe)] as const).filter(([, found]) => found.length > 0);
    expect(caught.map(([name]) => name)).toEqual([variant]);
    expect(caught[0]?.[1]).toEqual(PAGES_OF_PLUMBER.map((path) => `${path}: unbacked claims ${JSON.stringify(claims)}`));
    expect(problemsOf(loadFixture("plumber-austin"), probe)).toEqual([]); // every credential backed: the same words are fine
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
    const stars = ["\u2605\u2605\u2605\u2605\u2606", "\u2B50 Google", "\u272A", "5-star", "5 Stars", "4.9-star", "4.9 stars", "5 out of 5 stars", "10 \u2013 star"];
    expect(read(STAR_RATING, stars)).toEqual(["\u2605", "\u2B50", "\u272A", "5-star", "5 Stars", "4.9-star", "4.9 stars", "5 out of 5 stars", "10 \u2013 star"]);
    expect(read(STAR_RATING, ["Star Plumbing", "the star of the show", "Superstar crew", "5 starters", "A5 star", "\u2726 New"])).toEqual([null, null, null, null, null, null]);
    const hours = ["Open 24 hours", "24-hour service", "24 hr line", "24hrs", "Same-day service", "same day", "Next\u2013Day visits"];
    expect(read(SERVICE_HOURS, hours)).toEqual(["24 hours", "24-hour", "24 hr", "24hrs", "Same-day", "same day", "Next\u2013Day"]);
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
