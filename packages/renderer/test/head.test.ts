import { DESIGN_IDS, PAGE_IDS, PAGES, SiteDocument, unbackedClaims, type PageId, type SiteDocumentInput } from "@asksite/site-schema";
import { HtmlValidate, StaticConfigLoader } from "html-validate";
import { describe, expect, it } from "vitest";
import { FIXTURE_SITE_URL, FIXTURES, inDesign, loadFixture, stubStylesheets } from "../../../fixtures/index.ts";
import { escapeText } from "../src/escape.ts";
import { TRADE_LABEL } from "../src/format.ts";
import { clipText, pageTitle, render } from "../src/render.ts";
import { FULL, MINIMAL } from "./support/doc.ts";
import { startTags } from "./support/page-safety.ts";

const OPTIONS = { stylesheets: stubStylesheets(), formAction: "https://forms.example.com/submit", siteUrl: FIXTURE_SITE_URL };
const pagesOf = (input: SiteDocumentInput) => render(input, OPTIONS).pages;
const metaDescription = (page: string) => /<meta name="description" content="([^"]*)">/.exec(page)?.[1];
const title = (page: string) => /<title>([^<]*)<\/title>/.exec(page)?.[1];
const canonicalLinks = (page: string) => startTags(page).filter((t) => t.name === "link");

describe("the head of each page (A16)", () => {
  const byPage = Object.fromEntries(pagesOf(FULL).map((p) => [p.page, p.html])) as Record<PageId, string>;

  it("gives each page its own title: Home's as before, the others 'Label | name'", () => {
    expect(PAGE_IDS.map((id) => title(byPage[id]))).toEqual([
      "Reliable Rooter | Plumbing in Austin, TX",
      "Services | Reliable Rooter",
      "About | Reliable Rooter",
      "Gallery | Reliable Rooter",
      "Contact | Reliable Rooter",
    ]);
  });

  it("gives each page its own description, built from facts, fixed words and (About) the about text", () => {
    expect(PAGE_IDS.map((id) => metaDescription(byPage[id]))).toEqual([
      "Leaks, clogs and water heaters fixed right the first time.",
      "Plumbing services from Reliable Rooter in Austin, TX. Call (512) 555-0142.",
      "We are a family business that treats every home like our own.",
      "Photos of recent work by Reliable Rooter, Plumbing in Austin, TX.",
      "Contact Reliable Rooter in Austin, TX for a quote, or call (512) 555-0142.",
    ]);
  });

  it("writes one self-referencing canonical right after the description, and nothing else in a <link>", () => {
    for (const id of PAGE_IDS) {
      const url = `${FIXTURE_SITE_URL}${PAGES[id].path.slice(1)}`;
      expect(byPage[id]).toContain(`<meta name="description" content="${metaDescription(byPage[id])}">\n<link rel="canonical" href="${url}">\n`);
      expect(canonicalLinks(byPage[id]).map((t) => t.attributes.map((a) => a.name))).toEqual([["rel", "href"]]);
    }
  });

  it("states the business once, on Home, with its url; the FAQ once, on Services", () => {
    const ld = (page: string) => [...page.matchAll(/<script type="application\/ld\+json">([^<]*)<\/script>/g)].map((m) => JSON.parse(m[1] ?? "null") as Record<string, unknown>);
    expect(ld(byPage.home).map((b) => [b["@type"], b["url"]])).toEqual([["Plumber", FIXTURE_SITE_URL]]);
    expect(ld(byPage.services).map((b) => b["@type"])).toEqual(["FAQPage"]);
    for (const id of ["about", "gallery", "contact"] as const) expect(ld(byPage[id])).toEqual([]);
  });

  it("leaves FAQPage out when there is no FAQ", () => {
    expect(pagesOf(MINIMAL).some((p) => p.html.includes("FAQPage"))).toBe(false);
  });

  it.each(DESIGN_IDS)("keeps every title and description of every fixture unique and short, in the %s design", (design) => {
    for (const name of FIXTURES) {
      const pages = pagesOf(inDesign(loadFixture(name), design));
      const titles = pages.map((p) => title(p.html) ?? "");
      const descriptions = pages.map((p) => metaDescription(p.html) ?? "");
      expect({ name, unique: new Set(titles).size, count: pages.length }).toEqual({ name, unique: pages.length, count: pages.length });
      expect({ name, unique: new Set(descriptions).size }).toEqual({ name, unique: pages.length });
      expect(titles.filter((t) => t.length > 70)).toEqual([]); // the title is read from the escaped markup
      expect(descriptions.filter((d) => d.length > 0 && escapeUnescaped(d).length > 160)).toEqual([]);
    }
  });
});

