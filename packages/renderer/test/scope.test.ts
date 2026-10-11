// The trade name and the service-area scope (user order 2026-10-09): an IT firm, a law firm and a business of the
// owner's own type, and owners who serve the whole country or the world, in every design. One test per behaviour.
import { DESIGN_IDS, Facts, SiteDocument, type DesignId, type ServiceAreaScope, type SiteDocumentInput } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { FIXTURE_FORM_ACTION, FIXTURE_SITE_URL, FIXTURES, inDesign, loadFixture, stubStylesheets } from "../../../fixtures/index.ts";
import { askLine, needLine } from "../src/designs/refined/parts.ts";
import { askAbout, needQuestion } from "../src/designs/modern/text.ts";
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
    expect(pageDescription(doc, "services")).toBe("Services from Lingo Bridge Translations, Translation services in Seattle, WA. Call (206) 555-0173.");
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
    expect([askLine(facts("it")), askLine(facts("law")), askLine(facts("other", "Bakery"))]).toEqual([
      "Ask us about any IT project.",
      "Ask us about your legal matter.",
      "Ask us about anything not listed.",
    ]);
  });
});

// Scope review M1-M5 (2026-10-11): words that fit an IT firm, a law firm and any other business, whatever form the
// owner's own business type takes. One test per behaviour.
describe("the trade wording", () => {
  const input = (trade: Facts["trade"], tradeOther?: string): SiteDocumentInput => ({ ...FULL, facts: { ...FULL.facts, trade, ...(tradeOther === undefined ? {} : { tradeOther }) } });
  const parsed = (trade: Facts["trade"], tradeOther?: string) => SiteDocument.parse(input(trade, tradeOther));
  /** Every string the document itself holds (the owner's facts, the AI's copy): the words a design adds are the rest. */
  const ownWords = (doc: SiteDocumentInput): Set<string> => {
    const out = new Set<string>();
    const walk = (value: unknown): void => {
      if (typeof value === "string") out.add(value.replace(/\s+/g, " ").trim());
      else if (value !== null && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(doc);
    return out;
  };
  const OTHERS = [["it"], ["law"], ["other", "Bakery"]] as const;

  it("speaks to an IT firm, a law firm and any other business in their own words, never of a job or the customer's place", () => {
    const TRADE_WORDS = /\b(jobs?|at your place|on[- ]?site|call[- ]?outs?)\b/i;
    const found = OTHERS.flatMap(([trade, other]) =>
      DESIGN_IDS.flatMap((design) => {
        const own = ownWords(input(trade, other));
        return sitePages(input(trade, other), design).flatMap((p) => texts(p.html).filter((text) => !own.has(text) && TRADE_WORDS.test(text)).map((text) => `${trade} ${design} ${p.page}: ${text}`));
      }),
    );
    expect(found).toEqual([]);
    // Bold's closing band (the owner offers 24/7 service, so the page's question opens its line), Modern's last services card.
    const boldLine = (trade: Facts["trade"], other: string | undefined, page: "home" | "gallery") =>
      texts(sitePages(input(trade, other), "impact").find((p) => p.page === page)?.html ?? "").find((text) => text.endsWith(" Call us, or send a quick request."));
    expect(OTHERS.map(([trade, other]) => [boldLine(trade, other, "home"), boldLine(trade, other, "gallery"), askAbout(parsed(trade, other).facts)])).toEqual([
      ["Questions, or a project in mind? Call us, or send a quick request.", "Like what you see? Call us, or send a quick request.", "Tell us about the project."],
      ["Questions about a legal matter? Call us, or send a quick request.", "Like what you see? Call us, or send a quick request.", "Tell us about your legal matter."],
      ["Have a question for us? Call us, or send a quick request.", "Like what you see? Call us, or send a quick request.", "Tell us what you have in mind."],
    ]);
  });

  it("asks about anything not listed, so a plural or punctuated business type needs no grammar from the owner", () => {
    for (const type of ["Movers", "Pet sitting co.", "Event planners"]) {
      const classic = sitePages(input("other", type), "refined").find((p) => p.page === "services")?.html ?? "";
      expect({ type, ask: askLine(parsed("other", type).facts), shown: texts(classic).includes("Ask us about anything not listed."), services: classic.includes(`${type} services`) }).toEqual({ type, ask: "Ask us about anything not listed.", shown: true, services: false });
    }
  });

  it("capitalises a lowercase business type where it starts a line, heading or sentence, and keeps it as typed inside one", () => {
    const doc = parsed("other", "bakery");
    expect([tradeLabel(doc.facts), needQuestion(doc.facts), needLine(doc.facts), pageTitle(doc)]).toEqual(["Bakery", "Bakery in Austin?", "Bakery in Austin?", "Reliable Rooter | Bakery in Austin, TX"]);
    expect(pageDescription(doc, "gallery")).toBe("Photos of recent work by Reliable Rooter, bakery in Austin, TX.");
    for (const design of DESIGN_IDS) {
      const starts = sitePages(input("other", "bakery"), design).flatMap((p) => texts(p.html).filter((text) => /^bakery\b/i.test(text)));
      expect({ design, some: starts.length > 0, lowercase: starts.filter((text) => text.startsWith("bakery")) }).toEqual({ design, some: true, lowercase: [] });
    }
  });

  it("describes the Services page as IT services, Legal services, or services from the business with the owner's type after its name", () => {
    expect([parsed("plumbing"), parsed("it"), parsed("law"), parsed("other", "Movers")].map((doc) => pageDescription(doc, "services"))).toEqual([
      "Plumbing services from Reliable Rooter in Austin, TX. Call (512) 555-0142.",
      "IT services from Reliable Rooter in Austin, TX. Call (512) 555-0142.",
      "Legal services from Reliable Rooter in Austin, TX. Call (512) 555-0142.",
      "Services from Reliable Rooter, Movers in Austin, TX. Call (512) 555-0142.",
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
