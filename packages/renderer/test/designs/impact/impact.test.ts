import { HIDEABLE_SECTIONS, PAGE_IDS, PALETTE_IDS, SiteDocument, type PageId, type SectionId, type SiteDocumentInput } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { DESIGN_CSS, FIXTURE_FORM_ACTION, FIXTURE_SITE_URL, inDesign, loadFixture, stubStylesheets, type FixtureName } from "../../../../../fixtures/index.ts";
import {
  addressParts,
  brandClass,
  buttonCase,
  capsWidth,
  contactHeading,
  galleryClass,
  groupedHours,
  headlineClass,
  licenceParts,
  pageTitleClass,
  seamClass,
  surfaces,
  yearClass,
  type Band,
} from "../../../src/designs/impact/rules.ts";
import type { RenderContext } from "../../../src/context.ts";
import { contrastRatio, hexToRgb } from "../../../src/contrast.ts";
import { boldPage } from "../../../src/designs/impact/parts.ts";
import { BOLD_COLORS } from "../../../src/designs/impact/tokens.ts";
import { escapeText } from "../../../src/escape.ts";
import { safeUrl } from "../../../src/html.ts";
import { render } from "../../../src/render.ts";
import { sitePages } from "../../../src/visibility.ts";

const NBSP = " ";
const OPTIONS = { stylesheets: stubStylesheets(), formAction: FIXTURE_FORM_ACTION, siteUrl: FIXTURE_SITE_URL };
const pagesOf = (input: SiteDocumentInput) => render(inDesign(input, "impact"), OPTIONS).pages;
/** One page of the Bold site (Home unless another is named); "" when the site has no such page. */
const bold = (input: SiteDocumentInput, page: PageId = "home") => pagesOf(input).find((p) => p.page === page)?.html ?? "";
/** Every page of the Bold site, one after another. */
const site = (input: SiteDocumentInput) => pagesOf(input).map((p) => p.html).join("\n");
const fixture = (name: FixtureName) => loadFixture(name);
const plumber = fixture("plumber-austin");

function withoutPhotos(input: SiteDocumentInput): SiteDocumentInput {
  const { heroPhoto: _photo, ...facts } = input.facts;
  return { ...input, facts: { ...facts, photos: [] } };
}

/** The owner's order with `id` moved to straight after `after` (owners reorder sections within a page, U1). */
function moved(input: SiteDocumentInput, id: SectionId, after: SectionId): SiteDocumentInput {
  const rest = input.layout.filter((s) => s.id !== id);
  const section = input.layout.find((s) => s.id === id);
  if (section === undefined) throw new Error(`no ${id} in the layout`);
  const at = rest.findIndex((s) => s.id === after) + 1;
  return { ...input, layout: [...rest.slice(0, at), section, ...rest.slice(at)] } as SiteDocumentInput;
}

/** The hero section of a Home page: from its opening tag to the next block's. */
const heroOf = (page: string) => page.slice(page.indexOf('<section id="top"'), page.search(/<section id="(?:services-preview|reviews)"/));

describe("Bold page rules", () => {
  it("picks the headline size by length: capitals up to 40 characters, then two mixed-case steps", () => {
    expect(headlineClass("x".repeat(40))).toBe("h1 display");
    expect(headlineClass("x".repeat(41))).toBe("h1 display h1--long");
    expect(headlineClass("x".repeat(60))).toBe("h1 display h1--long");
    expect(headlineClass("x".repeat(61))).toBe("h1 display h1--xlong");
    expect(headlineClass("é".repeat(40))).toBe("h1 display");
  });

  it("gives a business name over 28 characters the smaller brand size", () => {
    expect(brandClass("x".repeat(28))).toBe("brand");
    expect(brandClass("x".repeat(29))).toBe("brand brand--long");
  });

  it("keeps every button in capitals only while the owner's label fits each of its buttons in capitals", () => {
    for (const label of ["Get a free quote", "Book a visit", "Book", "Schedule a free estimate"]) expect(buttonCase(label)).toBe("caps");
    const wide = "WWWW MMMM WWWW MMMM WWW";
    expect(capsWidth(wide, 20) * 1.03).toBeGreaterThan(274);
    expect(buttonCase(wide)).toBe("sentence");
  });

  it("words the contact heading when the band is not the page's h1", () => {
    expect(contactHeading("Get a free quote")).toBe("Get a free quote");
    expect(contactHeading("Book")).toBe("Request a booking");
    expect(contactHeading("Quote.")).toBe("Request a quote");
    expect(contactHeading("Hello")).toBe("Send us a request");
  });

  it("sets an inner page's h1 in capitals up to 40 characters, then in a mixed-case step", () => {
    expect(pageTitleClass("x".repeat(40))).toBe("pt display");
    expect(pageTitleClass("x".repeat(41))).toBe("pt display pt--long");
  });

  it("groups the week's hours, with no break inside a time or a day range", () => {
    expect(groupedHours(plumber.facts.hours ?? [])).toEqual([
      { label: `Monday${NBSP}–${NBSP}Friday`, value: `7:30${NBSP}AM${NBSP}– 6:00${NBSP}PM` },
      { label: "Saturday", value: `8:00${NBSP}AM${NBSP}– 2:00${NBSP}PM` },
      { label: "Sunday", value: "Closed" },
    ]);
    expect(groupedHours(fixture("hvac-phoenix").facts.hours ?? [], true)).toEqual([
      { label: `Mon${NBSP}–${NBSP}Fri`, value: `7:00${NBSP}AM${NBSP}– 7:00${NBSP}PM` },
      { label: `Sat${NBSP}–${NBSP}Sun`, value: `Open 24${NBSP}hours` },
    ]);
    expect(groupedHours([])).toEqual([{ label: `Monday${NBSP}–${NBSP}Sunday`, value: "Closed" }]);
  });

  it("never shows a licence code twice, and never changes the number", () => {
    expect(licenceParts({ label: "Arizona ROC", number: "ROC 999001" })).toEqual({ label: "Arizona", number: "ROC 999001" });
    expect(licenceParts({ label: "California C-10", number: "C-10 123456" })).toEqual({ label: "California", number: "C-10 123456" });
    expect(licenceParts({ label: "ROC", number: "ROC 1" })).toEqual({ label: "", number: "ROC 1" });
    expect(licenceParts({ label: "Texas master plumber", number: "M-40123" })).toEqual({ label: "Texas master plumber", number: "M-40123" });
  });

  it("lays the gallery out by photo count and shifts a founding year's leading 1 or 2", () => {
    expect([1, 2, 3, 4, 5, 6, 12].map(galleryClass)).toEqual(["gal gal--solo", "gal gal--f1", "gal gal--f2", "gal gal--f3", "gal gal--f1", "gal gal--f2", "gal gal--f2"]);
    expect([1998, 2011, 3000].map(yearClass)).toEqual(["year-n display year-n--1", "year-n display year-n--2", "year-n display"]);
  });

  // Round 3 (judge2-2): a long email or web address broke mid-word on phones ("example.c|om"). It may now break
  // after "@" and before a dot (MDN <wbr>: break a web address before its punctuation); only words of 16 or more
  // characters are cut, so a name's own dots ("J.R.", "Co.") never become break points.
  it("cuts a long email or web address after @ and before each dot, and leaves a name's own dots alone", () => {
    expect(addressParts("office@reliablerooter.example.com")).toEqual(["office@", "reliablerooter", ".example", ".com"]);
    expect(addressParts("www.reliablerooterplumbing.com")).toEqual(["www", ".reliablerooterplumbing", ".com"]);
    expect(addressParts("Visit www.reliablerooterplumbing.com today")).toEqual(["Visit www", ".reliablerooterplumbing", ".com today"]);
    expect(addressParts("estimates.and.claims@longhornstorm.com.")).toEqual(["estimates", ".and", ".claims@", "longhornstorm", ".com."]);
    expect(addressParts("J.R. Smith & Sons Plumbing Co.")).toEqual(["J.R. Smith & Sons Plumbing Co."]);
    expect(addressParts("hi@mop.example")).toEqual(["hi@mop.example"]);
    expect(addressParts("Reliable Rooter Plumbing")).toEqual(["Reliable Rooter Plumbing"]);
  });
});