/** The raw text of an escaped attribute value, for counting characters. */
const escapeUnescaped = (text: string) => text.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'");

// STRICT (honesty): the fixed words the renderer adds, and the title and description templates, state no credential,
// licence, insurance, 24/7 or free offer, because no owner fact backs them.
describe("the words the renderer adds claim nothing (A16)", () => {
  const facts = SiteDocument.parse(MINIMAL).facts;
  expect([facts.licences, facts.insured, facts.emergency247, facts.freeEstimates]).toEqual([[], false, false, false]);

  it("passes unbackedClaims with facts that back nothing", () => {
    const fixed = ["Our services", "More about our services", "Get in touch", "Get a quote", "Call", "Our work", ...PAGE_IDS.map((id) => PAGES[id].label)];
    const filled = Object.values(TRADE_LABEL).flatMap((trade) => [
      `${trade} services from Mop in Austin, TX. Call (512) 555-0199.`,
      `Photos of recent work by Mop, ${trade} in Austin, TX.`,
      `Contact Mop in Austin, TX for a quote, or call (512) 555-0199.`,
      `Mop | ${trade} in Austin, TX`,
      ...PAGE_IDS.slice(1).map((id) => `${PAGES[id].label} | Mop`),
    ]);
    expect([...fixed, ...filled].flatMap((text) => unbackedClaims(text, facts).map((word) => `${text}: ${word}`))).toEqual([]);
  });

  it.each(DESIGN_IDS)("writes in every page of every fixture only its title and description template (the about text clipped), in the %s design", (design) => {
    for (const name of FIXTURES) {
      const doc = SiteDocument.parse(inDesign(loadFixture(name), design));
      for (const page of pagesOf(doc)) {
        const label = PAGES[page.page].label;
        if (page.page !== "home") {
          expect((title(page.html) ?? "").startsWith(`${label} | `)).toBe(true);
          const name = escapeText(doc.facts.businessName);
          expect(`${title(page.html)}`.endsWith(name) || `${title(page.html)}`.endsWith("…")).toBe(true);
        }
        const description = escapeUnescaped(metaDescription(page.html) ?? "");
        if (page.page === "about") expect(doc.copy.about?.startsWith(description.replace(/…$/, ""))).toBe(true);
        if (page.page === "home") expect(description).toBe(doc.copy.heroSubheadline);
      }
    }
  });
});

