import { SiteDocument, type SiteDocumentInput } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { pageTitle, render } from "../src/index.ts";
import { FULL, MINIMAL } from "./support/doc.ts";

const OPTIONS = { stylesheet: "/* compiled css */", formAction: "https://forms.example.com/submit" };
const scriptTags = (html: string) => [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);

describe("render", () => {
  const page = render(FULL, OPTIONS);

  it("returns one complete HTML document", () => {
    expect(page.startsWith("<!DOCTYPE html>\n<html lang=\"en\"")).toBe(true);
    expect(page.trimEnd().endsWith("</html>")).toBe(true);
    expect(page.match(/<h1/g)).toHaveLength(1);
    expect(page).toContain("<title>Reliable Rooter | Plumbing in Austin, TX</title>");
    expect(page).toContain('<meta name="description" content="Leaks, clogs and water heaters fixed right the first time.">');
  });

  it("inlines the shared stylesheet and the 12 theme variables", () => {
    expect(page).toContain("<style>/* compiled css */</style>");
    expect(page.match(/--aw-[a-z-]+:/g)).toHaveLength(12);
  });

  it("ships zero JavaScript: the only scripts are JSON-LD", () => {
    const scripts = scriptTags(page);
    expect(scripts).toEqual(['<script type="application/ld+json">', '<script type="application/ld+json">']);
    expect(page).not.toMatch(/\son[a-z]+=/i);
    expect(page).not.toMatch(/javascript:/i);
    expect(page).not.toMatch(/http-equiv/i);
  });

  it("carries the MIT copyright notices in one comment", () => {
    expect(page.match(/<!--/g)).toHaveLength(1);
    expect(page).toContain("<!-- Portions adapted from AstroWind, Copyright (c) 2023 onWidget, and Tabler Icons");
  });

  it("emits FAQPage JSON-LD only when the FAQ section renders", () => {
    expect(page).toContain('"@type":"FAQPage"');
    const minimal = render(MINIMAL, OPTIONS);
    expect(minimal).not.toContain("FAQPage");
    expect(scriptTags(minimal)).toHaveLength(1);
  });

  it("renders sections in layout order, hiding empty ones", () => {
    const ids = [...page.matchAll(/<section id="([a-z-]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["top", "credentials", "services", "reviews", "our-work", "about", "service-area", "faq", "contact"]);
    const minimalIds = [...render(MINIMAL, OPTIONS).matchAll(/<section id="([a-z-]+)"/g)].map((m) => m[1]);
    expect(minimalIds).toEqual(["top", "services", "service-area", "contact"]);
  });

  it("is deterministic", () => {
    expect(render(FULL, OPTIONS)).toBe(page);
  });

  it("re-validates input and refuses bad options", () => {
    expect(() => render({ ...FULL, copy: { ...FULL.copy, heroHeadline: "Call 512-555-0142" } }, OPTIONS)).toThrow();
    expect(() => render(FULL, { ...OPTIONS, formAction: "http://forms.example.com" })).toThrow("Unsafe URL");
    expect(() => render(FULL, { ...OPTIONS, stylesheet: "</style><script>alert(1)</script>" })).toThrow("</style");
  });

  it("falls back to the business name when the title would be too long", () => {
    const long = SiteDocument.parse({ ...FULL, facts: { ...FULL.facts, businessName: "B".repeat(60) } });
    expect(pageTitle(long)).toBe("B".repeat(60));
  });
});

describe("facts and copy stay separate", () => {
  const page = render(FULL, OPTIONS);

  it("takes phone, prices, licences, hours and reviews only from facts", () => {
    const changed: SiteDocumentInput = {
      ...FULL,
      facts: {
        ...FULL.facts,
        phone: "+12125550100",
        services: [{ name: "Drain cleaning", startingPrice: 95 }, { name: "Water heaters" }, { name: "Leak repair" }],
        licences: [{ label: "NYC master plumber", number: "MP-7" }],
        hours: [{ days: ["Monday"], opens: "07:00", closes: "15:00" }],
        testimonials: [{ quote: "Changed quote.", name: "Pat" }],
      },
    };
    const out = render(changed, OPTIONS);
    expect(page).toContain("(512) 555-0142");
    expect(out).not.toContain("(512) 555-0142");
    expect(out).toContain("(212) 555-0100");
    expect(out).toContain("From $95");
    expect(out).not.toContain("From $89");
    expect(out).toContain("NYC master plumber: MP-7");
    expect(out).toContain("7:00 AM – 3:00 PM");
    expect(out).toContain("Changed quote.");
    expect(out).not.toContain("Fixed our burst pipe");
  });

  it("renders the same facts no matter what the copy says", () => {
    const otherCopy = render({ ...FULL, copy: { ...FULL.copy, heroHeadline: "Different words entirely" } }, OPTIONS);
    const facts = (html: string) => [...html.matchAll(/tel:\+\d+|From \$[\d,]+|M-40123/g)].map((m) => m[0]);
    expect(facts(otherCopy)).toEqual(facts(page));
  });
});
