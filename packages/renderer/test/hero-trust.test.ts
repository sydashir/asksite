import { describe, expect, it } from "vitest";
import { renderHero } from "../src/sections/hero.ts";
import { renderTrust } from "../src/sections/trust.ts";
import { FULL, makeContext, MINIMAL } from "./support/doc.ts";

describe("hero", () => {
  const full = makeContext(FULL);

  it("builds the tagline and badge from facts, and the h1 from copy", () => {
    const out = String(renderHero(full, "photo"));
    expect(out).toContain(">Plumbing · Austin, TX · Since 1998</p>");
    expect(out).toContain(">24/7 emergency service</p>");
    expect(out).toContain(">Fast, friendly plumbing across Austin</h1>");
    expect(out.match(/<h1/g)).toHaveLength(1);
  });

  it("offers a call button from facts and a quote button to #contact", () => {
    const out = String(renderHero(full, "centered"));
    expect(out).toContain('href="tel:+15125550142"');
    expect(out).toContain("Call (512) 555-0142</a>");
    expect(out).toContain('href="#contact">Get a free quote</a>');
  });

  it("drops the quote button when there is no contact section", () => {
    const noContact = { ...full, sections: full.sections.filter((s) => s.id !== "contact") };
    expect(String(renderHero(noContact, "centered"))).not.toContain('href="#contact"');
  });

  it("shows the hero photo only in the photo variant", () => {
    expect(String(renderHero(full, "photo"))).toContain(
      'src="https://images.example.com/van.jpg" width="1600" height="900" alt="Our service van"',
    );
    expect(String(renderHero(full, "centered"))).not.toContain("<img");
  });

  it("falls back to text only when the photo variant has no photo", () => {
    const out = String(renderHero(makeContext(MINIMAL), "photo"));
    expect(out).not.toContain("<img");
    expect(out).not.toContain("emergency");
    expect(out).toContain(">Cleaning · Austin, TX</p>");
  });
});

describe("trust strip", () => {
  it("lists only owner facts, licences exactly as entered", () => {
    const out = String(renderTrust(makeContext(FULL), "band"));
    expect(out).toContain(">Texas master plumber: M-40123</span>");
    expect(out).toContain(">Insured</span>");
    expect(out).toContain(">In business since 1998</span>");
    expect(out).toContain(">24/7 emergency service</span>");
    expect(out).toContain('class="bg-dark text-white"');
    expect(out).not.toMatch(/bonded/i);
  });

  it("has a light variant", () => {
    expect(String(renderTrust(makeContext(FULL), "light"))).toContain('class="border-y border-gray-200 bg-page text-heading"');
  });

  it("shows a single item when only one credential exists", () => {
    const ctx = makeContext({ ...MINIMAL, facts: { ...MINIMAL.facts, insured: true } });
    expect(String(renderTrust(ctx, "band")).match(/<li /g)).toHaveLength(1);
  });
});
