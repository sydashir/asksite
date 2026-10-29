// Bold's About with no photo, no founding year and no credentials ("about--solo"): from 64rem the story sits in the one
// explicit column. The defect (phase 2 audit, boss-real about-desktop.png): .about-body asks for the grid area "body",
// which .about--solo never named, so the story fell into an implicit column beside an empty one. The real layout is
// measured in browsers by about-solo.browser.test.ts (CI); this light check pins the compiled rule.
import { describe, expect, it } from "vitest";
import { DESIGN_CSS } from "../../../../../fixtures/index.ts";
import { render } from "../../../src/render.ts";
import { SOLO_DOC } from "./about-solo-doc.ts";

/** The compiled .about--solo rules inside Bold's 64rem media query. */
function soloRules(css: string): string[] {
  const media = css.indexOf("@media (min-width:64rem)");
  return [...css.matchAll(/\.about--solo\{([^}]*)\}/g)].filter((m) => media !== -1 && m.index > media).map((m) => m[1] ?? "");
}

describe("Bold about--solo (story only)", () => {
  it("is the layout of an About with no photo, no year and no credentials", () => {
    const about = render(SOLO_DOC, { stylesheets: DESIGN_CSS, formAction: "https://forms.example.com/submit", siteUrl: "https://solo.asksite.example/" }).pages.find((p) => p.page === "about");
    expect(about?.html).toContain('class="wrap about about--solo"');
  });

  it("names the one grid area its story asks for, from 64rem", () => {
    const rules = soloRules(DESIGN_CSS.impact.css);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatch(/grid-template-areas:"body"|grid-template:"body"/);
  });
});
