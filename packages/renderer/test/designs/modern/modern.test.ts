// The Modern design's own rules (A12 design build; the approved mockup modern-v2/r6 and its judges' must-fixes). The
// shared invariants, XSS, html-validate, class-drift and contrast checks run for Modern in the shared suites; these
// pin what makes Modern Modern and what its judges asked for.
import { FONT_IDS, PALETTE_IDS, SiteDocument, type HideableSectionId, type PageId, type SiteDocumentInput } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { FIXTURE_FORM_ACTION, FIXTURE_SITE_URL, FIXTURES, inDesign, loadFixture, stubStylesheets, type FixtureName } from "../../../../../fixtures/index.ts";
import { BASELINE } from "../../../src/baseline.ts";
import { AA_LARGE_TEXT, contrastRatio, hexToRgb } from "../../../src/contrast.ts";
import { DESIGNS } from "../../../src/designs/index.ts";
import { cardColumns } from "../../../src/designs/modern/sections.ts";
import { areaSummary, groupedHours } from "../../../src/designs/modern/text.ts";
import { MODERN_COLORS, MODERN_FONTS, modernVariables } from "../../../src/designs/modern/tokens.ts";
import { render } from "../../../src/index.ts";
import { renderDocument } from "../../../src/render.ts";
import { invariantProblems } from "../../support/design-invariants.ts";
import { startTags } from "../../support/page-safety.ts";

const OPTIONS = { stylesheets: stubStylesheets(), formAction: FIXTURE_FORM_ACTION, siteUrl: FIXTURE_SITE_URL };
const site = (input: SiteDocumentInput) => render(inDesign(input, "modern"), OPTIONS);
/** Every page of Modern's site for `input`, Home first, as one string: for checks that hold whichever page shows the content. */
const modern = (input: SiteDocumentInput): string => site(input).pages.map((p) => p.html).join("\n");
/** One page of Modern's site for `input` ("" when the site has no such page). */
const pageOf = (input: SiteDocumentInput, id: PageId): string => site(input).pages.find((p) => p.page === id)?.html ?? "";
/** The shared invariants (A12 §7, A16, the honesty rule included) for Modern's site of `input`, against today's site. */
function problems(input: SiteDocumentInput): string[] {
  const doc = SiteDocument.parse(inDesign(input, "modern"));
  return invariantProblems(site(input), renderDocument(doc, BASELINE, OPTIONS), doc, DESIGNS.modern);
}
const fixture = (name: FixtureName): string => modern(loadFixture(name));
const withFacts = (input: SiteDocumentInput, facts: Partial<SiteDocumentInput["facts"]>): SiteDocumentInput => ({ ...input, facts: { ...input.facts, ...facts } });
const withHidden = (input: SiteDocumentInput, hidden: HideableSectionId[]): SiteDocumentInput => ({ ...input, hidden });
const withoutHeroPhoto = (input: SiteDocumentInput): SiteDocumentInput => {
  const { heroPhoto: _photo, ...facts } = input.facts;
  return { ...input, facts };
};

/** The markup of the element that starts at `<tag … class="…name…"`, up to its matching end tag. */
function element(page: string, start: string): string {
  const from = page.indexOf(start);
  if (from === -1) return "";
  const tag = /^<([a-z0-9]+)/.exec(start)?.[1] ?? "";
  let depth = 0;
  for (const match of page.slice(from).matchAll(new RegExp(`<(/?)${tag}\\b[^>]*>`, "g"))) {
    depth += match[1] === "/" ? -1 : 1;
    if (depth === 0) return page.slice(from, from + (match.index ?? 0) + match[0].length);
  }
  return page.slice(from);
}
const hero = (page: string) => element(page, '<section id="top"');
/** `input` with the trust section moved after the reviews (the owner's order on Home, A16 U1): a band of its own there. */
function trustLater(input: SiteDocumentInput): SiteDocumentInput {
  const trust = input.layout.filter((section) => section.id === "trust");
  const rest = input.layout.filter((section) => section.id !== "trust");
  const reviews = rest.findIndex((section) => section.id === "testimonials");
  return { ...input, layout: [...rest.slice(0, reviews + 1), ...trust, ...rest.slice(reviews + 1)] };
}
/** `input` with the trust section moved straight after the hero. */
function trustFirst(input: SiteDocumentInput): SiteDocumentInput {
  const trust = input.layout.filter((section) => section.id === "trust");
  const [first, ...rest] = input.layout.filter((section) => section.id !== "trust");
  return { ...input, layout: [first!, ...trust, ...rest] };
}
const imageSources = (markup: string) => startTags(markup).filter((t) => t.name === "img").map((t) => t.attributes.find((a) => a.name === "src")?.value);

