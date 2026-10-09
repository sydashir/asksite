// The trade name and the service-area scope (user order 2026-10-09): an IT firm, a law firm and a business of the
// owner's own type, and owners who serve the whole country or the world, in every design. One test per behaviour.
import { DESIGN_IDS, Facts, SiteDocument, type DesignId, type ServiceAreaScope, type SiteDocumentInput } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { FIXTURE_FORM_ACTION, FIXTURE_SITE_URL, FIXTURES, inDesign, loadFixture, stubStylesheets } from "../../../fixtures/index.ts";
import { askLine, needLine } from "../src/designs/refined/parts.ts";
import { needQuestion } from "../src/designs/modern/text.ts";
import { tradeLabel } from "../src/format.ts";
import { localBusinessJsonLd } from "../src/json-ld.ts";
import { pageDescription, pageTitle, render } from "../src/render.ts";
import { FULL } from "./support/doc.ts";
import { readableTexts, squashedText } from "./support/page-text.ts";

const OPTIONS = { stylesheets: stubStylesheets(), formAction: FIXTURE_FORM_ACTION, siteUrl: FIXTURE_SITE_URL };
const sitePages = (input: SiteDocumentInput, design: DesignId) => render(inDesign(input, design), OPTIONS).pages;
const texts = (html: string) => readableTexts(html).map((text) => text.replace(/\s+/g, " ").trim());

/** The markup of the service area section, "" when the page has none. */
const areaSection = (html: string) => {
  const start = html.indexOf('<section id="service-area"');
  return start === -1 ? "" : html.slice(start, html.indexOf("</section>", start));
};

/** Headings with no text and lists with no item: what a design must never leave behind. */
const hollow = (html: string): string[] => [
  ...[...html.matchAll(/<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/g)].filter((m) => squashedText(m[2] ?? "") === "").map((m) => m[0]),
  ...[...html.matchAll(/<(ul|ol|dl)\b[^>]*>([\s\S]*?)<\/\1>/g)].filter((m) => !/<(li|dt)\b/.test(m[2] ?? "")).map((m) => m[0]),
];

const LINE: Readonly<Record<Exclude<ServiceAreaScope, "places">, string>> = { country: "Serving customers nationwide", worldwide: "Serving customers worldwide" };

describe("the trade name", () => {
  it("is the owner's own business type for trade other, wherever the trade shows", () => {
    const doc = SiteDocument.parse(loadFixture("other-worldwide"));
    expect(tradeLabel(doc.facts)).toBe("Translation services");
    expect(pageTitle(doc)).toBe("Lingo Bridge Translations | Translation services in Seattle, WA");
    expect(pageDescription(doc, "services")).toBe("Translation services from Lingo Bridge Translations in Seattle, WA. Call (206) 555-0173.");
    for (const design of DESIGN_IDS) {
      for (const page of sitePages(loadFixture("other-worldwide"), design)) {
        expect({ design, page: page.page, named: texts(page.html).some((text) => text.startsWith("Translation services")) }).toEqual({ design, page: page.page, named: true });
        expect(texts(page.html)).not.toContain("Other");
      }
    }
  });

  it("is IT firm and Law firm for those trades", () => {
    expect(pageTitle(SiteDocument.parse(loadFixture("it-country")))).toBe("Brightline IT Partners | IT firm in Columbus, OH");
    expect(pageTitle(SiteDocument.parse(loadFixture("law-denver")))).toBe("Harper & Lin Law | Law firm in Denver, CO");
  });

  it("gives each design's trade sentences plain words, and the owner's own type no article", () => {
    const facts = (trade: Facts["trade"], tradeOther?: string) =>
      Facts.parse({ ...FULL.facts, trade, ...(tradeOther === undefined ? {} : { tradeOther }) });
    expect([needQuestion(facts("it")), needQuestion(facts("law")), needQuestion(facts("other", "Bakery"))]).toEqual(["Need IT help in Austin?", "Need legal help in Austin?", "Bakery in Austin?"]);
    expect([needLine(facts("it")), needLine(facts("law")), needLine(facts("other", "Bakery"))]).toEqual(["Need IT help in Austin?", "Need legal help in Austin?", "Bakery in Austin?"]);
    expect([askLine(facts("it")), askLine(facts("law")), askLine(facts("other", "Bakery")), askLine(facts("other", "Pool service"))]).toEqual([
      "Ask us about any IT project.",
      "Ask us about any legal matter.",
      "Ask us about our Bakery services.",
      "Ask us about our Pool service.",
    ]);
  });
});

