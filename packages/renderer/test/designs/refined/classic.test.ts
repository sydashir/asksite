import { readFileSync } from "node:fs";
import { FONT_IDS, PAGES, PALETTE_IDS, SiteDocument, Theme, type PageId, type SiteDocumentInput } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { inDesign, loadFixture, stubStylesheets } from "../../../../../fixtures/index.ts";
import { BASELINE } from "../../../src/baseline.ts";
import { contrastRatio, hexToRgb } from "../../../src/contrast.ts";
import { escapeText } from "../../../src/escape.ts";
import { placeColumns } from "../../../src/designs/refined/area.ts";
import { DESIGNS } from "../../../src/designs/index.ts";
import { contactHeading } from "../../../src/contact-heading.ts";
import { groupedHours } from "../../../src/designs/refined/parts.ts";
import { heroQuoteIndex } from "../../../src/designs/refined/plan.ts";
import { PALETTES, variables } from "../../../src/designs/refined/tokens.ts";
import { render, renderDocument } from "../../../src/render.ts";
import { loadCompiledCss } from "../../support/css-classes.ts";
import { invariantProblems } from "../../support/design-invariants.ts";
import { countInText, squash, squashedText } from "../../support/page-text.ts";
import { classicPage, classicPages, classicSite, options } from "./site.ts";

const OPTIONS = options(stubStylesheets());
/** Every page of the site, one after another: each section is on one page, and site-wide text is checked over all. */
const page = (input: SiteDocumentInput) => classicPages(input, OPTIONS.stylesheets);
const plumber = loadFixture("plumber-austin");
const hvac = loadFixture("hvac-phoenix");
const cleaning = loadFixture("cleaning-minimal");
const text = (html: string) => squashedText(html.slice(html.indexOf("<body")));
/** The markup of the section with this element id ("" when the page leaves it out). */
const section = (html: string, id: string) => {
  const start = html.indexOf(`<section id="${id}"`);
  return start === -1 ? "" : html.slice(start, html.indexOf("</section>", start));
};

describe("Classic non-text contrast (WCAG 1.4.11 and the look)", () => {
  // [foreground, background, minimum, what it is]
  const NON_TEXT = [
    ["ink", "paper", 3, "focus ring on a light band"],
    ["ink", "surface", 3, "focus ring on a card or the form"],
    ["onDark", "dark", 3, "focus ring on the dark band"],
    ["onDark", "dark2", 3, "focus ring in the footer"],
    ["field", "surface", 3, "form field border"],
    ["rule", "paper", 2, "price-list leader (decorative, must stay visible)"],
    ["rule", "surface", 2, "price-list leader (decorative, must stay visible)"],
    ["accent", "paper", 2.4, "frame lines and diamonds (decorative)"],
    ["accent", "surface", 2.4, "frame lines and diamonds (decorative)"],
    ["action", "dark", 1.8, "the action colour stands apart from the dark band"],
    ["action", "brand", 1.4, "the action colour stands apart from the brand colour"],
  ] as const;
  describe.each(PALETTE_IDS)("%s", (id) => {
    it.each(NON_TEXT)("%s on %s reaches %s:1 (%s)", (fg, bg, min) => {
      expect(contrastRatio(hexToRgb(PALETTES[id][fg]), hexToRgb(PALETTES[id][bg]))).toBeGreaterThanOrEqual(min);
    });
  });
});

