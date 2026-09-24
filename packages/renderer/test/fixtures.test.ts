import { SiteDocument } from "@asksite/site-schema";
import { formatterFactory, HtmlValidate, StaticConfigLoader } from "html-validate";
import { describe, expect, it } from "vitest";
import { FIXTURES, loadFixture, renderFixture } from "../../../fixtures/index.ts";
import { loadCompiledCss, missingClasses } from "./support/css-classes.ts";

// Golden files hold markup only; the real stylesheet would add ~30 KB of noise to every diff.
const STUB_CSS = "/* site.css */";

// html-validate's recommended rules. tel-non-breaking is satisfied with CSS instead of
// &nbsp;/&#8209; entities: every tel: link carries whitespace-nowrap, so it cannot wrap.
const htmlValidate = new HtmlValidate(
  new StaticConfigLoader({
    extends: ["html-validate:recommended"],
    rules: { "tel-non-breaking": ["error", { ignoreClasses: ["whitespace-nowrap"] }] },
  }),
);

const sectionIds = (html: string) => [...html.matchAll(/<section id="([a-z-]+)"/g)].map((m) => m[1]);

describe.each(FIXTURES)("fixture %s", (name) => {
  it("is a valid SiteDocument", () => {
    expect(SiteDocument.safeParse(loadFixture(name)).success).toBe(true);
  });

  it("matches its golden HTML", async () => {
    await expect(renderFixture(name, STUB_CSS)).toMatchFileSnapshot(`../../../fixtures/golden/${name}.html`);
  });

  it("passes html-validate (recommended)", async () => {
    const report = await htmlValidate.validateString(renderFixture(name, STUB_CSS));
    if (!report.valid) console.log(formatterFactory("text")(report.results));
    expect(report.valid).toBe(true);
  });

  it("uses only classes that exist in the compiled stylesheet", () => {
    const css = loadCompiledCss();
    expect(missingClasses(renderFixture(name, css), css)).toEqual([]);
  });
});

describe("html-validate catches broken markup (RED proof)", () => {
  it("rejects a mis-nested page", async () => {
    const report = await htmlValidate.validateString(
      "<!DOCTYPE html><html lang=\"en\"><head><title>x</title></head><body><div><p>x</span></body></html>",
    );
    expect(report.valid).toBe(false);
  });
});

describe("content resilience", () => {
  it("minimal: hides every section that has no owner content", () => {
    const html = renderFixture("cleaning-minimal", STUB_CSS);
    expect(sectionIds(html)).toEqual(["top", "services", "service-area", "contact"]);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("FAQPage");
    expect(html).not.toContain("Credentials");
  });

  it("extreme: renders every item at maximum length and count", () => {
    const html = renderFixture("roofing-extreme", STUB_CSS);
    expect(sectionIds(html)).toEqual(["top", "credentials", "services", "reviews", "our-work", "about", "service-area", "faq", "contact"]);
    expect(html.match(/From \$100,000/g)).toHaveLength(12);
    expect(html.match(/<figure class="flex w-full flex-col/g)).toHaveLength(12);
    expect(html.match(/loading="lazy"/g)).toHaveLength(12);
    expect(html.match(/<details class="group" name="faq"/g)).toHaveLength(8);
    expect(html.match(/<li class="max-w-full rounded-full border/g)).toHaveLength(30);
    expect(html).toContain(">NORTHRICHLANDHILLSWATAUGAHALTOMCITYAREAS</li>");
    expect(html).toContain(">Unbelievablyweathertightroofreplacements for every hailstorm across North Texas!</h1>");
    expect(html).toContain("<title>Longhorn Storm Restoration Roofing, Gutters, Siding &amp; Window</title>");
  });
});
