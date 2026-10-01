import { DESIGN_IDS, SiteDocument } from "@asksite/site-schema";
import { describe, expect, it, vi } from "vitest";
import { FIXTURE_SITE_URL, inDesign, stubStylesheets } from "../../../fixtures/index.ts";
import { render } from "../src/index.ts";
import { FULL } from "./support/doc.ts";

// In A12-0 every design is today's page, so this swaps in three distinct stub designs to prove render()
// draws each page with every part of its own design (A12 §5) and of no other.
vi.mock("../src/designs/index.ts", async () => {
  const { BASELINE } = await import("../src/baseline.ts");
  const { html } = await import("../src/html.ts");
  const { DESIGN_IDS } = await import("@asksite/site-schema");
  const stub = (id: string) => ({
    ...BASELINE,
    attribution: `<!-- the ${id} design -->`,
    bodyClass: `page-${id}`,
    variables: (theme: { palette: string }) => ({ [`--aw-${id}-palette`]: theme.palette }),
    header: (ctx: Parameters<typeof BASELINE.header>[0]) => html`<p>${id} header</p>${BASELINE.header(ctx)}`,
    section: (...args: Parameters<typeof BASELINE.section>) => html`<p>${id} ${args[1].id}</p>${BASELINE.section(...args)}`,
    servicesTeaser: (ctx: Parameters<typeof BASELINE.servicesTeaser>[0]) => html`<p>${id} teaser</p>${BASELINE.servicesTeaser(ctx)}`,
    closingBand: (ctx: Parameters<typeof BASELINE.closingBand>[0]) => html`<p>${id} closing band</p>${BASELINE.closingBand(ctx)}`,
    footer: (ctx: Parameters<typeof BASELINE.footer>[0]) => html`<p>${id} footer</p>${BASELINE.footer(ctx)}`,
    callBar: (ctx: Parameters<typeof BASELINE.callBar>[0]) => html`<p>${id} call bar</p>${BASELINE.callBar(ctx)}`,
  });
  return { DESIGNS: Object.fromEntries(DESIGN_IDS.map((id) => [id, stub(id)])) };
});

const OPTIONS = { stylesheets: stubStylesheets(), formAction: "https://forms.example.com/submit", siteUrl: FIXTURE_SITE_URL };

describe("render() dispatches through the design registry (A12)", () => {
  it.each(DESIGN_IDS)("draws a %s page with every part of that design and none of another", (design) => {
    const doc = inDesign(FULL, design);
    const site = render(doc, OPTIONS);
    const html = site.pages[0]!.html;
    const palette = SiteDocument.parse(doc).theme.palette;
    expect(html).toContain(`<!-- the ${design} design -->`);
    expect(html).toContain(`<body data-design="${design}" class="page-${design}">`);
    expect(html).toContain(`--aw-${design}-palette:${palette};}</style>`);
    for (const part of ["header", "hero", "teaser", "closing band", "footer", "call bar"]) expect(html).toContain(`<p>${design} ${part}</p>`);
    // Every page of the site is drawn by the design: the other pages' sections, and no closing band on Contact.
    const contact = site.pages.find((p) => p.page === "contact")!.html;
    expect(contact).toContain(`<p>${design} contact</p>`);
    expect(contact).not.toContain("closing band");
    for (const page of site.pages) {
      for (const other of DESIGN_IDS.filter((id) => id !== design)) expect(page.html).not.toContain(`<p>${other} `);
    }
  });
});