describe("Classic tokens", () => {
  const sheet = readFileSync(new URL("../../../styles/sheets/refined.css", import.meta.url), "utf8");
  const read = new Set([...sheet.matchAll(/var\((--aw-refined-[a-z0-9-]+)/g)].map((m) => m[1] ?? ""));

  it.each(PALETTE_IDS.flatMap((palette) => FONT_IDS.map((font) => [palette, font] as const)))(
    "%s with %s lettering sets every property the sheet reads, and nothing it does not",
    (palette, font) => {
      const set = Object.keys(variables(Theme.parse({ palette, font, design: "refined" })));
      expect([...read].filter((name) => !set.includes(name))).toEqual([]);
      expect(set.filter((name) => !read.has(name) && !["--aw-refined-head", "--aw-refined-body"].includes(name))).toEqual([]);
    },
  );

  it("each lettering choice has its own heading face", () => {
    const heads = FONT_IDS.map((font) => variables(Theme.parse({ palette: "navy-orange", font, design: "refined" }))["--aw-refined-head"]);
    expect(new Set(heads).size).toBe(FONT_IDS.length);
  });
});

describe("Classic's compiled sheet", () => {
  // The header row centres the name's box, and text-box trims that box to the capitals and the baseline, so the row
  // centres the letters in any face. The browser check (cascade) sees a lost trim only where a face's line box sets
  // the capitals more than 1 px off (Sturdy's Mac face), so this reads the compiled sheet itself, in every environment.
  it("trims the header name's box to its capitals and baseline, unlayered at every width, and no other .brand rule sets it", () => {
    const css = loadCompiledCss("refined");
    const found: string[] = [];
    for (const rule of css.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
      const [, prelude = "", body = ""] = rule;
      if (!prelude.split(",").some((selector) => /(^|[\s>+~])\.brand$/.test(selector.trim()))) continue;
      let depth = 0;
      for (const ch of css.slice(0, rule.index)) depth += ch === "{" ? 1 : ch === "}" ? -1 : 0;
      for (const declaration of body.split(";").map((d) => d.trim()))
        if (/^text-box(-trim|-edge)?:/.test(declaration)) found.push(`${depth === 0 ? "" : "nested: "}${prelude.trim()}{${declaration}}`);
    }
    expect(found).toEqual([".brand{text-box:cap alphabetic}"]);
  });
});

describe("Classic layout rules", () => {
  it("balances the town columns so no column ends with one town alone", () => {
    expect([1, 2, 3, 6, 7, 30].map((n) => placeColumns(n, 3))).toEqual([1, 2, 3, 3, 2, 3]);
    expect([1, 2, 3, 7].map((n) => placeColumns(n, 2))).toEqual([1, 2, 1, 2]);
  });

  it("groups days that share hours", () => {
    const { hours } = loadFixture("hvac-phoenix").facts;
    expect(groupedHours(hours ?? [])).toEqual([
      { label: "Monday – Friday", time: "7:00 AM – 7:00 PM" },
      { label: "Saturday & Sunday", time: "Open 24 hours" },
    ]);
  });

  it("puts one short review in the hero only while the Reviews section keeps another", () => {
    const review = (quote: string, location?: string) => ({ quote, name: "Pat", ...(location ? { location } : {}) });
    expect(heroQuoteIndex([])).toBe(-1);
    expect(heroQuoteIndex([review("Great work.", "Austin, TX")])).toBe(-1);
    expect(heroQuoteIndex([review("Lead review."), review("Short, with a town.", "Austin, TX")])).toBe(1);
    expect(heroQuoteIndex([review("x".repeat(161)), review("y".repeat(161))])).toBe(-1);
  });
});

describe("Classic pages", () => {
  it("shows every review exactly once", () => {
    for (const name of ["plumber-austin", "hvac-phoenix", "roofing-extreme"] as const) {
      const quotes = [...page(loadFixture(name)).matchAll(/<blockquote><p>([\s\S]*?)<\/p><\/blockquote>/g)].map((m) => m[1]);
      const reviews = (loadFixture(name).facts.testimonials ?? []).map((t) => escapeText(t.quote));
      expect(quotes.toSorted(), name).toEqual(reviews.toSorted());
    }
  });

  it("shows no hours and no towns once the owner hides the Service area section", () => {
    const hvac = loadFixture("hvac-phoenix");
    const shown = text(page(hvac));
    const hidden = text(page({ ...hvac, hidden: ["serviceArea"] }));
    expect(shown).toContain(squashedText("Open 24 hours"));
    expect(shown).toContain("Serving");
    expect(hidden).not.toContain(squashedText("Open 24 hours"));
    expect(hidden).not.toContain("Serving");
    expect(hidden).not.toContain(squashedText("Regular hours"));
  });

  it("keeps license lines out of every page's main content once the owner hides the Credentials section", () => {
    for (const { html } of render(inDesign({ ...loadFixture("hvac-phoenix"), hidden: ["trust"] }, "refined"), OPTIONS).pages) {
      expect(html.slice(html.indexOf("<main"), html.indexOf("</main>"))).not.toContain("ROC 999001");
      expect(html.slice(html.indexOf("<footer"))).toContain("ROC 999001");
    }
  });

  it("offers free estimates only with the owner's fact", () => {
    expect(hvac.facts.freeEstimates).not.toBe(true);
    expect(text(page(plumber))).toContain(squashedText("Free estimates"));
    expect(text(page(hvac))).not.toMatch(/free/i);
  });

  it("says nothing about a founded year the owner did not give", () => {
    const { yearFounded: _year, ...facts } = hvac.facts;
    const shown = text(page({ ...hvac, facts }));
    expect(shown).not.toContain("undefined");
    expect(shown).not.toMatch(/\bsince\b/i);
  });

  it("shows no review anywhere, the hero included, once the owner hides the Reviews section", () => {
    const shown = page({ ...hvac, hidden: ["testimonials"] });
    for (const review of hvac.facts.testimonials ?? []) expect(shown).not.toContain(escapeText(review.quote));
  });
});

// Classic writes "Insured" (credentials, hero ledger and proof line, contact band, footer), "24/7 emergency service"
// and "Free estimates" itself, so each must follow the owner's fact (review1 I-1). The owner's own words here hold none
// of these claims, so any the page states is Classic's own, and the shared honesty rule compares it with today's page.
describe("Classic states no credential the owner does not have", () => {
  const off = { insured: false, emergency247: false, freeEstimates: false };
  const DOCS: ReadonlyArray<readonly [string, SiteDocumentInput]> = [
    [
      "plumber-austin",
      {
        ...plumber,
        facts: { ...plumber.facts, ...off },
        copy: { ...plumber.copy, ctaText: "Request a quote", heroSubheadline: "Drains, pipes and water heaters across the Austin area.", faq: (plumber.copy.faq ?? []).slice(2, 3) },
      },
    ],
    ["hvac-phoenix", { ...hvac, facts: { ...hvac.facts, ...off }, copy: { ...hvac.copy, faq: [] } }],
  ];

  it.each(DOCS)("%s without Insured, 24/7 service or free estimates", (_, input) => {
    const doc = SiteDocument.parse(inDesign(input, "refined"));
    const shown = render(doc, OPTIONS);
    expect(invariantProblems(shown, renderDocument(doc, BASELINE, OPTIONS), doc, DESIGNS.refined)).toEqual([]);
    // squashedText drops the spaces, so the words are matched without word edges.
    expect(shown.pages.map((p) => text(p.html)).join(" ")).not.toMatch(/insured|24\/7|emergency|free/i);
  });
});

// The approved mockup folds away a Service area section that would only repeat the hero (one town, no area note, no
// hours to show). The shared contract keeps the section and its menu link (A12 §7), so Classic draws it as one line.
describe("a one-town owner's Service area", () => {
  it("is one short line that names the town once, and no booking box sits between the price list and the closing band", () => {
    const html = page(cleaning);
    const area = section(html, "service-area");
    expect(area).not.toBe("");
    expect(area).not.toContain('class="area"');
    expect(squashedText(area).match(/Boise/g)).toHaveLength(1);
    expect(squashedText(section(html, "services"))).not.toContain(squashedText("Ready to book?"));
    // From 60rem the band lists the same line under the email, beside the form, and the section steps aside (sheet): one
    // line at each width.
    const band = section(html, "contact");
    const email = band.indexOf('href="mailto:');
    expect(band.slice(email, band.indexOf("</ul>", email))).toMatch(/<li class="c-sub">.*Serving Boise, ID/);
    expect(countInText(band, "Serving Boise")).toBe(1);
  });

  it("keeps the shared invariants in each one-line form (the town is the base, another town, a street address)", () => {
    const forms: Array<Partial<SiteDocumentInput["facts"]>> = [
      {},
      { serviceArea: { places: ["Meridian"] } },
      { serviceArea: { places: ["Meridian"] }, location: { streetAddress: "210 W Main St", city: "Boise", state: "ID", postalCode: "83702" } },
    ];
    for (const facts of forms) {
      const doc = SiteDocument.parse(inDesign({ ...cleaning, facts: { ...cleaning.facts, ...facts } }, "refined"));
      const shown = render(doc, OPTIONS);
      expect(section(shown.pages.map((p) => p.html).join("\n"), "service-area"), JSON.stringify(facts)).not.toContain('class="area"');
      expect(invariantProblems(shown, renderDocument(doc, BASELINE, OPTIONS), doc, DESIGNS.refined), JSON.stringify(facts)).toEqual([]);
    }
  });

  it("names the owner's base too when it is not the town served, and a street address without repeating the town", () => {
    const area = squashedText(section(page({ ...cleaning, facts: { ...cleaning.facts, serviceArea: { places: ["Meridian"] } } }), "service-area"));
    expect(area).toContain(squashedText("Serving Meridian"));
    expect(area).toContain(squashedText("Based in Boise, ID"));
    const location = { streetAddress: "210 W Main St", city: "Boise", state: "ID", postalCode: "83702" };
    const home = squashedText(section(page({ ...cleaning, facts: { ...cleaning.facts, location } }), "service-area"));
    expect(home).toContain(squashedText("Serving Boise, ID"));
    expect(home).toContain(squashedText("210 W Main St"));
    expect(home.match(/Boise/g)).toHaveLength(1);
  });

  it("keeps the full section, hours included, for two towns, an area note or any hours (Home's business card is on another page)", () => {
    const withFacts = (facts: Partial<SiteDocumentInput["facts"]>): SiteDocumentInput => ({ ...cleaning, facts: { ...cleaning.facts, ...facts } });
    const hours = [{ days: ["Monday" as const], opens: "08:00", closes: "17:00" }];
    const photo = { url: "https://media.example.com/a.webp", width: 1600, height: 900, alt: "A clean kitchen" };
    for (const facts of [{ serviceArea: { places: ["Boise", "Meridian"] } }, { serviceArea: { places: ["Boise"], note: "All of Ada County" } }, { hours, heroPhoto: photo }]) {
      expect(section(page(withFacts(facts)), "service-area"), JSON.stringify(facts)).toContain('class="area"');
    }
    // Home's business card lists the hours too, but on Home: the Contact page shows them in the Service area section.
    const contact = section(classicPage(withFacts({ hours }), "contact", OPTIONS.stylesheets), "service-area");
    expect(contact).toContain('class="area"');
    expect(contact).toContain('<dl class="hours">');
    expect(section(page(plumber), "service-area")).toContain('class="area"');
  });
});

// A16: Home previews the first services; every page but Contact ends with the closing band; the call bar has a fixed
// quote label on every page and stays put on Contact; each inner page opens with the hero's eyebrow and its <h1>; the
// footer leads to every page; About, Services and Contact keep their identity and the owner's proof in any order.
describe("Classic's pages (A16)", () => {
  const pageOf = (input: SiteDocumentInput, id: PageId) => classicPage(input, id, OPTIONS.stylesheets);
  const preview = (input: SiteDocumentInput) => section(pageOf(input, "home"), "services-preview");
  const withServices = (services: SiteDocumentInput["facts"]["services"]): SiteDocumentInput => ({
    ...plumber,
    facts: { ...plumber.facts, services },
    copy: { ...plumber.copy, serviceDescriptions: services.map((s) => ({ service: s.name, description: "Done with care." })) },
  });
  const rows = (markup: string) => [...markup.matchAll(/<li class="svc">([\s\S]*?)<\/li>/g)].map((m) => squashedText(m[1] ?? ""));
  const moved = (input: SiteDocumentInput, id: string, after: string): SiteDocumentInput => {
    const rest = input.layout.filter((s) => s.id !== id);
    const at = rest.findIndex((s) => s.id === after) + 1;
    return { ...input, layout: [...rest.slice(0, at), ...input.layout.filter((s) => s.id === id), ...rest.slice(at)] };
  };
  const h1 = (html: string) => squashedText(html.slice(html.indexOf("<h1"), html.indexOf("</h1>")));

  // Moderator ruling (a): a service without a price shows its name only in the preview; A16 2.3: one link, "More about
  // our services", whatever the count.
  it("previews the first three services under the owner's intro, a price only where the owner gave one, and links to the Services page", () => {
    const roofing = loadFixture("roofing-extreme");
    expect(rows(preview(roofing))).toEqual(roofing.facts.services.slice(0, 3).map((s) => squashedText(`${escapeText(s.name)}From $${s.startingPrice?.toLocaleString("en-US")}`)));
    expect(preview(roofing)).toContain('<a class="bt bt-out" href="/services">More about our services</a>');
    const two = preview(withServices([{ name: "Deep clean", startingPrice: 180 }, { name: "Move-out clean" }]));
    expect(rows(two)).toEqual([squashedText("Deep cleanFrom $180"), squashedText("Move-out clean")]);
    expect(two).not.toContain("Price on request");
    expect(rows(preview(withServices([{ name: "Deep clean" }])))).toEqual([squashedText("Deep clean")]);
    expect(two).toContain('<a class="bt bt-out" href="/services">More about our services</a>');
    expect(squashedText(preview(plumber))).toContain(squashedText(plumber.copy.sectionIntros?.services ?? "missing"));
  });

  it("offers the light booking box after the price list only when another section, not the closing band, comes next", () => {
    expect(section(pageOf(plumber, "services"), "services")).toContain('class="svc-more"');
    expect(section(pageOf({ ...plumber, hidden: ["faq"] }, "services"), "services")).not.toContain('class="svc-more"');
    expect(section(pageOf(cleaning, "services"), "services")).not.toContain('class="svc-more"');
  });

  // Moderator rulings (2026-10-02 16:47, 16:48; WCAG 3.2.4): every quote button that leads to the form, the header's,
  // the hero's, the closing band's and the in-page ones, keeps the owner's call to action word for word, one word or
  // more; the call bar's fixed "Get a quote" is the one exception.
  it("labels every quote button on every page with the owner's call to action, word for word, the call bar's 'Get a quote' apart", () => {
    const labels = (input: SiteDocumentInput) =>
      classicSite(input, OPTIONS.stylesheets).pages.flatMap(({ page: id, html }) => {
        const outside = html.slice(0, html.indexOf("<aside")) + html.slice(html.indexOf("</aside>"));
        return [...outside.matchAll(/<a [^>]*href="\/contact#quote"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => `${id}: ${m[1]}`);
      });
    for (const input of [plumber, hvac, cleaning, loadFixture("roofing-extreme"), loadFixture("electrical-xss"), moved(plumber, "contact", "serviceArea")]) {
      const found = labels(input);
      const wanted = escapeText(input.copy.ctaText);
      expect(found.filter((label) => label.startsWith("home: ")).length, input.facts.businessName).toBeGreaterThanOrEqual(3); // header, hero, closing band
      expect(found.filter((label) => !label.endsWith(`: ${wanted}`)), input.facts.businessName).toEqual([]);
    }
  });

  it("heads the contact band with the shared contact heading, a one-word call to action lengthened, as the page's h1 or lower down", () => {
    expect(h1(pageOf(cleaning, "contact"))).toBe(squashedText(contactHeading("Book")));
    expect(section(pageOf(moved(cleaning, "contact", "serviceArea"), "contact"), "contact")).toContain('<h2 id="contact-title" class="st">Request a booking</h2>');
    expect(h1(pageOf(plumber, "contact"))).toBe(squashedText("Get a free quote"));
  });

  it("gives every page a call bar with Call and the fixed words Get a quote, sticky but on Contact", () => {
    for (const { page: id, html } of classicSite(plumber, OPTIONS.stylesheets).pages) {
      const bar = html.slice(html.indexOf("<aside"), html.indexOf("</aside>"));
      expect(bar, id).toContain('<a class="bt bt-out" href="/contact#quote">Get a quote</a>');
      expect(bar, id).toContain('href="tel:');
      expect(bar.includes('class="cb sticky'), id).toBe(id !== "contact");
    }
  });

  it("keeps the form beside the facts when the contact band opens /contact, and stacks a thin owner's band lower on the page", () => {
    const band = (input: SiteDocumentInput) => section(pageOf(input, "contact"), "contact");
    for (const input of [hvac, cleaning]) expect(band(input)).toContain('<div class="wr contact">');
    expect(band(moved(cleaning, "contact", "serviceArea"))).toContain('<div class="wr contact c-stack">');
  });

  it("opens each inner page with the eyebrow and the page's h1, and closes every page but Contact with the closing band", () => {
    for (const { page: id, html } of classicSite(plumber, OPTIONS.stylesheets).pages) {
      const first = html.slice(html.indexOf("<main"), html.indexOf("</section>", html.indexOf("<main")));
      // About's seal carries the year (eyebrow test below), so its eyebrow is the trade and the town.
      if (id !== "home") expect(squashedText(first), id).toContain(squash(id === "about" ? "Plumbing Austin, TX About" : "Plumbing Austin, TX Since 1998"));
      expect(first, id).toContain("<h1 ");
      expect(html.includes('<section id="get-in-touch"'), id).toBe(id !== "contact");
    }
  });

  /** The eyebrow's markup in a page's first section. */
  const eyebrowOf = (html: string) => {
    const at = html.indexOf('<p class="eb">');
    return html.slice(at, html.indexOf("</p>", at));
  };

  it("wraps the eyebrow's town and year as one group, and shows the year wherever no seal near it does", () => {
    // The town and the year are one item of the line, itself a line of dots: where the whole line does not fit, the
    // browser moves them on together, so the year is never left alone (sheet-free, so the break is exact in every lettering).
    const group = '<span><span><span class="dots"><span class="dots-r"><span><span>Austin, TX</span></span> <span';
    expect(eyebrowOf(pageOf(plumber, "services"))).toContain(`${group}><span>Since 1998</span></span></span></span></span></span>`);
    // Home's hero: on phones only (the seal shows it from 48rem). About: never, as its seal shows the year at every
    // width, on the owner's photo (under the letter until 60rem, beside it from there) or on the letter's corner.
    expect(eyebrowOf(pageOf(plumber, "home"))).toContain(`${group} class="eb-y"><span>Since 1998</span></span>`);
    expect(squashedText(eyebrowOf(pageOf(plumber, "about")))).toBe(squash("Plumbing Austin, TX"));
    expect(section(pageOf(plumber, "about"), "about")).toMatch(/<div class="hm ab-m">.*<p class="seal">/);
    // Without a photo, About's seal sits on the letter's corner, under the h1: the eyebrow leaves the year out too.
    const { heroPhoto: _photo, ...noPhoto } = plumber.facts;
    const letter = pageOf({ ...plumber, facts: noPhoto }, "about");
    expect(squashedText(eyebrowOf(letter))).toBe(squash("Plumbing Austin, TX"));
    expect(section(letter, "about")).toContain('<p class="seal">');
    // A town too long to share one phone row with the year (in the widest lettering) leaves the year out below the width
    // where they fit, so it is never alone on a line: "Albuquerque, NM · Since 1998" is 28 characters (below 24rem).
    const yearClass = (input: SiteDocumentInput) => /<span class="([^"]*)"><span>Since/.exec(eyebrowOf(pageOf(input, "services")))?.[1];
    const town = (city: string, state: string) => ({ ...plumber, facts: { ...plumber.facts, location: { ...plumber.facts.location, city, state } } });
    expect([yearClass(plumber), yearClass(town("Albuquerque", "NM")), yearClass(town("North Richland Hills", "TX"))]).toEqual([undefined, "eb-g1", "eb-g2"]);
    expect([yearClass(loadFixture("electrical-xss")), yearClass(loadFixture("roofing-extreme"))]).toEqual(["eb-g3", "eb-g4"]);
    expect(/<span class="([^"]*)"><span>Since/.exec(eyebrowOf(pageOf(town("North Richland Hills", "TX"), "home")))?.[1]).toBe("eb-y eb-g2");
    // No year, no group.
    const { yearFounded: _year, ...noYear } = hvac.facts;
    expect(eyebrowOf(pageOf({ ...hvac, facts: noYear }, "services"))).not.toContain('<span class="dots"><span class="dots-r"><span><span>Phoenix');
  });

  it("ends every page but Contact on a closing band built from the owner's facts, in the hero's words", () => {
    const band = (input: SiteDocumentInput, id: PageId = "services") => squashedText(section(pageOf(input, id), "get-in-touch"));
    expect(band(plumber)).toContain(squashedText("Need a plumber in Austin?"));
    expect(band(plumber)).toContain(squashedText(plumber.copy.sectionIntros?.contact ?? "missing"));
    expect(band(plumber)).toContain(squashedText("Monday – Friday 7:30 AM – 6:00 PM"));
    expect(band(plumber)).toContain(squashedText("Serving Austin, Round Rock, Pflugerville and 4 more."));
    expect(band(plumber)).toContain(squashedText("Get a free quote"));
    // The owner's call to action word for word, one word or more, as the hero and the header say it.
    expect(section(pageOf(cleaning, "services"), "get-in-touch")).toContain('href="/contact#quote">Book</a>');
    expect(band(cleaning)).toContain(squashedText("Need a cleaner in Boise?"));
    // Without the owner's own contact line, plain house words that claim nothing (never a bare heading on a phone).
    expect(band(cleaning, "home")).toContain(squashedText("Tell us what you need, or give us a call."));
    // Without the Service area section, no hours and no towns; with it, on every page, Home's business card or not.
    expect(band({ ...plumber, hidden: ["serviceArea"] })).not.toMatch(/Serving|Monday/);
    expect(band(hvac, "home")).toContain(squashedText("Monday – Friday 7:00 AM – 7:00 PM"));
    expect(band(hvac, "home")).toContain("Serving");
    // The number to tap (phones, where the call bar carries the buttons), on every band, the owner's facts or none: the
    // rest after the area code never breaks, so bigger default text wraps it only at that space (moderator, 2026-10-05).
    for (const input of [plumber, hvac, cleaning, { ...plumber, hidden: ["serviceArea" as const] }]) {
      expect(section(pageOf(input, "home"), "get-in-touch")).toMatch(
        /<li class="cl-n">.*<a class="c-ph whitespace-nowrap" href="tel:\+1\d{10}">\(\d{3}\) <span class="whitespace-nowrap">\d{3}-\d{4}<\/span><\/a><\/li>/,
      );
    }
  });

  it("leads from the footer of every page to every page, the current one marked", () => {
    for (const { page: id, html } of classicSite(plumber, OPTIONS.stylesheets).pages) {
      const nav = html.slice(html.indexOf('<nav class="ft-nav" aria-label="Pages">'), html.indexOf("</nav>", html.indexOf('class="ft-nav"')));
      expect([...nav.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1]), id).toEqual(["/", "/services", "/about", "/gallery", "/contact"]);
      expect([...nav.matchAll(/<a href="([^"]*)" aria-current="page">/g)].map((m) => m[1]), id).toEqual([PAGES[id].path]);
    }
  });

  it("puts the owner's proof under the Services page's h1, and opens it as the Services page when the owner puts the questions first", () => {
    const services = squashedText(section(pageOf(plumber, "services"), "services"));
    expect(services).toContain(squashedText("Texas master plumber License M-40123 Insured Free estimates")); // the dots are drawn by the sheet
    expect(squashedText(section(pageOf({ ...plumber, hidden: ["trust"] }, "services"), "services"))).not.toContain("M-40123");
    const faqFirst = pageOf(moved(plumber, "services", "faq"), "services");
    expect(h1(faqFirst)).toBe(squashedText("Our services"));
    expect(squashedText(section(faqFirst, "faq"))).toContain(squashedText("License M-40123"));
    expect(section(faqFirst, "faq")).toContain('<h2 id="faq-title" class="st">Questions &amp; answers</h2>');
    expect(section(faqFirst, "services")).toContain('<h2 id="services-title" class="st">Services &amp; prices</h2>');
  });

  it("gives About the owner's proof, a signed letter, and a drop cap only on a story that opens with a letter", () => {
    const about = pageOf(plumber, "about");
    const main = about.slice(about.indexOf("<main"), about.indexOf("</main>"));
    // The name in the h1 and in the letter's sign-off (the approved r3 letter): the business name, then the trade and
    // the town, between the story and the credentials. Owner facts only.
    expect(main.split(escapeText(plumber.facts.businessName)).length - 1).toBe(2);
    const letter = section(about, "about");
    const at = (needle: string) => letter.indexOf(needle);
    expect(squashedText(/<p class="letter-s">(.*?)<\/p>/.exec(letter)?.[1] ?? "")).toBe(squash("Reliable Rooter Plumbing Plumbing Austin, TX"));
    expect([at('class="letter-b'), at('class="letter-s"'), at('<ul class="ledger')].every((i, n, all) => i > (all[n - 1] ?? -1))).toBe(true);
    expect(squashedText(section(about, "about"))).toContain(squashedText("License M-40123"));
    expect(section(about, "about")).toContain('class="letter-b dc"');
    expect(section(pageOf(loadFixture("electrical-xss"), "about"), "about")).toContain('class="letter-b"');
    expect(section(pageOf({ ...plumber, copy: { ...plumber.copy, about: "I'm the owner, and I fix every leak myself." } }, "about"), "about")).toContain('class="letter-b"');
    // With the owner's hero photo it is framed beside the letter, the seal on it; without one the seal is on the letter.
    expect(section(about, "about")).toContain('<div class="ab ab-ph">');
    const { heroPhoto: _photo, ...noPhoto } = plumber.facts;
    // From 64rem a letter without a photo takes the page's width, its credentials in a column beside the story (sheet).
    expect(section(pageOf({ ...plumber, facts: noPhoto }, "about"), "about")).toContain('<div class="letter letter-sl lt-w">');
    expect(section(pageOf({ ...plumber, facts: noPhoto, hidden: ["trust"] }, "about"), "about")).toContain('<div class="letter letter-sl">');
  });

  it("signs the letter with the name apart from the trade and town in its text, as a screen reader and plain text read it", () => {
    const signOff = /<p class="letter-s">(.*?)<\/p>/.exec(section(pageOf(plumber, "about"), "about"))?.[1] ?? "";
    // The sign-off's text content (tags dropped, whitespace kept): the sheet sets the trade and town on a line of their own,
    // so only the markup keeps them apart from the name in the text.
    expect(signOff.replace(/<[^>]*>/g, "")).toBe("Reliable Rooter Plumbing Plumbing Austin, TX");
  });

  it("gives the address and the towns one home on Contact, and opens an area-first Contact page with Call and the call to action", () => {
    const band = squashedText(section(pageOf(plumber, "contact"), "contact"));
    expect(band).not.toContain(squashedText("4100 S Congress Ave"));
    expect(band).not.toContain("Serving");
    // The proof at every width; beside the form that opens the page, the hours in one line under the number (from 60rem,
    // sheet), never when the Service area section is hidden or comes first.
    const desktopOnly = (input: SiteDocumentInput) => [...section(pageOf(input, "contact"), "contact").matchAll(/<li class="c-sub">(.*?)<\/li>/g)].map((m) => squashedText(m[1]!));
    expect(band).toContain(squashedText("License M-40123 Insured"));
    expect(desktopOnly(plumber)).toEqual([squash("Monday – Friday 7:30 AM – 6:00 PM Saturday 8:00 AM – 2:00 PM")]);
    expect(section(pageOf(plumber, "contact"), "contact")).toMatch(/c-note">24\/7 emergency service<\/span><\/span><\/li>\n<li class="c-sub">/);
    expect(desktopOnly({ ...plumber, hidden: ["serviceArea"] })).toEqual([]);
    expect(desktopOnly(moved(plumber, "contact", "serviceArea"))).toEqual([]);
    expect(squashedText(section(pageOf({ ...plumber, hidden: ["serviceArea"] }, "contact"), "contact"))).toContain(squashedText("4100 S Congress Ave"));
    const areaFirst = pageOf(moved(plumber, "contact", "serviceArea"), "contact");
    const opening = section(areaFirst, "service-area");
    expect(opening.slice(0, opening.indexOf('<div class="area">'))).toMatch(/<div class="pg-a">\n<a class="bt bt-act bt-lg[^"]*" href="tel:\+15125550142">[\s\S]*<a class="bt bt-out bt-lg" href="\/contact#quote">Get a free quote<\/a>/);
    // A page that ends on the dark contact band gets a rule above the footer.
    expect(areaFirst).toContain('<footer class="ft ft-r">');
    expect(pageOf(plumber, "contact")).toContain('<footer class="ft">');
  });

  it("sets the gallery by count, one print per row on phones, and keeps a caption line on every print once any has one", () => {
    const gallery = (count: number, captions = true) => {
      const photos = (plumber.facts.photos ?? []).slice(0, Math.min(count, 6));
      const all = Array.from({ length: count }, (_, i) => ({ ...photos[i % photos.length]!, ...(captions ? {} : { caption: undefined }) }));
      const html = section(pageOf({ ...plumber, facts: { ...plumber.facts, photos: all.map(({ caption, ...p }) => (caption === undefined ? p : { ...p, caption })) } }, "gallery"), "our-work");
      return /<ul class="([^"]*)">/.exec(html)?.[1];
    };
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => gallery(n))).toEqual(["gal g-1 gal-c", "gal gal-c", "gal g-lead gal-c", "gal gal-c", "gal g-5 gal-c", "gal g-lead gal-c", "gal g-wide gal-c", "gal g-3 gal-c"]);
    expect(gallery(4, false)).toBe("gal");
  });
});