// Every page shape an owner can give each page (A16, U1): each page's sections in every order the owner can choose
// within the page (the hero stays first), with any set of the owner-hideable sections left out. The page model is
// worked out by the real code (boldPage) for each page sitePages() gives the document.
function* pageShapes(): Generator<{ page: PageId; flow: readonly Band[] }> {
  const base = SiteDocument.parse(inDesign(loadFixture("plumber-austin"), "impact"));
  const orders: SectionId[][][] = [
    [["hero", "trust", "testimonials"], ["hero", "testimonials", "trust"]],
    [["services", "faq"], ["faq", "services"]],
    [["about"]],
    [["gallery"]],
    [["contact", "serviceArea"], ["serviceArea", "contact"]],
  ];
  const combos = orders.reduce<SectionId[][]>((all, choices) => all.flatMap((prefix) => choices.map((order) => [...prefix, ...order])), [[]]);
  for (const order of combos) {
    for (let mask = 0; mask < 1 << HIDEABLE_SECTIONS.length; mask++) {
      const hidden = HIDEABLE_SECTIONS.filter((_, bit) => (mask >> bit) % 2 === 1);
      const doc: SiteDocument = { ...base, hidden, layout: order.map((id) => base.layout.find((s) => s.id === id)!) };
      const pages = sitePages(doc);
      for (const page of pages) {
        const ctx: RenderContext = { doc, page, pages, formAction: safeUrl("https://forms.example.com/submit", ["https:"]) };
        yield { page: page.id, flow: boldPage(ctx).flow };
      }
    }
  }
}

describe("Bold surfaces", () => {
  it("in every page shape: opens on ink, ends on the closing band (Contact on its own bands), no ink beside ink, at most two light bands in a row in two tones, seams only on light bands, the reviews on ink", () => {
    const problems: string[] = [];
    const flows = new Set<string>();
    for (const { page, flow } of pageShapes()) {
      flows.add(`${page}: ${flow.join(",")}`);
      const surface = surfaces(flow);
      const shown = `${page}: ${flow.join(",")}`;
      if (!["hero", "head", "contact"].includes(flow[0] ?? "")) problems.push(`does not open on ink: ${shown}`);
      if ((page === "contact") !== (flow.at(-1) !== "closing")) problems.push(`closing band: ${shown}`);
      let light = 0;
      for (const id of [...flow, undefined]) {
        light = id === undefined || surface.get(id) === "ink" ? 0 : light + 1;
        if (light > 2) problems.push(`three light bands: ${shown}`);
      }
      flow.forEach((id, i) => {
        const next = flow[i + 1];
        if (next === undefined) return;
        const [a, b] = [surface.get(id), surface.get(next)];
        if (a === "ink" && b === "ink") problems.push(`ink beside ink: ${shown}`);
        if (a !== "ink" && a === b) problems.push(`same light tone: ${shown}`);
      });
      for (const id of flow) if (surface.get(id) === "ink" && seamClass(flow, surface, id) !== "") problems.push(`seam on an ink band: ${shown}`);
      // The approved Home: the reviews on ink between two seams, in every shape the owner can give Home.
      for (const id of ["hero", "head", "contact", "testimonials"] as const) if (flow.includes(id) && surface.get(id) !== "ink") problems.push(`${id} not ink: ${shown}`);
      // The closing band is ink unless the band above it is (then it is light, so two ink bands never merge).
      const above = flow[flow.indexOf("closing") - 1];
      if (flow.includes("closing") && (surface.get("closing") === "ink") === (above !== undefined && surface.get(above) === "ink")) problems.push(`closing band: ${shown}`);
    }
    expect([...new Set(problems)]).toEqual([]);
    // Home: the hero with the credentials in it or after the reviews, the preview, the reviews or none; the inner pages.
    expect([...flows].sort()).toEqual(
      [
        "home: hero,teaser,closing",
        "home: hero,teaser,testimonials,closing",
        "home: hero,teaser,testimonials,trust,closing",
        "services: head,services,closing",
        "services: head,services,faq,closing",
        "services: head,faq,services,closing",
        "about: head,about,closing",
        "gallery: head,gallery,closing",
        "contact: contact",
        "contact: contact,serviceArea",
        "contact: head,serviceArea,contact",
      ].sort(),
    );
  });

  it("puts the reviews on ink, and makes the closing band light right after them", () => {
    const home: Band[] = ["hero", "teaser", "testimonials", "closing"];
    const homeSurface = surfaces(home);
    expect(home.map((id) => homeSurface.get(id))).toEqual(["ink", "paper", "ink", "tint"]);
    const flow: Band[] = ["hero", "teaser", "testimonials", "trust", "closing"];
    const surface = surfaces(flow);
    expect(flow.map((id) => surface.get(id))).toEqual(["ink", "paper", "ink", "tint", "ink"]);
  });

  it("draws each seam from the light side: up over an ink band above (not the hero), down over an ink band below", () => {
    const home: Band[] = ["hero", "teaser", "testimonials", "closing"];
    const homeSurface = surfaces(home);
    expect(home.map((id) => seamClass(home, homeSurface, id))).toEqual(["", " seam-down", "", " seam-up"]);
    const services: Band[] = ["head", "services", "faq", "closing"];
    const surface = surfaces(services);
    expect(services.map((id) => surface.get(id))).toEqual(["ink", "paper", "tint", "ink"]);
    expect(services.map((id) => seamClass(services, surface, id))).toEqual(["", " seam-up", " seam-down", ""]);
  });
});