describe("Modern: every page can call or ask for a quote (A16)", () => {
  const pages = site(loadFixture("plumber-austin")).pages;

  it("the call bar says Call (its name carries the number) and Get a quote: sticky on every page but Contact, where it closes the footer on the brand colour", () => {
    for (const { page, html } of pages) {
      const bar = element(html, "<aside");
      expect(bar).toContain('<a class="button button-act whitespace-nowrap" href="tel:+15125550142" aria-label="Call (512) 555-0142">');
      expect(bar).toMatch(/<\/svg>Call<\/a>\n<a class="button button-line" href="\/contact#quote">Get a quote<\/a>/);
      expect(bar.startsWith(page === "contact" ? '<aside aria-label="Call us" class="callbar on-brand focus-outside:static">' : '<aside aria-label="Call us" class="callbar sticky focus-outside:static">')).toBe(true);
    }
  });

  it("every page but Contact ends with the closing band: a card with Call (the number) and the call to action to the form", () => {
    for (const { page, html } of pages) {
      const band = element(html, '<section id="get-in-touch"');
      if (page === "contact") {
        expect(band).toBe("");
        continue;
      }
      expect(html.indexOf("</main>") - html.indexOf("</section>", html.indexOf('<section id="get-in-touch"'))).toBe("</section>\n".length);
      const card = element(band, '<div class="close-card');
      expect(card).toContain('<h2 id="get-in-touch-title" class="display h2">Get in touch</h2>');
      expect(card).toContain('href="tel:+15125550142"><svg class="i" viewBox="0 0 24 24" aria-hidden="true">');
      expect(card).toContain("Call (512) 555-0142</a>");
      expect(card).toContain('<a class="button button-line button-lg" href="/contact#quote">Get a free quote</a>');
    }
  });

  // A16 round 1's judges (/about): the About band, the closing card and the footer were three brand slabs in a row.
  it("draws the closing card on the brand colour, or white with the brand rule right after a band on the brand colour (About, Home's credentials band)", () => {
    const card = (input: SiteDocumentInput, id: PageId) => /<div class="(close-card[^"]*)">/.exec(pageOf(input, id))?.[1];
    const plumber = loadFixture("plumber-austin");
    expect(["home", "services", "gallery"].map((id) => card(plumber, id as PageId))).toEqual(Array(3).fill("close-card on-brand"));
    expect(card(plumber, "about")).toBe("close-card close-card--light");
    expect(card(trustLater(plumber), "home")).toBe("close-card close-card--light");
    expect(card(withHidden(trustLater(plumber), ["trust"]), "home")).toBe("close-card on-brand");
  });

  it("the closing band gives a reason to act from the owner's own facts only: 24/7 service and free estimates, each with its fact, else the towns it serves", () => {
    const line = (input: SiteDocumentInput) => element(element(pageOf(input, "home"), '<section id="get-in-touch"'), '<ul class="proof-line"').replace(/<[^>]*>/g, "");
    expect(line(loadFixture("plumber-austin"))).toBe("24/7 emergency serviceFree estimates");
    expect(line(loadFixture("hvac-phoenix"))).toBe("24/7 emergency service");
    // Free estimates is one of the credentials: an owner who hides them hides it here too; 24/7 stays, as in the hero.
    expect(line(withHidden(loadFixture("plumber-austin"), ["trust"]))).toBe("24/7 emergency service");
    // Neither fact: the towns the business serves, summed up as in the no-photo hero; nothing when the owner hides them.
    expect(line(loadFixture("cleaning-minimal"))).toBe("Serving Boise, ID");
    // (Copy that claims nothing, so the schema accepts both facts turned off.)
    const plumber = loadFixture("plumber-austin");
    const plain = withFacts({ ...plumber, copy: { ...plumber.copy, ctaText: "Get a quote", heroSubheadline: "Clear prices and tidy work.", faq: [] } }, { emergency247: false, freeEstimates: false });
    expect(line(plain)).toBe("Serving Austin, Round Rock and 5 more");
    expect(line(withHidden(plain, ["serviceArea"]))).toBe("");
  });

  it("from 1200 px the header carries a quote button on every page, Contact included (moderator ruling (f))", () => {
    for (const { html } of pages) {
      const header = element(html, "<header");
      expect(header).toContain('<a class="button button-line hdr-quote" href="/contact#quote">Get a quote</a>');
      expect(header).toContain('<a class="button button-act hdr-call whitespace-nowrap" href="tel:+15125550142" aria-label="Call (512) 555-0142">');
    }
  });
});

describe("Modern: every inner page opens like Home (A16, ruling (e))", () => {
  const strip = (markup: string) => element(markup, '<div class="band band--brand"').replace(/<[^>]*>/g, "");
  const firstSection = (html: string) => element(html, /<section [^>]*>/.exec(html.slice(html.indexOf("<main")))?.[0] ?? "<section");

  it("its first section starts with Home's brand strip (24/7 service, the trade and the town) and livery seam, above the h1", () => {
    for (const { page, html } of site(loadFixture("plumber-austin")).pages) {
      if (page === "home") continue;
      const first = firstSection(html);
      expect(first.indexOf('<div class="band band--brand">')).toBeGreaterThan(0);
      expect(first.indexOf('<div class="band band--brand">')).toBeLessThan(first.indexOf("<h1 "));
      expect(strip(first)).toBe("24/7 emergency servicePlumbing · Austin, TX");
      // Only the opening section has it.
      expect(html.split('<div class="band band--brand">')).toHaveLength(2);
    }
    expect(strip(pageOf(loadFixture("hvac-phoenix"), "services"))).toBe("24/7 emergency serviceHeating &amp; Cooling · Phoenix, AZ");
    expect(strip(pageOf(loadFixture("electrical-xss"), "gallery"))).not.toContain("24/7");
  });
});