describe("the service-area scope", () => {
  it.each([
    ["it-country", "country"],
    ["other-worldwide", "worldwide"],
  ] as const)("%s shows exactly its scope line in place of the place list, in every design", (name, scope) => {
    for (const design of DESIGN_IDS) {
      const pages = sitePages(loadFixture(name), design);
      const contact = pages.find((p) => p.page === "contact")?.html ?? "";
      expect({ design, line: texts(areaSection(contact)).includes(LINE[scope]) }).toEqual({ design, line: true });
      expect({ design, areas: pages.filter((p) => p.html.includes("Areas we serve")).map((p) => p.page), hollow: pages.flatMap((p) => hollow(p.html)) }).toEqual({ design, areas: [], hollow: [] });
    }
  });

  // Publishing drops the places and the note for these scopes; a draft keeps them, so the renderer ignores them too.
  it("shows no place, no list and no note a document keeps when the scope is country or worldwide", () => {
    const kept: SiteDocumentInput = { ...FULL, facts: { ...FULL.facts, serviceArea: { places: ["Zebulon", "Quartzsite Junction"], note: "Within ten miles of Zebulon" } } };
    const { heroPhoto: _photo, hours: _hours, ...bare } = kept.facts;
    const variants = [kept, { ...kept, facts: bare }]; // with a photo and hours; with neither (the hero cards, Classic's one-line area)
    const seen = (input: SiteDocumentInput, design: DesignId) => sitePages(input, design).map((p) => p.html).join("");
    for (const design of DESIGN_IDS) {
      for (const input of variants) {
        expect(seen(input, design)).toContain("Quartzsite Junction"); // the places scope shows them, so the check below can see them
        for (const scope of ["country", "worldwide"] as const) {
          const site = seen({ ...input, facts: { ...input.facts, serviceAreaScope: scope } }, design);
          expect({ design, scope, kept: ["Zebulon", "Quartzsite", "ten miles"].filter((word) => site.includes(word)), line: site.includes(LINE[scope]), hollow: hollow(site) }).toEqual({ design, scope, kept: [], line: true, hollow: [] });
        }
      }
    }
  });

  it("puts the type and areaServed in the JSON-LD per schema.org: the places, the country, or none for worldwide", () => {
    const ld = (trade: Facts["trade"], serviceAreaScope?: ServiceAreaScope) =>
      localBusinessJsonLd(Facts.parse({ ...FULL.facts, trade, ...(trade === "other" ? { tradeOther: "Bakery" } : {}), ...(serviceAreaScope === undefined ? {} : { serviceAreaScope }) }), FIXTURE_SITE_URL);
    expect([ld("it")["@type"], ld("law")["@type"], ld("other")["@type"]]).toEqual(["LocalBusiness", "LegalService", "LocalBusiness"]);
    expect(ld("law", "places")["areaServed"]).toEqual(["Austin", "Round Rock", "78704"]);
    expect(ld("it", "country")["areaServed"]).toEqual({ "@type": "Country", name: "United States" });
    expect("areaServed" in ld("other", "worldwide")).toBe(false);
  });
});

// STRICT (claims rule): the law firm's pages promise no outcome and use no superlative, and no page says nationwide or
// worldwide unless the owner's scope does.
describe("the scope and law claims", () => {
  // Plan 4's law words (2026-10-09), with their allowed phrases ("as a result", "best interests", "leading to") taken out first.
  const OUTCOME_OR_SUPERLATIVE =
    /\b(win|wins|winning|won|results?|success|successful(ly)?|favou?rable|maximi[sz]e|maximum|you deserve|proven|track record|undefeated|best|finest|greatest|leading|premier|foremost|top (lawyers?|attorneys?|firms?|notch|tier|choice)|number one|unmatched|unrivall?ed|unbeatable|unparalleled|second to none|world-class|elite|guarantee[ds]?|most (experienced|trusted|respected|skilled|successful|qualified|knowledgeable|reliable|aggressive|dedicated))\b/i;
  const ALLOWED = /\bas a result\b|\bbest interests\b|\bleading (up )?to\b/gi;

  it("the law firm's pages, in every design, hold no outcome or superlative word", () => {
    for (const design of DESIGN_IDS) {
      const found = sitePages(loadFixture("law-denver"), design).flatMap((p) => texts(p.html).flatMap((text) => OUTCOME_OR_SUPERLATIVE.exec(text.replace(ALLOWED, ""))?.[0] ?? []));
      expect({ design, found }).toEqual({ design, found: [] });
    }
  });

  it("no fixture says nationwide or worldwide unless its scope does, in any design", () => {
    for (const name of FIXTURES) {
      const scope = loadFixture(name).facts.serviceAreaScope ?? "places";
      for (const design of DESIGN_IDS) {
        const site = sitePages(loadFixture(name), design).map((p) => texts(p.html).join(" ")).join(" ");
        expect({ name, design, nationwide: /nationwide/i.test(site), worldwide: /worldwide/i.test(site) }).toEqual({ name, design, nationwide: scope === "country", worldwide: scope === "worldwide" });
      }
    }
  });
});
