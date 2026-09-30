import { DESIGN_IDS, SiteDocument } from "@asksite/site-schema";
import { describe, expect, it, vi } from "vitest";
import { inDesign, stubStylesheets } from "../../../fixtures/index.ts";
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
    footer: (ctx: Parameters<typeof BASELINE.footer>[0]) => html`<p>${id} footer</p>${BASELINE.footer(ctx)}`,
    callBar: (ctx: Parameters<typeof BASELINE.callBar>[0]) => html`<p>${id} call bar</p>${BASELINE.callBar(ctx)}`,
  });
  return { DESIGNS: Object.fromEntries(DESIGN_IDS.map((id) => [id, stub(id)])) };
});

const OPTIONS = { stylesheets: stubStylesheets(), formAction: "https://forms.example.com/submit" };

describe("render() dispatches through the design registry (A12)", () => {
  it.each(DESIGN_IDS)("draws a %s page with every part of that design and none of another", (design) => {
    const doc = inDesign(FULL, design);
    const { html } = render(doc, OPTIONS);
    const palette = SiteDocument.parse(doc).theme.palette;
    expect(html).toContain(`<!-- the ${design} design -->`);
    expect(html).toContain(`<body data-design="${design}" class="page-${design}">`);
    expect(html).toContain(`--aw-${design}-palette:${palette};}</style>`);
    for (const part of ["header", "hero", "contact", "footer", "call bar"]) expect(html).toContain(`<p>${design} ${part}</p>`);
    for (const other of DESIGN_IDS.filter((id) => id !== design)) expect(html).not.toContain(`<p>${other} `);
  });
});