describe("Modern: the header names every page and marks the one on screen (A16)", () => {
  it("lists the site's pages in both menus, the current one marked aria-current, and the name leads Home unmarked", () => {
    for (const { page, html } of site(loadFixture("hvac-phoenix")).pages) {
      const header = element(html, "<header");
      expect(header).toContain('<a class="brand" href="/">Desert Air Heating &amp; Cooling</a>');
      const links = [...header.matchAll(/<li><a href="([^"]*)"( aria-current="page")?>([^<]*)<\/a><\/li>/g)].map((m) => `${m[1]}${m[2] ? "*" : ""} ${m[3]}`);
      const list = ["/ Home", "/services Services", "/gallery Gallery", "/contact Contact"].map((l) => (l.split(" ")[0] === ({ home: "/", services: "/services", gallery: "/gallery", contact: "/contact" } as Record<string, string>)[page] ? l.replace(" ", "* ") : l));
      expect(links).toEqual([...list, ...list]);
    }
  });
});

describe("Modern: Home previews the first three services (A16)", () => {
  it("in the owner's order, each a ticked line with its From price, or 'Price on request' as on the Services page (no box: not a link), and one link to the Services page", () => {
    const preview = element(pageOf(loadFixture("plumber-austin"), "home"), '<section id="services-preview"');
    expect(preview).toContain('<ul class="teaser-list">');
    expect([...preview.matchAll(/<li><svg class="i" [^>]*>[^]*?<\/svg><h3 class="h3">([^<]*)<\/h3><p class="price[^"]*">(?:<small>From<\/small> )?([^<]*)<\/p><\/li>/g)].map((m) => [m[1], m[2]])).toEqual([
      ["Drain cleaning", "$89"],
      ["Water heater repair &amp; install", "$149"],
      ["Leak detection", "Price on request"],
    ]);
    expect(preview).toContain('<p class="price price--ask">Price on request</p>');
    // As on the Services page: an owner who prices no service is never told "Price on request".
    expect(element(pageOf(loadFixture("cleaning-minimal"), "home"), '<section id="services-preview"')).not.toContain("<p class=\"price");
    expect(preview).not.toContain('class="card');
    expect([...preview.matchAll(/href="([^"]*)"/g)].map((m) => m[1])).toEqual(["/services"]);
    expect(preview).toContain('<a class="button button-line teaser-more" href="/services">More about our services<svg');
  });

  it("names its column count for one or two services, so they fill the row", () => {
    const plumber = loadFixture("plumber-austin");
    const list = (count: number) => {
      const one = withFacts(plumber, { services: plumber.facts.services.slice(0, count) });
      return /<ul class="(teaser-list[^"]*)">/.exec(pageOf({ ...one, copy: { ...one.copy, serviceDescriptions: plumber.copy.serviceDescriptions.slice(0, count) } }, "home"))?.[1];
    };
    expect([1, 2, 3].map(list)).toEqual(["teaser-list teaser-list--1", "teaser-list teaser-list--2", "teaser-list"]);
  });
});

describe("Modern: inner pages open with their own heading (A16)", () => {
  it("the page's first section heading is its h1, and that section's items are h2 under it", () => {
    const plumber = loadFixture("plumber-austin");
    expect(pageOf(plumber, "services")).toContain('<h1 id="services-title" class="display h1">Our services</h1>');
    const [hero, ...rest] = plumber.layout;
    const faqFirst: SiteDocumentInput = { ...plumber, layout: [hero!, ...rest.filter((s) => s.id === "faq"), ...rest.filter((s) => s.id !== "faq")] };
    const services = pageOf(faqFirst, "services");
    expect(services).toContain('<h1 id="faq-title" class="display h1">Questions &amp; answers</h1>');
    expect(services).toContain('<summary><h2 class="h3">Do you charge for estimates?</h2>');
    expect(services).toContain('<h2 id="services-title" class="display h2">Our services</h2>');
    expect(services).toContain('<li class="card"><h3 class="h3">Drain cleaning</h3>');
  });
});

/** `input` with the FAQ moved before the services (the owner's order on the Services page, A16 U1). */
function faqFirst(input: SiteDocumentInput): SiteDocumentInput {
  const [hero, ...rest] = input.layout;
  return { ...input, layout: [hero!, ...rest.filter((s) => s.id === "faq"), ...rest.filter((s) => s.id !== "faq")] };
}
/** The text of the owner's credentials list (a line, or a list with labels) that starts at `start`. */
const credentialsIn = (markup: string, start: string) => [...element(markup, start).matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => (m[1] ?? "").replace(/<small>[^<]*<\/small>/g, "").replace(/<[^>]*>/g, ""));

