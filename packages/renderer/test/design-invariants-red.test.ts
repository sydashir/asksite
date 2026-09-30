import { SiteDocument } from "@asksite/site-schema";
import { describe, expect, it, vi } from "vitest";
import { FIXTURE_FORM_ACTION, inDesign, loadFixture, stubStylesheets } from "../../../fixtures/index.ts";
import { BASELINE } from "../src/baseline.ts";
import { DESIGNS } from "../src/designs/index.ts";
import { render, renderDocument } from "../src/render.ts";
import { invariantProblems } from "./support/design-invariants.ts";
import { pageSafetyProblems } from "./support/page-safety.ts";

// RED proof (A12): three broken designs, swapped into the registry that render() dispatches through,
// are each caught by the checks every real design must pass.
vi.mock("../src/designs/index.ts", async () => {
  const { BASELINE } = await import("../src/baseline.ts");
  const { html, trusted, SafeHtml } = await import("../src/html.ts");
  return {
    DESIGNS: {
      // Writes the business name through trusted(), so it is not escaped.
      impact: { ...BASELINE, header: (ctx) => html`${trusted(`<p>${ctx.doc.facts.businessName}</p>`)}${BASELINE.header(ctx)}` },
      // Drops `required` from the name field.
      refined: {
        ...BASELINE,
        section: (ctx, section) => new SafeHtml(String(BASELINE.section(ctx, section)).replace('autocomplete="name" required', 'autocomplete="name"')),
      },
      // Adds a second <aside>.
      modern: { ...BASELINE, footer: (ctx) => html`${BASELINE.footer(ctx)}\n<aside aria-label="Opening hours"><p>Open today</p></aside>` },
    } satisfies typeof DESIGNS,
  };
});

const OPTIONS = { stylesheets: stubStylesheets(), formAction: FIXTURE_FORM_ACTION };

describe("broken designs are caught (RED proof)", () => {
  it("copy written through trusted() fails the page-safety check", () => {
    const page = render(inDesign(loadFixture("electrical-xss"), "impact"), OPTIONS).html;
    expect(pageSafetyProblems(page)).toEqual(expect.arrayContaining(["url src=x", "handler onerror"]));
  });

  it.each([
    ["refined", "a dropped required", "the contact form differs from today's (classes aside)"],
    ["modern", "a second <aside>", "2 <aside> elements"],
  ] as const)("the %s stub with %s fails the shared invariants", (design, _, problem) => {
    const input = inDesign(loadFixture("plumber-austin"), design);
    const doc = SiteDocument.parse(input);
    const page = render(input, OPTIONS).html;
    expect(invariantProblems(page, renderDocument(doc, BASELINE, OPTIONS).html, doc, DESIGNS[design])).toContain(problem);
  });
});
