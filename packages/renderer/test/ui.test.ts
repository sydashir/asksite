import { describe, expect, it } from "vitest";
import { html } from "../src/html.ts";
import { headline, sectionShell } from "../src/ui.ts";
import { classesIn, hasClassSelector, loadCompiledCss, missingClasses } from "./support/css-classes.ts";

const css = loadCompiledCss();

describe("headline", () => {
  it("renders an escaped h2 with an id for aria-labelledby, and an optional subtitle", () => {
    const out = String(headline("services", "Pipes & <drains>", "We fix them"));
    expect(out).toContain('<h2 id="services-title"');
    expect(out).toContain(">Pipes &amp; &lt;drains&gt;</h2>");
    expect(out).toContain(">We fix them</p>");
    expect(String(headline("faq", "Questions"))).not.toContain("<p");
  });
});

describe("sectionShell", () => {
  it("wraps content in a labelled section with the chosen width", () => {
    const out = String(sectionShell("faq", "6xl", html`<p>x</p>`));
    expect(out).toMatch(/^<section id="faq" aria-labelledby="faq-title">/);
    expect(out).toContain("max-w-6xl");
  });
});

describe("compiled stylesheet", () => {
  it("defines every class the shared UI uses", () => {
    const markup = String(sectionShell("a", "7xl", headline("a", "T", "S"))) + String(sectionShell("b", "6xl", html``));
    expect(classesIn(markup).length).toBeGreaterThan(10);
    expect(missingClasses(markup, css)).toEqual([]);
  });

  it("points theme utilities at the per-site custom properties", () => {
    expect(css).toContain(".text-muted{color:var(--aw-color-text-muted)}");
    expect(css).toContain(".font-heading{font-family:var(--aw-font-heading)}");
    expect(css).toContain("--default-font-family:var(--aw-font-sans)");
  });

  it("detects a class that was built by string concatenation (RED proof)", () => {
    const shade = 700;
    expect(missingClasses(`<p class="text-red-${shade} text-muted"></p>`, css)).toEqual(["text-red-700"]);
  });

  it("does not accept a longer class as proof that a shorter one exists", () => {
    expect(hasClassSelector(css, "md:px-6")).toBe(true);
    expect(hasClassSelector(css, "md:px")).toBe(false);
  });
});