describe("Modern: the Services page (A16)", () => {
  const plumber = loadFixture("plumber-austin");

  it("names the owner's credentials under its heading, next to the prices; none when the owner hides them", () => {
    const head = element(element(pageOf(plumber, "services"), '<section id="services"'), '<div class="head"');
    expect(credentialsIn(head, '<ul class="proof-line"')).toEqual(["License M-40123", "Insured", "Since 1998", "Free estimates"]);
    expect(element(pageOf(withHidden(plumber, ["trust"]), "services"), '<section id="services"')).not.toContain("proof-line");
  });

  it("keeps the FAQ's call card only where the closing band does not follow straight after it (judges: three Call buttons in a row)", () => {
    expect(element(pageOf(plumber, "services"), '<section id="faq"')).not.toContain("Still have a question?");
    expect(element(pageOf(plumber, "services"), '<section id="faq"')).toContain('<div class="wrap faq faq--solo">');
    expect(element(pageOf(faqFirst(plumber), "services"), '<section id="faq"')).toContain("Still have a question?");
  });

  it("marks the service cards that share a row with the call-to-action card (2 columns below 1024 px, the grid's own from there), so they keep their own height", () => {
    const classes = (input: SiteDocumentInput) => [...element(pageOf(input, "services"), '<ul class="cards').matchAll(/<li class="(card[^"]*)"/g)].map((m) => m[1]);
    // 5 services in 3 columns: the last two share the card's row from 1024 px, the last one below it.
    expect(classes(plumber)).toEqual(["card", "card", "card", "card card--t3", "card card--t2 card--t3", "card ask on-brand"]);
    // 2 services in 3 columns: both share it from 1024 px; in 2 columns the card has a row of its own.
    expect(classes(loadFixture("cleaning-minimal"))).toEqual(["card card--t3", "card card--t3", "card ask on-brand"]);
  });
});

describe("Modern: the Contact page (A16)", () => {
  it("shows its heading, the call card, the form, then the owner's credentials, and the opening hours, with or without a hero photo", () => {
    for (const input of [loadFixture("plumber-austin"), withoutHeroPhoto(loadFixture("plumber-austin"))]) {
      const contact = pageOf(input, "contact");
      const at = (text: string) => contact.indexOf(text);
      expect(at('<h1 id="contact-title"')).toBeLessThan(at('<div class="call-card">'));
      expect(at('<div class="call-card">')).toBeLessThan(at('<form id="quote" class="form"'));
      expect(at("</form>")).toBeLessThan(at('<div class="cred-card">'));
      expect(credentialsIn(contact, '<div class="cred-card"')).toEqual(["License M-40123", "Insured", "Since 1998", "Free estimates"]);
      expect(element(contact, '<section id="service-area"').replace(/<[^>]*>/g, "")).toContain("7:30 AM – 6:00 PM");
    }
    expect(pageOf(withHidden(loadFixture("plumber-austin"), ["trust"]), "contact")).not.toContain("cred-card");
    // More licenses than the card shows: the rest are one link away, in the footer.
    expect(element(pageOf(loadFixture("roofing-extreme"), "contact"), '<div class="cred-card"')).toContain('<a href="#licenses">See all 5 licenses');
  });

  it("puts Call and the call to action under the heading when the owner puts the service area before the form", () => {
    const head = (input: SiteDocumentInput) => element(element(pageOf(input, "contact"), '<section id="service-area"'), '<div class="head"');
    const roofing = head(loadFixture("roofing-extreme"));
    expect(roofing).toContain('<h1 id="service-area-title"');
    expect(roofing).toMatch(/<div class="head-cta"><a class="button button-act whitespace-nowrap button-lg" href="tel:\+12145550163">[^]*<\/a><a class="button button-line button-lg" href="\/contact#quote">Schedule a free estimate<\/a><\/div>/);
    expect(head(loadFixture("plumber-austin"))).not.toContain("head-cta");
  });

  it("keeps the header the same as on every other page: no extra phone button on phones", () => {
    const headers = site(loadFixture("plumber-austin")).pages.map((p) => element(p.html, "<header").replace(/ aria-current="page"/g, ""));
    expect(new Set(headers).size).toBe(1);
  });
});

describe("Modern: About (A16)", () => {
  const photoOf = (input: SiteDocumentInput) => imageSources(element(pageOf(input, "about"), '<section id="about"'));
  const plumber = loadFixture("plumber-austin");

  it("shows a photo Home does not: the gallery's first, else the hero photo, else none", () => {
    expect(photoOf(plumber)).toEqual([plumber.facts.photos?.[0]?.url]);
    expect(photoOf(withHidden(plumber, ["gallery"]))).toEqual([plumber.facts.heroPhoto?.url]);
    expect(photoOf(withFacts(withoutHeroPhoto(plumber), { photos: [] }))).toEqual([]);
  });

  it("carries the owner's statement under its h1 and the owner's credentials after it, and no buttons of its own (the closing band follows)", () => {
    const about = element(pageOf(plumber, "about"), '<section id="about"');
    expect(about).toContain('<h1 id="about-title" class="display h1">About Reliable Rooter Plumbing</h1>');
    expect(about.indexOf('<p class="about-text')).toBeLessThan(about.indexOf('<ul class="facts">'));
    expect(credentialsIn(about, '<ul class="facts"')).toEqual(["License M-40123", "Insured", "Since 1998", "Free estimates"]);
    expect(about).not.toContain("<a ");
    expect(element(pageOf(withHidden(plumber, ["trust"]), "about"), '<section id="about"')).not.toContain('class="facts"');
  });

  it("without a photo, the credentials take the photo's place beside the statement", () => {
    const wrap = (input: SiteDocumentInput) => /<section id="about"[^>]*>[^]*?<div class="(wrap(?! band-in)[^"]*)">/.exec(pageOf(input, "about"))?.[1];
    const noPhotos = withFacts(withoutHeroPhoto(plumber), { photos: [] });
    expect([wrap(plumber), wrap(noPhotos), wrap(withHidden(noPhotos, ["trust"]))]).toEqual(["wrap about--photo", "wrap about--facts", "wrap"]);
  });
});