// STRICT: a clipped title or description is still valid, escaped markup and splits no character.
describe("clipping (A16)", () => {
  const htmlValidate = new HtmlValidate(new StaticConfigLoader({ extends: ["html-validate:recommended"], rules: { "tel-non-breaking": ["error", { ignoreClasses: ["whitespace-nowrap"] }] } }));
  const withName = (businessName: string, about?: string): SiteDocumentInput => ({ ...FULL, facts: { ...FULL.facts, businessName }, copy: { ...FULL.copy, ...(about === undefined ? {} : { about }) } });
  const noLoneSurrogate = (text: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);

  it("cuts at a word boundary when it can: whole words, then an ellipsis", () => {
    const fits = (text: string) => text.length <= 15;
    expect(clipText("Short name", fits)).toBe("Short name");
    expect(clipText("Alpha Bravo Charlie", fits)).toBe("Alpha Bravo…");
    expect(clipText("Alpha Bravo Cha", fits)).toBe("Alpha Bravo Cha");
    expect(clipText("Alphabravocharliedeltaecho", fits)).toBe("Alphabravochar…");
    expect(clipText("Alphabravocharliedelta Echo", fits)).toBe("Alphabravochar…");
    expect(clipText("  X", () => false)).toBe("…");
  });

  it("measures the escaped title: a name made mostly of & is clipped to fit 70 escaped characters, never inside an entity", async () => {
    const name = `${"&".repeat(30)} Plumbing ${"&".repeat(20)}`;
    const doc = SiteDocument.parse(withName(name));
    for (const id of PAGE_IDS) {
      const text = pageTitle(doc, id);
      expect(escapeText(text).length).toBeLessThanOrEqual(70);
      expect(text.endsWith("…")).toBe(true);
    }
    expect(pageTitle(doc, "services")).toBe(`Services | ${"&".repeat(11)}…`);
    for (const page of pagesOf(doc)) {
      expect(title(page.html)).not.toMatch(/&(?!(?:amp|lt|gt|quot|#39);)/);
      expect((await htmlValidate.validateString(page.html)).valid).toBe(true);
    }
  });

  it("never splits an emoji at the cut", async () => {
    const name = `${"X".repeat(57)}\u{1F44D}\u{1F3FD}Z`; // 57 letters, then thumbs-up with a skin tone (one character, 4 code units)
    const doc = SiteDocument.parse(withName(name));
    const services = pageTitle(doc, "services");
    expect(services).toBe(`Services | ${"X".repeat(57)}…`);
    for (const id of PAGE_IDS) expect(noLoneSurrogate(pageTitle(doc, id))).toBe(true);
    const family = `${"Y".repeat(54)}\u{1F468}‍\u{1F469}‍\u{1F467}`; // a ZWJ family: one character, 8 code units
    const clipped = pageTitle(SiteDocument.parse(withName(family)), "services");
    expect(clipped) // 11 + 54 + 8 = 73 > 70, so the whole family goes.toBe(`Services | ${"Y".repeat(54)}…`);
    for (const page of pagesOf(doc)) expect((await htmlValidate.validateString(page.html)).valid).toBe(true);
  });

  it("clips a 200-character about text with no space at a grapheme boundary, to 160 characters with the ellipsis", async () => {
    const about = "a".repeat(200);
    const doc = withName("Reliable Rooter", about);
    const aboutPage = pagesOf(doc).find((p) => p.page === "about")!;
    expect(metaDescription(aboutPage.html)).toBe(`${"a".repeat(159)}…`);
    const emoji = pagesOf(withName("Reliable Rooter", `${"b".repeat(158)}\u{1F44D}\u{1F3FD}${"c".repeat(40)}`)).find((p) => p.page === "about")!;
    expect(metaDescription(emoji.html)).toBe(`${"b".repeat(158)}…`);
    expect((await htmlValidate.validateString(aboutPage.html)).valid).toBe(true);
  });

  it("escapes a clipped description: markup in the about text stays text", () => {
    const about = `${"<b>".repeat(30)} ${"&".repeat(100)}`;
    const aboutPage = pagesOf(withName("Reliable Rooter", about)).find((p) => p.page === "about")!;
    expect(aboutPage.html).toContain('<meta name="description" content="&lt;b&gt;');
    expect(metaDescription(aboutPage.html)).not.toMatch(/[<>]/);
  });

  it("clips a long description made of facts: the whole description, never the phone's digits cut apart", () => {
    const doc = SiteDocument.parse({ ...FULL, facts: { ...FULL.facts, businessName: "N".repeat(60), location: { city: "C".repeat(40), state: "TX" } } });
    for (const id of ["services", "gallery", "contact"] as const) {
      const text = escapeUnescaped(metaDescription(pagesOf(doc).find((p) => p.page === id)!.html) ?? "");
      expect(text.length).toBeLessThanOrEqual(160);
    }
  });
});
