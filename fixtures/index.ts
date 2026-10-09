import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { render, type DesignStylesheets, type RenderedSitePage } from "@asksite/renderer";
import { DESIGN_CSS } from "@asksite/site-css";
import { DESIGN_IDS, type DesignId, type PageId, type SiteDocumentInput } from "@asksite/site-schema";

/** Every design's real compiled stylesheet (@asksite/site-css), for tests that check the real sheets. */
export { DESIGN_CSS };

/**
 * Sample businesses. Each is a SiteDocument JSON file in this folder. The first five serve listed places; the last
 * three are an IT firm that serves the whole country, a law firm and a business of the owner's own type that serves
 * customers worldwide.
 */
export const FIXTURES = ["plumber-austin", "hvac-phoenix", "roofing-extreme", "cleaning-minimal", "electrical-xss", "it-country", "law-denver", "other-worldwide"] as const;
export type FixtureName = (typeof FIXTURES)[number];

/** Placeholder form endpoint for fixtures; the real one arrives with plan 2. */
export const FIXTURE_FORM_ACTION = "https://forms.example.com/submit";

/** Placeholder site origin for fixtures (A16: the canonical base the renderer is given). */
export const FIXTURE_SITE_URL = "https://fixture.asksite.example/";

export function loadFixture(name: FixtureName): SiteDocumentInput {
  return JSON.parse(readFileSync(new URL(`./${name}.json`, import.meta.url), "utf8")) as SiteDocumentInput;
}

/** A document in the given design, or as it is when no design is given. */
export function inDesign(doc: SiteDocumentInput, design?: DesignId): SiteDocumentInput {
  return design === undefined ? doc : { ...doc, theme: { ...doc.theme, design } };
}

/** Stylesheets for tests only: every design gets `css` (or css(design)), with the SHA-256 of its UTF-8 bytes. */
export function stubStylesheets(css: string | ((design: DesignId) => string) = "/* css */"): DesignStylesheets {
  const sheet = (text: string) => Object.freeze({ css: text, sha256: createHash("sha256").update(text, "utf8").digest("hex") });
  return Object.freeze(Object.fromEntries(DESIGN_IDS.map((id) => [id, sheet(typeof css === "string" ? css : css(id))]))) as DesignStylesheets;
}

/** The fixture's pages (Home first), in its own design or the one given, with the real stylesheets unless others are given. */
export function renderFixture(name: FixtureName, stylesheets: DesignStylesheets = DESIGN_CSS, design?: DesignId): readonly RenderedSitePage[] {
  return render(inDesign(loadFixture(name), design), { stylesheets, formAction: FIXTURE_FORM_ACTION, siteUrl: FIXTURE_SITE_URL }).pages;
}

/** One page of the fixture as HTML; throws when the fixture has no such page. */
export function renderFixturePage(name: FixtureName, page: PageId, stylesheets: DesignStylesheets = DESIGN_CSS, design?: DesignId): string {
  const found = renderFixture(name, stylesheets, design).find((p) => p.page === page);
  if (found === undefined) throw new Error(`Fixture ${name} has no ${page} page`);
  return found.html;
}