describe("the Bold page", () => {
  // Round 3 (A16 judges): with the credentials after the reviews (the owner's order, U1) the hero's card and the band
  // showed the same facts twice. Each fact has one home: the band, where the owner put it.
  it("draws the credentials straight under the hero as the hero's own card, and only as the band when the owner puts them after the reviews", () => {
    expect(heroOf(bold(plumber))).toContain('<section id="credentials" class="proof" aria-label="Credentials">');
    for (const input of [moved(fixture("hvac-phoenix"), "trust", "testimonials"), moved(plumber, "trust", "testimonials"), fixture("roofing-extreme")]) {
      const home = bold(input);
      expect(heroOf(home)).not.toContain("proof");
      expect(home).toMatch(/<section id="credentials" class="sec [a-z -]*sec--rail" aria-label="Credentials">/);
    }
  });

  // Round 3 (A16 judges): the Home band squeezed five licences into one column beside tall empty dividers, and
  // repeated the hero's 24/7 chip. Several licences get a row of their own (as on About); 24/7 stays in the hero.
  it("gives several licences their own row in the Home credentials band, and leaves 24/7 to the hero's chip", () => {
    const band = (home: string) => home.slice(home.indexOf('<section id="credentials"'), home.indexOf("</section>", home.indexOf('<section id="credentials"')));
    const roofing = band(bold(fixture("roofing-extreme")));
    expect(roofing).toContain('<dl class="specs specs--lics">');
    expect(roofing.match(/<dd>/g)).toHaveLength(5 + 2); // five licences, Insured, Since 1850
    expect(roofing).not.toContain("24/7");
    expect(band(bold(moved(plumber, "trust", "testimonials")))).toContain('<dl class="specs">');
    expect(heroOf(bold(fixture("roofing-extreme")))).toContain("24/7 emergency service");
  });

  // Round 3 (review2 I-2, attack2 I-1, the round-2 judges): the strip is two groups it never splits, the licences
  // (the first licence, then "+N more") and the owner's standing (Insured, the founding year), and it wraps whole
  // groups. So it is one line where everything fits, and "Insured  Since 2011" is never split at any width.
  it("groups the hero's credentials: the licences, then Insured and the founding year", () => {
    const LI = String.raw`<li><svg[^]*?<\/svg><span>`;
    expect(bold(fixture("hvac-phoenix"))).toMatch(
      new RegExp(
        String.raw`<section id="credentials" class="proof" aria-label="Credentials"><ul class="proof-list proof-lics"><li class="proof-lic">[^]*?ROC 999001[^]*?<\/li><li class="proof-more-li"><details class="proof-more"><summary>\+1 more license<\/summary>[^]*?<\/details><\/li><\/ul>` +
          String.raw`<ul class="proof-list">${LI}Insured<\/span><\/li>${LI}Since 2011<\/span><\/li><\/ul><\/section>`,
      ),
    );
    expect(bold(plumber)).toMatch(
      new RegExp(
        String.raw`<section id="credentials" class="proof" aria-label="Credentials"><ul class="proof-list proof-lics"><li class="proof-lic">[^]*?M-40123<\/span><\/span><\/li><\/ul>` +
          String.raw`<ul class="proof-list">${LI}Insured<\/span><\/li>${LI}Since 1998<\/span><\/li><\/ul><\/section>`,
      ),
    );
    // No licence: only the standing group.
    const minimal = fixture("cleaning-minimal");
    expect(bold({ ...minimal, facts: { ...minimal.facts, insured: true, yearFounded: 2015 } })).toMatch(
      new RegExp(String.raw`<section id="credentials" class="proof" aria-label="Credentials"><ul class="proof-list">${LI}Insured<\/span><\/li>${LI}Since 2015<\/span><\/li><\/ul><\/section>`),
    );
  });

  it("marks where a long email or web-address name may break: contact band, footer and header", () => {
    const name = "www<wbr>.reliablerooterplumbing<wbr>.com";
    const mail = "office@<wbr>reliablerooter<wbr>.example<wbr>.com";
    const page = site({ ...plumber, facts: { ...plumber.facts, businessName: "www.reliablerooterplumbing.com" } });
    expect(page).toContain(`<a class="brand brand--long" href="/">${name}</a>`);
    expect(page).toContain(`<p class="foot-brand">${name}</p>`);
    // The contact link is a flex row (icon, text), so its text sits in one span: a <wbr> is never a flex item.
    expect(page).toMatch(new RegExp(`<a class="mail" href="mailto:office@reliablerooter.example.com"><svg[^]*?</svg><span>${mail}</span></a>`));
    expect(page).toContain(`<a class="foot-email" href="mailto:office@reliablerooter.example.com">${mail}</a>`);
    // Every part is escaped as text.
    expect(site({ ...plumber, facts: { ...plumber.facts, businessName: "Tom&Jerry<b>.plumbing.example" } })).toContain(
      '<p class="foot-brand">Tom&amp;Jerry&lt;b&gt;<wbr>.plumbing<wbr>.example</p>',
    );
  });

  it("leaves the credentials out of the hero while the owner hides that section", () => {
    const page = bold({ ...plumber, hidden: ["trust"] });
    expect(page).not.toContain('class="proof"');
    expect(page).not.toContain("proof-list");
  });

  it("leads the no-photo hero card's hours with an Emergencies 24/7 row when the owner offers 24/7 service", () => {
    expect(bold(withoutPhotos(plumber))).toContain('<dl class="biz-hours"><div class="biz-247"><dt>Emergencies</dt><dd>24/7</dd></div><div><dt>Mon');
    expect(bold(fixture("hvac-phoenix"))).toContain('<dl class="biz-hours"><div class="biz-247"><dt>Emergencies</dt><dd>24/7</dd></div>');
    // The fixture's FAQ promises help "day or night", which only a 24/7 owner may say, so it goes too.
    const no247 = withoutPhotos({ ...plumber, facts: { ...plumber.facts, emergency247: false }, copy: { ...plumber.copy, faq: [] } });
    expect(bold(no247)).toContain('<dl class="biz-hours"><div><dt>Mon');
    expect(bold(no247)).not.toContain("biz-247");
  });

  it("drops the no-photo hero card while the owner hides the service area it sums up", () => {
    const page = bold({ ...withoutPhotos(plumber), hidden: ["serviceArea"] });
    expect(page).toContain('class="hero hero--type ink"');
    expect(page).not.toContain("biz-slot");
  });

  it("puts the links to more reviews after the quotes", () => {
    const page = bold(plumber);
    const order = ["rev-lead", "rev-grid", "rev-more"].map((name) => page.indexOf(`class="${name}`));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  // Round 3 (A16 judges): roofing's 12 reviews made the phone Home three to four screens of quotes.
  it("shows the lead review and four more, and the rest behind a \"Read N more reviews\" disclosure", () => {
    const roofing = fixture("roofing-extreme");
    const home = bold(roofing);
    const reviews = home.slice(home.indexOf('<section id="reviews"'), home.indexOf("</section>", home.indexOf('<section id="reviews"')));
    const shown = reviews.slice(0, reviews.indexOf('<details class="rev-rest">'));
    expect(shown.match(/<blockquote>/g)).toHaveLength(5);
    expect(shown).toContain('<ul class="rev-grid rev-grid--2">');
    expect(reviews).toMatch(/<details class="rev-rest"><summary><svg[^]*?<\/svg>Read 7 more reviews<\/summary>\n?<ul class="rev-grid rev-grid--3">/);
    for (const t of roofing.facts.testimonials ?? []) expect(reviews).toContain(escapeText(t.quote));
    expect(reviews.indexOf('class="rev-more"')).toBeGreaterThan(reviews.indexOf("</details>"));
    expect(bold(plumber)).not.toContain("rev-rest");
  });

  it("shows 24/7 service as the hero's credential only when the owner offers it and gave no other credential", () => {
    // cleaning-minimal: no licence, not insured, no founding year; the credentials follow the hero.
    const minimal = fixture("cleaning-minimal");
    const with247 = heroOf(bold({ ...minimal, facts: { ...minimal.facts, emergency247: true } }));
    expect(with247).toMatch(/<section id="credentials" class="proof" aria-label="Credentials"><ul class="proof-list"><li><svg[^]*?<\/svg><span>24\/7 emergency service<\/span><\/li><\/ul><\/section>/);
    expect(with247).not.toContain('class="chip"');
    const without = heroOf(bold(minimal));
    expect(without).not.toContain("proof");
    expect(without).not.toContain("24/7");
  });
});

// A16: every page of the site speaks Home's language, and a visitor can call or ask for a quote from each one.
describe("the Bold pages", () => {
  const all = pagesOf(plumber);

  it("lists the site's pages in the header, marks the current one in both lists, and links the name to Home", () => {
    for (const { page, path, html } of all) {
      const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
      const desktop = header.slice(header.indexOf('<ul class="nav-desktop">'), header.indexOf("</ul>"));
      expect(desktop.match(/href="[^"]*"/g), page).toEqual(all.map((p) => `href="${p.path}"`));
      expect(header.match(/<a href="[^"]*" aria-current="page">/g), page).toEqual([`<a href="${path}" aria-current="page">`, `<a href="${path}" aria-current="page">`]);
      expect(header).toMatch(/<a class="brand" href="\/">/);
    }
  });

  it("opens the phone menu as a <details> disclosure, so no history entry or :target can reopen it on Back", () => {
    const services = bold(plumber, "services");
    const header = services.slice(services.indexOf("<header"), services.indexOf("</header>"));
    expect(header).toContain('<details class="menu">\n<summary class="menu-btn"><span class="sr-only">Menu</span>');
    expect(header).not.toMatch(/href="#(?:menu)?"/);
    expect(header).not.toContain("id=");
  });

  // Round 2 (judges): the phone bar showed only "CALL"; the approved bar showed the number.
  it("puts Call with the number in view and \"Get a quote\" in the call bar on every page; the bar sticks except on Contact", () => {
    for (const { page, html } of all) {
      const bar = html.slice(html.indexOf("<aside"), html.indexOf("</aside>"));
      expect(bar, page).toContain(`<aside aria-label="Call us" class="${page === "contact" ? "callbar focus-outside:static" : "callbar sticky focus-outside:static"}">`);
      expect(bar, page).toMatch(/<a class="bt bt-action cb-call whitespace-nowrap" href="tel:\+15125550142" aria-label="Call \(512\) 555-0142"><svg[^]*?<\/svg><span class="cb-txt"><span class="cb-k">Call<\/span> <span>\(512\) 555-0142<\/span><\/span><\/a>/);
      expect(bar, page).toMatch(/href="\/contact#quote">Get a quote<\/a>/);
    }
  });

  // Round 2 (judges, reviewer): the menu said "Get a quote" where the header and the hero say the owner's words, and on
  // Contact its quote jump left the menu open over the form.
  it("puts Call and the owner's call to action in the phone menu, and Call only on Contact", () => {
    const menu = (html: string) => html.slice(html.indexOf('<div class="menu-acts">'), html.indexOf("</details>"));
    for (const { page, html } of all) {
      expect(menu(html), page).toMatch(/href="tel:\+15125550142" aria-label="Call \(512\) 555-0142">/);
      expect(menu(html).includes('href="/contact#quote">Get a free quote</a>'), page).toBe(page !== "contact");
      expect(menu(html), page).not.toContain("Get a quote<");
    }
  });

  // Round 3 (review2 I-1): the preview is the contract's (A16.md 2.3, hand-off section 0) and moderator ruling (a)'s:
  // the first three services, each its name and "From $N" only when the owner gave a price (a service without one shows
  // its name only), and exactly one link, "More about our services", to the Services page.
  it("previews the first three services on Home as the contract defines it: names, \"From $N\" only when priced, one link", () => {
    const services = [
      { name: "Drain cleaning", startingPrice: 89 },
      { name: "Leak detection" },
      { name: "Sewer line repair", startingPrice: 1200 },
      { name: "Water heater repair" },
    ];
    const doc = { ...plumber, facts: { ...plumber.facts, services }, copy: { ...plumber.copy, serviceDescriptions: services.map((s) => ({ service: s.name, description: `${s.name} done right.` })) } };
    const preview = (input: SiteDocumentInput) => {
      const home = bold(input);
      const at = home.indexOf('<section id="services-preview"');
      return home.slice(at, home.indexOf("</section>", at));
    };
    const three = { ...doc, facts: { ...doc.facts, services: services.slice(0, 3) }, copy: { ...doc.copy, serviceDescriptions: doc.copy.serviceDescriptions.slice(0, 3) } };
    for (const input of [doc, three]) {
      const html = preview(input);
      expect(html).toContain('<h2 id="services-preview-title" class="h2 display">Our services</h2>');
      expect([...html.matchAll(/<li class="svc svc--pv"><h3 class="svc-name h3">([^<]*)<\/h3>/g)].map((m) => m[1])).toEqual(["Drain cleaning", "Leak detection", "Sewer line repair"]);
      expect([...html.matchAll(/<p class="svc-price">From <span class="svc-amt display tnum">([^<]*)<\/span><\/p>/g)].map((m) => m[1])).toEqual(["$89", "$1,200"]);
      // The unpriced service: its name only.
      expect(html).toContain('<li class="svc svc--pv"><h3 class="svc-name h3">Leak detection</h3></li>');
      expect(html.match(/<a\b[^>]*>/g)).toEqual(['<a class="bt bt-ghost" href="/services">']);
      expect(html).toMatch(/<a class="bt bt-ghost" href="\/services">More about our services<svg[^]*?<\/svg><\/a>/);
      for (const extra of ["svc-desc", "sec-intro", "cta-card", "svc-ask", "Free estimate", "See all"]) expect(html).not.toContain(extra);
    }
  });

  it("draws a service's name in one style on Home and on Services", () => {
    const name = (html: string) => /<(h[23]) class="(svc-name h3)">Drain cleaning/.exec(html)?.[2];
    expect([name(bold(plumber)), name(bold(plumber, "services"))]).toEqual(["svc-name h3", "svc-name h3"]);
    // and no rule restyles the preview's names (round 1 set them in display capitals there).
    expect(DESIGN_CSS.impact.css).not.toMatch(/board--preview|svc--pv \.svc-name|svc-go/);
  });

  // Round 3 (A16 judges): the band led with the generic "Get in touch" and one line repeated on every page, and Home
  // ended on light grey where the approved page ended on an ink quote band. Now it leads with the owner's call to
  // action and the number in display type, as Contact's head does, with a line of its own on each page.
  it("ends every page but Contact on the closing band: the owner's call to action as its lead, a line for the page, the number and the call-to-action button", () => {
    const lines = new Set<string>();
    for (const { page, html } of all) {
      const start = html.indexOf('<section id="get-in-touch"');
      if (page === "contact") {
        expect(start).toBe(-1);
        continue;
      }
      const band = html.slice(start, html.indexOf("</section>", start));
      // Light right after Home's ink reviews (so the two never merge), with the band's content on an ink panel there.
      expect(band, page).toMatch(page === "home" ? /^<section id="get-in-touch" class="sec tint seam-up" / : /^<section id="get-in-touch" class="sec ink" /);
      expect(band, page).toContain(`<div class="wrap"><div class="${page === "home" ? "close close--panel ink" : "close"}">`);
      expect(band, page).toContain('<h2 id="get-in-touch-title" class="kicker eyebrow">Get in touch</h2><p class="close-lead h2 display">Get a free quote</p>');
      lines.add(/<p class="sec-intro">([^<]*)<\/p>/.exec(band)?.[1] ?? "");
      expect(band, page).toMatch(/<p class="kicker">Prefer to talk\?<\/p><p><a class="big-call" href="tel:\+15125550142"><span class="big-call-ic"><svg[^]*?<\/svg><\/span><span class="display">\(512\) 555-0142<\/span><\/a><\/p>/);
      expect(band, page).toContain('href="/contact#quote">Get a free quote</a>');
      expect(html.indexOf("</main>") - html.indexOf("</section>", start), page).toBeLessThan(20);
    }
    expect([...lines].filter((line) => line !== "")).toHaveLength(4);
    expect(bold(plumber)).toMatch(/<section id="reviews" class="sec ink" /);
    // A one-word label leads as a fuller line; the button keeps the owner's word.
    const cleaning = bold(fixture("cleaning-minimal"));
    expect(cleaning).toContain('<p class="close-lead h2 display">Request a booking</p>');
    expect(cleaning).toMatch(/href="\/contact#quote">Book<\/a>/);
  });

  // Round 3 (A16 judges): /services stacked three Call and quote pairs in its first desktop screen; About's chips
  // repeated its credentials right below them; on phones the chips wrapped and left the year alone on a line.
  it("opens each inner page on a short ink head: its h1, the owner's standing and, from 64rem, Call and the call to action (Services leaves them to its card)", () => {
    for (const { page, html } of all.filter((p) => p.page !== "home")) {
      const main = html.slice(html.indexOf('<main id="main">'));
      if (page === "contact") {
        expect(main).toMatch(/^<main id="main">\n<section id="contact" class="sec ink sec--open" aria-labelledby="contact-title">\n<div class="wrap contact">\n<div class="sec-head contact-head"><p class="kicker eyebrow">Plumbing · Austin, TX<\/p><h1 id="contact-title" class="pt display">Get a free quote<\/h1>/);
        continue;
      }
      expect(main, page).toMatch(/^<main id="main">\n<section id="[a-z-]+" class="page-open" aria-labelledby="[a-z-]+-title">\n<div class="page-head ink"><div class="wrap ph"><div class="page-title"><p class="kicker eyebrow">Plumbing · Austin, TX<\/p><h1 /);
      const head = main.slice(0, main.indexOf('\n<div class="sec '));
      if (page === "about") {
        // About's credentials, right below, list Insured and 24/7; the year is on its photo.
        expect(head, page).not.toContain("ph-chips");
      } else {
        expect(head, page).toMatch(/<ul class="ph-chips"><li class="chip"><svg[^]*?<\/svg>24\/7 emergency<span class="ph-long"> service<\/span><\/li>/);
        expect(head, page).toContain("Insured</li>");
        expect(head, page).toContain("Since 1998</li>");
      }
      expect(head.includes('<div class="ph-acts">'), page).toBe(page !== "services");
      if (page !== "services") expect(head, page).toMatch(/<div class="ph-acts"><a class="bt bt-action whitespace-nowrap" href="tel:\+15125550142"[^]*href="\/contact#quote">Get a free quote<\/a><\/div>/);
    }
    // With the credentials hidden, About keeps the 24/7 chip: nothing else on the page states it then.
    expect(bold({ ...plumber, hidden: ["trust"] }, "about")).toMatch(/<ul class="ph-chips"><li class="chip"><svg[^]*?<\/svg>24\/7 emergency/);
  });

  // Round 2 (judges): with the FAQ first, Services was titled "Questions & answers" under the active Services link.
  it("keeps the page's name as the Services h1 when the owner puts the FAQ first, and the FAQ its own heading", () => {
    const faqFirst = bold(moved(plumber, "services", "faq"), "services");
    expect(faqFirst).toMatch(/<section id="faq" class="page-open" aria-labelledby="faq-title">\n<div class="page-head ink"><div class="wrap ph"><div class="page-title"><p class="kicker eyebrow">Plumbing · Austin, TX<\/p><h1 class="pt display">Our services<\/h1><ul class="ph-chips">/);
    expect(faqFirst).toMatch(/<div class="wrap faq-layout">\n<div class="sec-head"><p class="kicker eyebrow">FAQ<\/p><h2 id="faq-title" class="h2 display">Questions &amp; answers<\/h2>/);
    expect(faqFirst).toContain('<summary><h3 class="h3">');
    expect(faqFirst).toMatch(/<section id="services" class="sec tint seam-down" aria-labelledby="services-title">/);
    expect(faqFirst).toContain('<h3 class="svc-name h3">Drain cleaning</h3>');
  });

  // Round 2 (judges, CRITICAL): with the service area first, a phone's first screen had no way to call or ask for a
  // quote (the Contact bar sits at the end of the page, moderator ruling b).
  // Round 3 (review2 Minor, A16 judges): the number showed twice (head and form band), and as plain display type that
  // did not read as tappable on the page whose call bar sits at its end.
  it("puts the number, as a call control, and the owner's call to action in Contact's head when the owner puts the service area first, and only there", () => {
    const contact = bold(moved(plumber, "contact", "serviceArea"), "contact");
    const head = contact.slice(contact.indexOf('<div class="page-head ink">'), contact.indexOf('\n<div class="sec ', contact.indexOf('<div class="page-head ink">')));
    expect(head).toContain('<h1 id="service-area-title" class="pt display">Service area &amp; hours</h1>');
    expect(head).toMatch(/<div class="ph-talk"><p class="kicker">Prefer to talk\?<\/p><p><a class="big-call" href="tel:\+15125550142"><span class="big-call-ic"><svg[^]*?<\/svg><\/span><span class="display">\(512\) 555-0142<\/span><\/a><\/p><p><a class="bt bt-ghost" href="\/contact#quote">Get a free quote<\/a><\/p><\/div>/);
    expect(contact.indexOf('<div class="ph-talk">')).toBeLessThan(contact.indexOf('<div class="area card">'));
    const band = contact.slice(contact.indexOf('<section id="contact"'), contact.indexOf("</section>", contact.indexOf('<section id="contact"')));
    for (const repeat of ["big-call", 'class="talk"', "ph-chips", "Prefer to talk"]) expect(band).not.toContain(repeat);
    expect(band).toMatch(/<div class="talk-more">[^]*M-40123[^]*office@/);
  });

  it("shows the first 12 towns and the rest behind \"+N more areas\", every town still on the page", () => {
    const roofing = fixture("roofing-extreme");
    const contact = bold(roofing, "contact");
    const area = contact.slice(contact.indexOf('<section id="service-area"'), contact.indexOf('<section id="contact"'));
    const first = area.slice(0, area.indexOf('<details class="more-places">'));
    expect(first.match(/<li>/g)).toHaveLength(12);
    expect(area).toContain('<details class="more-places"><summary>+18 more areas</summary><ul class="chips">');
    for (const place of roofing.facts.serviceArea.places) expect(area).toContain(`<li>${escapeText(place)}</li>`);
    expect(bold(plumber, "contact")).not.toContain("more-places");
  });

  // Round 2 (judges): About was all type, repeated the name and place three times, left half the band empty without a
  // year and squeezed several licences into a third of a row.
  // Round 3 (A16 judges): About showed the same van photo the visitor had just seen full-bleed on Home.
  it("shows an owner photo on About that Home has not shown, with the year on its tab, and no signature", () => {
    const about = bold(plumber, "about");
    expect(about).toMatch(/<div class="wrap about about--photo">\n<figure class="about-media"><img src="https:\/\/picsum\.photos\/seed\/rooter-1\/1200\/900" width="1200" height="900" alt="[^"]+" loading="eager" decoding="async"><p class="year"><span class="kicker">Since<\/span> <span class="year-n display year-n--1">1998<\/span><\/p><\/figure><div class="about-body">/);
    expect(about).not.toContain('class="sign');
    // A gallery photo that is the hero's own is passed over.
    const hero = plumber.facts.heroPhoto!;
    expect(bold({ ...plumber, facts: { ...plumber.facts, photos: [{ ...hero, caption: "Our van" }, ...(plumber.facts.photos ?? [])] } }, "about")).toContain('<img src="https://picsum.photos/seed/rooter-1/1200/900"');
    // The gallery hidden: the hero photo is the only one, so About shows it.
    expect(bold({ ...plumber, hidden: ["gallery"] }, "about")).toContain('<img src="https://picsum.photos/seed/rooter-van/1600/900"');
    // No hero photo: the first gallery photo, while the gallery shows.
    const { heroPhoto: _hero, ...facts } = plumber.facts;
    expect(bold({ ...plumber, facts }, "about")).toContain('<img src="https://picsum.photos/seed/rooter-1/1200/900"');
    expect(bold({ ...plumber, facts, hidden: ["gallery"] }, "about")).not.toContain("<img");
  });

  it("lays About out by what the owner has: several licences get their own row, no photo puts the credentials under the year, neither puts them beside the story", () => {
    const layout = (input: SiteDocumentInput) => /<div class="(wrap about[^"]*)">/.exec(bold(input, "about"))?.[1];
    const { heroPhoto: _hero, ...facts } = plumber.facts;
    const noPhotos = { ...facts, photos: [] };
    const { yearFounded: _year, ...noYear } = noPhotos;
    expect(layout(plumber)).toBe("wrap about about--photo");
    expect(layout(fixture("roofing-extreme"))).toBe("wrap about about--photo about--wide");
    expect(layout({ ...plumber, facts: noPhotos })).toBe("wrap about about--year");
    expect(layout({ ...plumber, facts: noYear })).toBe("wrap about about--text");
    expect(layout({ ...plumber, facts: noYear, hidden: ["trust"] })).toBe("wrap about about--solo");
    expect(bold({ ...plumber, facts: noPhotos }, "about")).toContain('<dl class="specs about-specs specs--stack">');
  });

  it("shows the owner's credentials on About too, unless the owner hides the credentials section", () => {
    expect(bold(plumber, "about")).toMatch(/<dl class="specs about-specs">[^]*M-40123[^]*Insured[^]*24\/7 emergency service[^]*<\/dl>/);
    expect(bold({ ...plumber, hidden: ["trust"] }, "about")).not.toContain("specs");
  });

  // Round 3 (A16 judges): a photo opened its bare file in the same tab, a page with no header, call bar or quote button.
  it("shows each gallery photo in the page, with no link away to its bare file", () => {
    const gallery = bold(plumber, "gallery");
    expect(gallery).toContain('<figure><div class="gal-img"><img src="https://picsum.photos/seed/rooter-1/1200/900" ');
    expect(gallery.match(/<div class="gal-img"><img /g)).toHaveLength(6);
    expect(gallery).not.toContain('<a class="gal-img"');
  });

  // Round 2 (judges): the footer had no way to the other pages and no hours. Round 3 (A16 judges): on Contact the
  // footer repeated the address and hours of the service area card right above it.
  it("lists the site's pages in the footer, the current one marked, and the hours and address unless Contact's service area shows them", () => {
    for (const { page, path, html } of all) {
      const footer = html.slice(html.indexOf("<footer"), html.indexOf("</footer>"));
      expect(footer.match(/<nav aria-label="Pages">[^]*?<\/nav>/)?.[0].match(/href="[^"]*"/g), page).toEqual(all.map((p) => `href="${p.path}"`));
      expect(footer, page).toContain(`<a href="${path}" aria-current="page">`);
      expect(footer.includes('<dl class="foot-hours"><div><dt>Emergencies</dt><dd>24/7</dd></div><div><dt>Mon'), page).toBe(page !== "contact");
      expect(footer.includes("4100 S Congress Ave"), page).toBe(page !== "contact");
    }
    expect(bold({ ...plumber, hidden: ["serviceArea"] })).not.toContain("foot-hours");
    expect(bold({ ...plumber, hidden: ["serviceArea"] }, "contact")).toContain("<li>4100 S Congress Ave, Austin, TX 78745</li>");
  });

  it("links the hero card's towns to the service area on the Contact page", () => {
    const roofing = withoutPhotos(fixture("roofing-extreme"));
    expect(heroOf(bold(roofing))).toContain('and <a href="/contact#service-area">27 more</a>');
  });

  it("words a fixed line under the Contact heading when the owner's copy has no intro (a lone \"Book\" never stands alone)", () => {
    expect(bold(fixture("cleaning-minimal"), "contact")).toMatch(/<h1 id="contact-title" class="pt display">Book<\/h1><p class="sec-intro">Send a quick request, or call us\.<\/p>/);
  });

  // Round 3 (A16 judges): the form had no trust beside it, and the number (the phone's only call control on the page
  // whose bar sits at its end) did not read as tappable.
  it("gives the form the quote id; puts the owner's standing and the number as a call control before it, the licence and the email after it", () => {
    const contact = bold(plumber, "contact");
    // Today's opening tag exactly, with no class: the sites Worker's pipeline test reads the form action from it.
    expect(contact).toContain(`<form id="quote" action="${FIXTURE_FORM_ACTION}" method="post">`);
    expect(contact.match(/id="quote"/g)).toHaveLength(1);
    const head = contact.slice(contact.indexOf('<div class="sec-head contact-head">'), contact.indexOf('<div class="talk">'));
    expect(head).toMatch(/<ul class="ph-chips">[^]*24\/7 emergency[^]*Insured<\/li>[^]*Since 1998<\/li><\/ul>/);
    expect(contact).toMatch(/<div class="talk"><p class="kicker">Prefer to talk\?<\/p><p><a class="big-call" href="tel:\+15125550142"><span class="big-call-ic"><svg/);
    const order = ['<div class="talk">', '<div class="form-card card">', '<div class="talk-more">'].map((s) => contact.indexOf(s));
    expect(order[0]).toBeGreaterThan(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const more = contact.slice(order[2], contact.indexOf("</section>", order[2]));
    expect(more).toMatch(/Texas master plumber[^]*M-40123[^]*office@/);
    // The owner hides the credentials: no licence, Insured or year by the form.
    const hidden = bold({ ...plumber, hidden: ["trust"] }, "contact");
    expect(hidden.slice(hidden.indexOf('<section id="contact"'), hidden.indexOf("<footer"))).not.toMatch(/M-40123|Insured|Since 1998/);
  });
});

describe("the Bold sheet carries the round-4 must-fixes", () => {
  const css = DESIGN_CSS.impact.css;
  /** Every declaration block of `selector` in the compiled sheet, or only those after the first `media` query. */
  const rule = (selector: string, media?: string) => {
    const scope = media === undefined ? css : css.slice(css.indexOf(media));
    const blocks: string[] = [];
    for (let at = scope.indexOf(`${selector}{`); at !== -1; at = scope.indexOf(`${selector}{`, at + 1)) {
      if (!/[\w-]/.test(scope.charAt(at - 1))) blocks.push(scope.slice(at, scope.indexOf("}", at) + 1));
    }
    return blocks.join("");
  };

  it("sizes every h2 with clamp(1.75rem, 1.25rem + 1.9vw, 3rem)", () => {
    expect(rule(".h2")).toContain("font-size:clamp(1.75rem,1.25rem + 1.9vw,3rem)");
  });

  it("gives the call bar a tight shadow and stacks it below the form's Send button", () => {
    expect(rule(".callbar")).toContain("box-shadow:0 -6px 12px -8px");
    expect(rule(".callbar")).toContain("z-index:10");
    expect(css).toContain("form button[type=submit]{z-index:20;position:relative}");
  });

  it("lines the FAQ up on the page's left edge from 64rem, like every other section", () => {
    expect(rule(".faq-layout", "@media (min-width:64rem)")).toContain('grid-template:"head list""call list"1fr/minmax(0,5fr) minmax(0,7fr)');
  });

  it("never stretches a type-only hero to the window's height", () => {
    expect(css).not.toMatch(/\.hero--type[^{]*\{[^}]*min-height:calc\(100/);
  });

  it("frames the photo at laptop widths, so a wide photo keeps its subject", () => {
    expect(rule(".hero--photo .hero-media", "@media (min-width:64rem) and (max-width:79.99rem)")).toContain("aspect-ratio:4/3");
  });

  // Round 1 of the build (review, attack and judges).
  it("keeps long owner words inside the hero's text column", () => {
    expect(css).toContain(".hero-copy>.hero-kicker,.hero-copy>.h1,.hero-copy>.proof{max-width:100%}");
  });

  // Round 3: round 2 forced the licence and "+N more" onto a line each at every width, which stacked the desktop
  // strip into 2-3 lines where one fits (review2 I-2). Now the strip wraps whole groups (the markup test above).
  it("wraps the credentials strip by whole groups and forces no item onto a line of its own", () => {
    expect(rule(".proof")).toContain("display:flex");
    expect(rule(".proof")).toContain("flex-wrap:wrap");
    expect(rule(".proof-list")).toContain("flex-wrap:wrap");
    expect(css).not.toMatch(/\.proof-(?:lic|more-li)\{[^}]*flex-basis:100%/);
    // On the desktop photo card the licences keep their ruled block above Insured and Since.
    expect(rule(".hero--photo .proof-lics", "@media (min-width:64rem)")).toContain("border-bottom:1px solid var(--fg-l)");
  });

  // Round 3 (judge2-2): an email breaks at its <wbr> points into even lines ("office@reliablerooter" /
  // ".example.com", not a lone ".com"), and inside a part only when that part alone is wider than the line.
  it("balances a long email's lines and breaks inside a part only as the last resort", () => {
    for (const selector of [".mail>span", ".foot-email"]) expect(rule(selector)).toContain("text-wrap:balance");
    for (const selector of [".mail", ".foot-email"]) expect(rule(selector)).toContain("overflow-wrap:anywhere");
  });

  it("splits the call bar in two halves, the Call half never narrower than its number, with \"Call\" over the number on phones", () => {
    expect(rule(".callbar")).toContain("grid-template-columns:repeat(2,minmax(min-content,1fr))");
    expect(rule(".cb-txt")).toContain("flex-direction:column");
    expect(rule(".cb-txt", "@media (min-width:36rem)")).toContain("flex-direction:row");
    expect(css).not.toContain(".cb-num");
  });

  // A16: the current page is marked by more than colour (WCAG 1.4.1): the house slanted bar, in the action colour,
  // under the desktop link and before the menu's; the bar is a graphic, so it needs 3:1 against the ink (WCAG 1.4.11).
  it("marks the current page with the slanted bar, not by colour alone, at 3:1 or more against the ink", () => {
    for (const selector of [".nav-desktop a[aria-current=page]:after", ".menu-list a[aria-current=page]>span:after"]) {
      const block = rule(selector);
      expect(block, selector).toContain("background:var(--aw-impact-accent)");
      expect(block, selector).toContain("clip-path:polygon(");
    }
    for (const palette of PALETTE_IDS) {
      const { accent, ink } = BOLD_COLORS[palette];
      expect(contrastRatio(hexToRgb(accent), hexToRgb(ink)), palette).toBeGreaterThanOrEqual(3);
    }
  });

  it("sizes the phone menu from the header's own height, so it always reaches the bottom of the screen", () => {
    expect(rule(".menu-panel")).toContain("height:calc(100svh - 100%)");
    expect(css).not.toContain("3.8125rem");
  });

  // Round 2 (the builder's own sweep): a long licence number in the desktop credentials band squeezed the other
  // items until "INSURANCE" ran 24 px out of its column; a one-word call-to-action ran out of the services card's
  // button. The house items keep their width and only the owner's licences wrap; the card's button breaks the word.
  it("lets only the licences give way in the desktop credentials band", () => {
    expect(rule(".spec", "@media (min-width:64rem)")).toContain("flex:none");
    expect(rule(".spec-lic", "@media (min-width:64rem)")).toContain("flex-shrink:1");
  });

  it("breaks a call-to-action word too long for the services card's button inside the button", () => {
    expect(rule(".cta-actions .bt")).toContain("overflow-wrap:anywhere");
  });
});