describe("Modern: the gallery", () => {
  it("lays four photos out as one large beside three from 1024 px (judges' round 3), two and one as before", () => {
    const roofing = loadFixture("roofing-extreme");
    const shots = (count: number) => /<ul class="(shots[^"]*)">/.exec(pageOf(withFacts(roofing, { photos: (roofing.facts.photos ?? []).slice(0, count) }), "gallery"))?.[1];
    expect([1, 2, 3, 4, 5].map(shots)).toEqual(["shots shots--one", "shots shots--two", "shots", "shots shots--two shots--four", "shots"]);
  });
});

describe("Modern: small layout helpers", () => {
  it("groups consecutive days with the same hours", () => {
    const hours = [
      { days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], opens: "07:30", closes: "18:00" },
      { days: ["Saturday"], opens: "08:00", closes: "14:00" },
    ] as const;
    expect(groupedHours(hours.map((h) => ({ ...h, days: [...h.days] })))).toEqual([
      { days: "Monday – Friday", time: "7:30 AM – 6:00 PM" },
      { days: "Saturday", time: "8:00 AM – 2:00 PM" },
      { days: "Sunday", time: "Closed" },
    ]);
  });

  it("takes the most service columns, up to one more than the services: the call-to-action card fills the last row", () => {
    expect([1, 2, 3, 4, 5, 7, 10, 12].map((n) => cardColumns(n, 3))).toEqual([2, 3, 3, 3, 3, 3, 3, 3]);
    expect([1, 2, 3, 5, 8].map((n) => cardColumns(n, 4))).toEqual([2, 3, 4, 4, 4]);
  });

  it("sums up the service area in a few words: one or two places as the section says them, three by name, more as a count", () => {
    const facts = (places: string[]) => SiteDocument.parse({ ...loadFixture("plumber-austin"), facts: { ...loadFixture("plumber-austin").facts, serviceArea: { places } } }).facts;
    expect(areaSummary(facts(["Austin"]))).toBe("Austin, TX");
    expect(areaSummary(facts(["Kyle", "Austin"]))).toBe("Kyle and Austin, TX");
    expect(areaSummary(facts(["Kyle", "Austin", "Buda"]))).toBe("Kyle, Austin and Buda");
    expect(areaSummary(facts(["Austin", "Round Rock", "Kyle", "Buda", "Hutto"]))).toBe("Austin, Round Rock and 3 more");
  });
});

describe("Modern: no page shows the same photo twice (judges' must-fix, per page: moderator ruling (e))", () => {
  it.each([...FIXTURES])("%s", (name) => {
    for (const { html } of site(loadFixture(name)).pages) {
      const sources = imageSources(html);
      expect(new Set(sources).size).toBe(sources.length);
    }
  });
});

