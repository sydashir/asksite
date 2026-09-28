import { readFileSync } from "node:fs";
import type { SiteDocumentInput } from "@asksite/site-schema";
import { render } from "@asksite/renderer";

/** Sample trades businesses. Each is a SiteDocument JSON file in this folder. */
export const FIXTURES = ["plumber-austin", "hvac-phoenix", "roofing-extreme", "cleaning-minimal", "electrical-xss"] as const;
export type FixtureName = (typeof FIXTURES)[number];

/** Placeholder form endpoint for fixtures; the real one arrives with plan 2. */
export const FIXTURE_FORM_ACTION = "https://forms.example.com/submit";

export function loadFixture(name: FixtureName): SiteDocumentInput {
  return JSON.parse(readFileSync(new URL(`./${name}.json`, import.meta.url), "utf8")) as SiteDocumentInput;
}

/** The shared stylesheet compiled by `pnpm build:css`. */
export function loadStylesheet(): string {
  return readFileSync(new URL("../packages/renderer/styles/out/baseline.css", import.meta.url), "utf8");
}

export function renderFixture(name: FixtureName, stylesheet: string = loadStylesheet()): string {
  return render(loadFixture(name), { stylesheet, formAction: FIXTURE_FORM_ACTION });
}
