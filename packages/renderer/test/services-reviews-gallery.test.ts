import { describe, expect, it } from "vitest";
import { renderGallery } from "../src/sections/gallery.ts";
import { renderServices } from "../src/sections/services.ts";
import { renderTestimonials } from "../src/sections/testimonials.ts";
import { FULL, makeContext, MINIMAL } from "./support/doc.ts";

const services = (count: number) => Array.from({ length: count }, (_, i) => ({ name: `Service ${String.fromCharCode(65 + i)}` }));
const withServices = (count: number) =>
  makeContext({
    ...FULL,
    facts: { ...FULL.facts, services: services(count) },
    copy: { ...FULL.copy, serviceDescriptions: services(count).map((s) => ({ service: s.name, description: "A careful job." })) },
  });

describe("services", () => {
  it("takes names and prices from facts and descriptions from copy", () => {
    const out = String(renderServices(makeContext(FULL), "cards"));
    expect(out).toContain(">Drain cleaning</h3>");
    expect(out).toContain(">From $89</p>");
    expect(out).toContain(">From $1,250</p>");
    expect(out).toContain(">We clear stubborn drains without tearing up your yard.</p>");
    expect(out.match(/From \$/g)).toHaveLength(2);
    expect(out).toContain('<h2 id="services-title"');
    expect(out).toContain(">Everything from dripping taps to new water heaters.</p>");
  });

  it.each([
    [1, "mx-auto grid max-w-xl grid-cols-1 gap-6"],
    [2, "grid grid-cols-1 gap-6 sm:grid-cols-2"],
    [3, "grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3"],
    [4, "grid grid-cols-1 gap-6 sm:grid-cols-2"],
    [12, "grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3"],
  ])("lays out %i services with %j", (count, grid) => {
    const out = String(renderServices(withServices(count), "cards"));
    expect(out).toContain(`<ul class="${grid}">`);
    expect(out.match(/<li /g)).toHaveLength(count);
  });

  it("has a compact two-column list variant", () => {
    const out = String(renderServices(withServices(12), "compact"));
    expect(out).toContain('<ul class="mx-auto grid max-w-5xl grid-cols-1 gap-x-12 gap-y-8 sm:grid-cols-2">');
    expect(out.match(/<h3 /g)).toHaveLength(12);
  });
});

describe("testimonials", () => {
  it("renders owner quotes with names as escaped text, under a heading with no AI subtitle", () => {
    const out = String(renderTestimonials(makeContext(FULL), "grid"));
    expect(out).toContain(">What customers say</h2>\n\n</div>");
    expect(out).toContain(">Fixed our burst pipe the same night.</p></blockquote>");
    expect(out).toContain(">Dana P.</p>");
    expect(out).toContain(">Round Rock, TX</p>");
    expect(out).toContain('<ul class="grid grid-cols-1 gap-6 sm:grid-cols-2">');
  });

  it("uses CSS columns for the masonry variant once there are 3+ reviews", () => {
    const three = [
      { quote: "Fixed our burst pipe the same night.", name: "Dana P." },
      { quote: "Honest price and a tidy crew.", name: "Luis M." },
      { quote: "Great.", name: "Kim" },
    ];
    const out = String(renderTestimonials(makeContext({ ...FULL, facts: { ...FULL.facts, testimonials: three } }), "masonry"));
    expect(out).toContain('<ul class="columns-1 gap-6 sm:columns-2 lg:columns-3">');
    expect(out).toContain('<li class="mb-6 flex break-inside-avoid">');
  });
});

describe("gallery", () => {
  it("is a zero-JS grid of lazy-loaded owner photos", () => {
    const out = String(renderGallery(makeContext(FULL), "grid"));
    expect(out).toContain('src="https://images.example.com/p1.jpg" width="1200" height="900" alt="New water heater in a garage" loading="lazy"');
    expect(out).toContain(">Water heater swap</figcaption>");
    expect(out.match(/<figcaption/g)).toHaveLength(1);
    for (const forbidden of ["<script", "<dialog", "<button", "aw-gallery"]) expect(out).not.toContain(forbidden);
  });

  it("adapts the grid to one photo", () => {
    const photo = { url: "https://images.example.com/one.jpg", alt: "Finished patio", width: 1200, height: 900 };
    const one = makeContext({ ...MINIMAL, facts: { ...MINIMAL.facts, photos: [photo] } });
    expect(String(renderGallery(one, "grid"))).toContain('<ul class="mx-auto grid max-w-3xl grid-cols-1 gap-4">');
  });
});