describe("Modern: the credentials", () => {
  it("sit inside the hero, under the headline, when the trust section follows the hero", () => {
    const top = hero(fixture("plumber-austin"));
    expect(top.indexOf('<section id="credentials"')).toBeGreaterThan(top.indexOf("</h1>"));
    const text = top.replace(/<[^>]*>/g, "");
    for (const fact of ["License M-40123", "Texas master plumber", "Insured", "Since 1998", "Free estimates"]) expect(text).toContain(fact);
  });

  it("are a band of their own on the brand colour, with a heading, wherever else the owner puts them on Home", () => {
    const page = pageOf(trustLater(loadFixture("hvac-phoenix")), "home");
    expect(hero(page)).not.toContain('id="credentials"');
    const band = element(page, '<section id="credentials"');
    expect(band).toMatch(/^<section id="credentials" class="trust on-brand" aria-labelledby="credentials-title">/);
    expect(band).toContain('<h2 id="credentials-title" class="display h2">Credentials</h2>');
    expect(page.indexOf('<section id="credentials"')).toBeGreaterThan(page.indexOf('<section id="reviews"'));
    // The band is not one of the tint and white sections, which keep alternating around it.
    expect([...page.matchAll(/<section id="([a-z-]+)" class="sec (?:close |teaser-sec )?([a-z]+)"/g)].map((m) => `${m[1]} ${m[2]}`)).toEqual([
      "services-preview tint", "reviews white", "get-in-touch tint",
    ]);
    const text = band.replace(/<[^>]*>/g, "");
    for (const fact of ["License ROC 999001", "License ROC 999002", "Insured", "Since 2011", "24/7 emergency service"]) expect(text).toContain(fact);
  });

  it("in the band, come in three groups that each move to a new row whole: the licenses, insured, then the other facts (round 2 judges)", () => {
    const groups = (page: string) =>
      [...element(element(page, '<section id="credentials"'), '<div class="creds"').matchAll(/<ul>([\s\S]*?)<\/ul>/g)].map((m) => [...(m[1] ?? "").matchAll(/<strong>([\s\S]*?)<\/strong>/g)].map((s) => (s[1] ?? "").replace(/<[^>]*>/g, "")));
    const hvac = trustLater(loadFixture("hvac-phoenix"));
    expect(groups(modern(hvac))).toEqual([["License ROC 999001", "License ROC 999002"], ["Insured"], ["Since 2011", "24/7 emergency service"]]);
    // An empty group leaves no empty list.
    expect(groups(modern(withFacts(hvac, { insured: false })))).toEqual([["License ROC 999001", "License ROC 999002"], ["Since 2011", "24/7 emergency service"]]);
    expect(groups(modern(withFacts(hvac, { yearFounded: undefined })))).toEqual([["License ROC 999001", "License ROC 999002"], ["Insured"], ["24/7 emergency service"]]);
    // Insurance alone (copy that claims nothing else, so the schema accepts the other facts off).
    const plumber = trustLater(loadFixture("plumber-austin"));
    const later: SiteDocumentInput = { ...plumber, copy: { ...plumber.copy, ctaText: "Get a quote", heroSubheadline: "Clear prices and tidy work, start to finish.", faq: [] } };
    expect(groups(modern(withFacts(later, { yearFounded: undefined, freeEstimates: false, emergency247: false, licences: [] })))).toEqual([["Insured"]]);
  });

  it("when they come later, the hero still names the licenses and insurance in one short line", () => {
    const top = hero(modern(trustLater(loadFixture("hvac-phoenix"))));
    const line = element(top, '<ul class="proof-line"').replace(/<[^>]*>/g, "");
    expect(line).toBe("License ROC 999001License ROC 999002Insured");
    expect(top).not.toContain("Since 2011");
  });

  it("leave the hero when the owner hides them, wherever the layout puts them", () => {
    for (const input of [loadFixture("plumber-austin"), trustLater(loadFixture("hvac-phoenix"))]) {
      const top = hero(modern(withHidden(input, ["trust"])));
      expect(top).not.toContain("Insured");
      expect(top).not.toContain("License");
    }
  });

  it("on phones, two licenses or a long one take whole rows, so the licenses sit together, first", () => {
    const rows = (page: string) => [...hero(page).matchAll(/<li class="cred( wide)?">/g)].map((m) => m[1] === undefined ? "half" : "whole");
    expect(rows(fixture("plumber-austin"))).toEqual(["half", "half", "half", "half"]);
    const plumber = loadFixture("plumber-austin");
    const two = withFacts(plumber, { licences: [...(plumber.facts.licences ?? []), { label: "Texas backflow tester", number: "BPAT-0081122" }] });
    expect(rows(modern(two))).toEqual(["whole", "whole", "half", "half", "half"]);
    const long = withFacts(plumber, { licences: [{ label: "Texas master plumber", number: "M-40123-2026-AUSTIN" }] });
    expect(rows(modern(long))).toEqual(["whole", "half", "half", "half"]);
    // ...and those heroes take the shorter photo strip on short phones (styles/sheets/modern.css); two short
    // licenses count too
    const twoShort = withFacts(plumber, { licences: [{ label: "Texas master plumber", number: "M-1" }, { label: "Backflow", number: "B-2" }] });
    expect([fixture("plumber-austin"), modern(two), modern(long), modern(twoShort)].map((page) => hero(page).includes("hero--dense"))).toEqual([false, true, true, true]);
  });

  it("show two licenses in the hero and link to the footer, which lists them all, with a label that says so and a down arrow", () => {
    const page = pageOf(trustFirst(loadFixture("roofing-extreme")), "home");
    const top = hero(page);
    expect(top.match(/License RCAT/g)).toHaveLength(2);
    expect(top).toMatch(/<a href="#licenses">See all 5 licenses<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path [^>]*d="M12 5l0 14M18 13l-6 6M6 13l6 6"\/><\/svg><\/a>/);
    const footer = element(page, "<footer");
    expect(footer).toContain('id="licenses"');
    expect(footer.match(/License RCAT/g)).toHaveLength(5);
  });

  it("each carry their own icon: a certificate, a shield, a calendar for the year and a circled check for free estimates", () => {
    const items = [...hero(fixture("plumber-austin")).matchAll(/<li class="cred[^"]*"><svg[^>]*>([\s\S]*?)<\/svg><span><strong>([^<]*)/g)].map((m) => [m[2], m[1]]);
    expect(items.map(([text]) => text)).toEqual(["License ", "Insured", "Since 1998", "Free estimates"]);
    const icons = items.map(([, svg]) => svg);
    expect(new Set(icons).size).toBe(4);
    expect(icons[2]).toContain("M16 3v4M8 3v4M4 11h16");
    expect(icons[3]).toContain('d="m9 12l2 2l4-4"');
  });

  it("keep a license number of up to 20 characters in one piece, and let a longer one break anywhere", () => {
    expect(fixture("plumber-austin")).toContain('License <span class="whitespace-nowrap">M-40123</span>');
    expect(element(fixture("plumber-austin"), "<footer")).toContain('License <span class="whitespace-nowrap">M-40123</span>');
    expect(fixture("hvac-phoenix")).toContain('License <span class="whitespace-nowrap">ROC 999001</span>');
    expect(fixture("roofing-extreme")).not.toContain('<span class="whitespace-nowrap">RCAT');
  });

  it("never leave the hero's credentials empty: 24/7 service stands in when it is the owner's only trust fact", () => {
    const plumber = loadFixture("plumber-austin");
    const only247 = withFacts(
      { ...plumber, copy: { ...plumber.copy, ctaText: "Get a quote", heroSubheadline: "Clear prices and tidy work, start to finish.", faq: [] } },
      { licences: [], insured: false, yearFounded: undefined, freeEstimates: false, emergency247: true },
    );
    const list = element(hero(modern(only247)), '<ul class="proof-list"');
    expect(list).toContain("24/7 emergency service");
    expect(problems(only247)).toEqual([]);
  });
});

// review1 I-1: Modern writes its own credential words (the hero, the trust band and the footer), so each one must
// leave the page when its fact is off, and nothing it says may pass the shared honesty rule unbacked.
describe("Modern: each credential shows only with its owner fact", () => {
  const OFF: ReadonlyArray<readonly [string, Partial<SiteDocumentInput["facts"]>, RegExp]> = [
    ["not insured", { insured: false }, /Insured/],
    ["no founding year", { yearFounded: undefined }, /\bSince\b/],
    ["no free estimates", { freeEstimates: false }, /Free estimates/],
    ["no 24/7 service", { emergency247: false }, /24\/7/],
    ["no license", { licences: [] }, /License\b/],
  ];
  const PLACES = [
    ["in the hero (trust follows the hero)", "plumber-austin"],
    ["in the band and the hero's line (trust after the reviews)", "hvac-later"],
    ["on a page without a hero photo", "no-photo"],
  ] as const;
  const input = (name: string) =>
    name === "no-photo" ? withoutHeroPhoto(loadFixture("plumber-austin")) : name === "hvac-later" ? trustLater(loadFixture("hvac-phoenix")) : loadFixture(name as FixtureName);
  // Copy that claims nothing, so the schema accepts every fact turned off (it refuses copy the facts do not back).
  const neutral = (doc: SiteDocumentInput): SiteDocumentInput => ({
    ...doc,
    copy: { ...doc.copy, ctaText: "Get a quote", heroSubheadline: "Clear prices and tidy work, start to finish.", faq: [] },
  });

  it.each(PLACES.flatMap(([where, name]) => OFF.map(([fact, facts, words]) => [where, fact, name, facts, words] as const)))(
    "%s: %s",
    (_where, _fact, name, facts, words) => {
      const doc = withFacts(neutral(input(name)), facts);
      // The owner's own words (reviews, FAQ answers) never hold these exact forms in the fixtures; the page's one
      // comment (the licence attribution, "MIT License") is not page text.
      expect(modern(doc).replaceAll(DESIGNS.modern.attribution, "")).not.toMatch(words);
      expect(problems(doc)).toEqual([]);
    },
  );

  it("with every fact on, each credential shows (so the checks above see the real thing)", () => {
    for (const [, name] of PLACES) {
      const page = modern(withFacts(input(name), { insured: true, yearFounded: 1998, freeEstimates: true, emergency247: true }));
      for (const [, , words] of OFF) expect(page).toMatch(words);
    }
  });
});

describe("Modern: a hero without a photo", () => {
  const noPhoto = withoutHeroPhoto(loadFixture("plumber-austin"));

  it("shows the opening hours in its card", () => {
    const page = modern(noPhoto);
    expect(hero(page)).toContain("Office hours");
    expect(hero(page).replace(/<[^>]*>/g, "")).toContain("7:30 AM – 6:00 PM");
  });

  it("shows no hours when the owner hides the service area section", () => {
    expect(hero(modern(withHidden(noPhoto, ["serviceArea"])))).not.toContain("7:30 AM");
  });

  it("with a photo, the hours stay in the service area section", () => {
    const page = fixture("plumber-austin");
    expect(hero(page)).not.toContain("7:30 AM");
    expect(element(page, '<section id="service-area"')).toContain("Service area &amp; hours");
  });

  it("without hours, its card says where the business works and how to write to it (judges' must-fix)", () => {
    const top = hero(fixture("cleaning-minimal"));
    const card = element(top, '<div class="door door--reach"').replace(/<[^>]*>/g, "");
    expect(card).toBe("Service areaBoise, IDEmailhi@mop.example.com");
    expect(top).toContain('href="mailto:hi@mop.example.com"');
    // The owner hid the service area: the card keeps the email only.
    expect(element(hero(modern(withHidden(loadFixture("cleaning-minimal"), ["serviceArea"]))), '<div class="door door--reach"').replace(/<[^>]*>/g, "")).toBe("Emailhi@mop.example.com");
    // A photo hero has no card; a no-photo hero with hours shows the hours instead, on every screen (not door--reach,
    // which shows beside the headline from 1024 px only: test/designs/modern/layout.test.ts).
    expect(hero(fixture("plumber-austin"))).not.toContain('class="door');
    expect(hero(modern(noPhoto))).not.toContain("hi@");
    expect(hero(modern(noPhoto))).toContain('<div class="door">');
  });

  it("a service area of one or two places is a slim band, not a full section", () => {
    expect(fixture("cleaning-minimal")).toContain('<section id="service-area" class="sec slim white"');
    expect(fixture("plumber-austin")).not.toContain("slim");
  });
});

describe("Modern: services are priced cards", () => {
  it("say 'Price on request' only where another service has a price, always under the service's name", () => {
    const services = pageOf(loadFixture("plumber-austin"), "services");
    expect(services.match(/<\/h2><p class="price price--ask">Price on request<\/p>/g)).toHaveLength(2);
    expect(services.match(/<\/h2><p class="price"><small>From<\/small>/g)).toHaveLength(3);
    expect(fixture("cleaning-minimal")).not.toContain("Price on request");
    expect(fixture("cleaning-minimal")).toContain("Ask us for a price.");
  });

  it("end with the call-to-action card, which fills the grid's last row (judges' must-fix: no empty cell)", () => {
    const services = element(fixture("plumber-austin"), '<section id="services"');
    expect(services).toContain('class="cards cards--c3"');
    const cards = element(services, '<ul class="cards');
    expect(cards).toMatch(/<li class="card ask on-brand"><div><p class="ask-q">Not sure which service you need\?<\/p><p>Tell us about the job\.<\/p><\/div><a class="button button-act" href="\/contact#quote">Get a free quote<\/a><\/li>\n<\/ul>$/);
    expect(services.split('href="/contact#quote"')).toHaveLength(2);
    expect(fixture("hvac-phoenix")).toContain('class="cards cards--c4 cards--compact"');
    expect(fixture("cleaning-minimal")).toContain('class="cards cards--c3"');
  });
});

// review1 M3: owner content that only the goldens used to pin.
describe("Modern: shows the owner's content where a visitor looks for it", () => {
  const facts = loadFixture("plumber-austin").facts;
  const page = fixture("plumber-austin");

  it("every photo's alt text and caption, every reviewer's name and town, the email in full", () => {
    for (const photo of facts.photos ?? []) {
      expect(page).toContain(`alt="${photo.alt}"`);
      if (photo.caption !== undefined) expect(page).toContain(`<figcaption>${photo.caption}</figcaption>`);
    }
    for (const review of facts.testimonials ?? []) {
      expect(page).toContain(`<strong>${review.name}</strong>`);
      if (review.location !== undefined) expect(page).toContain(`<span>${review.location}</span>`);
    }
    const shown = (markup: string) => markup.replace(/<wbr>/g, "");
    expect(shown(element(page, '<div class="call-card"'))).toContain(`>${facts.email}</a>`);
    expect(shown(element(page, "<footer"))).toContain(`>${facts.email}</a>`);
    expect(element(page, "<footer")).toContain("<li>Insured</li>");
  });


  it("one or two places name the home town with its state", () => {
    expect(element(fixture("cleaning-minimal"), '<section id="service-area"')).toContain("Serving <strong>Boise, ID</strong>");
  });
});

describe("Modern: small pieces the judges and the text-spacing check asked for", () => {
  it("the office address carries the building icon", () => {
    const addr = element(element(fixture("plumber-austin"), '<section id="service-area"'), '<div class="addr"');
    expect(addr).toMatch(/^<div class="addr"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path [^>]*d="M3 21l18 0M9 8l1 0/);
    expect(addr).toContain("<address>4100 S Congress Ave<br>Austin, TX 78745</address>");
  });

  it("the footer ends on a closing row with a copyright line in the business's name (no year: the renderer has no clock) and a way back to the top", () => {
    const footer = element(fixture("plumber-austin"), "<footer");
    expect(footer).toMatch(/<div class="wrap"><div class="foot-end"><p>© Reliable Rooter Plumbing<\/p><a href="#">Back to top<\/a><\/div><\/div>\n<\/footer>$/);
  });

  it("each time in the hours keeps its own words together, so a squeezed column wraps only after the dash", () => {
    expect(fixture("plumber-austin")).toContain('<td class="time"><span class="whitespace-nowrap">7:30 AM –</span> <span class="whitespace-nowrap">6:00 PM</span></td>');
    expect(fixture("plumber-austin")).toContain('<td class="time closed">Closed</td>');
  });

  it("the call card's number may wrap at its space, never inside a part", () => {
    const card = element(fixture("plumber-austin"), '<div class="call-card"');
    expect(card).toContain('<a class="big whitespace-nowrap" href="tel:+15125550142">');
    expect(card).toContain('<span class="whitespace-nowrap">(512)</span> <span class="whitespace-nowrap">555-0142</span>');
  });
});

describe("Modern: the page's custom properties", () => {
  it("carry Modern's own colours for every palette and a distinct display face for every lettering", () => {
    for (const palette of PALETTE_IDS) {
      for (const font of FONT_IDS) {
        const variables = modernVariables({ palette, font });
        expect(variables["--aw-modern-brand"]).toBe(MODERN_COLORS[palette].brand);
        expect(variables["--aw-modern-display"]).toBe(MODERN_FONTS[font].display);
      }
    }
    expect(new Set(FONT_IDS.map((font) => MODERN_FONTS[font].display)).size).toBe(FONT_IDS.length);
  });

  it("use system fonts only", () => {
    for (const font of FONT_IDS) expect(JSON.stringify(MODERN_FONTS[font])).not.toMatch(/url\(|https?:|@import|@font-face/);
  });
});

describe("Modern: non-text contrast (WCAG 1.4.11, 3:1)", () => {
  const WHITE = "#FFFFFF";
  it.each(PALETTE_IDS)("%s: icons, field borders, focus rings and the open FAQ key", (palette) => {
    const c = MODERN_COLORS[palette];
    const pairs: Array<[string, string, string]> = [
      ["field border on white", c.field, WHITE],
      ["FAQ key border on the tint", c.field, c.tint],
      ["icons and focus ring on white", c.brand, WHITE],
      ["icons and focus ring on the tint", c.brand, c.tint],
      ["icon on the Emergencies note", c.brand, c.well],
      ["icons on the brand band", c.bandAccent, c.brand],
      ["focus ring and the open FAQ key's bars on the brand colour", WHITE, c.brand],
    ];
    for (const [label, fg, bg] of pairs) expect(contrastRatio(hexToRgb(fg), hexToRgb(bg)), label).toBeGreaterThanOrEqual(AA_LARGE_TEXT);
  });
});
