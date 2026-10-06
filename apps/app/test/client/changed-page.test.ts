import { render } from "@asksite/renderer";
import { DESIGN_IDS, SiteDocument, type DesignId, type PageId } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { FIXTURE_FORM_ACTION, FIXTURE_SITE_URL, inDesign, loadFixture, type FixtureName, stubStylesheets } from "../../../../fixtures/index.ts";
import { changedPage } from "../../src/client/lib/changed-page.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const draw = (doc: SiteDocument) => render(doc, { stylesheets: stubStylesheets(), formAction: FIXTURE_FORM_ACTION, siteUrl: FIXTURE_SITE_URL }).pages;

/** The page a change to ONE fact shows on, read from what the real renderer draws for the fixture before and after. */
function pageAfter(design: DesignId, change: (doc: Json) => void, fixture: FixtureName = "plumber-austin"): PageId | null {
  const base = structuredClone(inDesign(loadFixture(fixture), design)) as Json;
  const edited = structuredClone(base);
  change(edited);
  const before = SiteDocument.parse(base);
  const after = SiteDocument.parse(edited);
  return changedPage(draw(before), draw(after), after);
}

// The field-to-page table. Each answer is what the renderer draws (never a second map): the first page whose own sections changed,
// Home first. null = only the shared header or footer (or nothing) changed, so the preview stays where it is.
const TABLE: Array<[string, (doc: Json) => void, PageId | null, FixtureName?]> = [
  ["businessName", (d) => (d.facts.businessName = "Reliable Rooter Plumbers"), "about"],
  ["trade", (d) => (d.facts.trade = "hvac"), "home"],
  ["phone", (d) => (d.facts.phone = "+15125550199"), "home"],
  ["email", (d) => (d.facts.email = "hello@reliablerooter.example.com"), "contact"],
  ["location.city", (d) => (d.facts.location.city = "Round Rock"), "home"],
  ["serviceArea.places", (d) => d.facts.serviceArea.places.push("Pflugerville"), "contact"],
  ["hours", (d) => (d.facts.hours[0].opens = "07:00"), "contact"],
  ["services[0].name", (d) => ((d.facts.services[0].name = "Drain rescue"), (d.copy.serviceDescriptions[0].service = "Drain rescue")), "services"],
  ["licences", (d) => (d.facts.licences[0].number = "TX 999999"), "home"],
  ["insured", (d) => (d.facts.insured = false), "home"],
  ["yearFounded", (d) => (d.facts.yearFounded = 2001), "home"],
  ["emergency247", (d) => (d.facts.emergency247 = true), "home", "cleaning-minimal"],
  ["testimonials", (d) => (d.facts.testimonials[0].quote = "Fast and fair."), "home"],
  ["heroPhoto", (d) => (d.facts.heroPhoto.alt = "A van at a customer's house"), "home"],
  ["photos", (d) => (d.facts.photos[0].alt = "A new water heater"), "gallery"],
  ["socialLinks", (d) => d.facts.socialLinks.pop(), null],
];

describe("changedPage: the page a Details or Photos change shows on", () => {
  for (const design of DESIGN_IDS) {
    it.each(TABLE)(`${design}: %s`, (_field, change, expected, fixture) => {
      expect(pageAfter(design, change, fixture)).toBe(expected);
    });
  }
});
