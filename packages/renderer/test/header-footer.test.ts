import { describe, expect, it } from "vitest";
import { renderHeader } from "../src/sections/header.ts";
import { renderCallBar, renderFooter } from "../src/sections/footer.ts";
import { FULL, makeContext, MINIMAL } from "./support/doc.ts";

describe("header", () => {
  const out = String(renderHeader(makeContext(FULL)));

  it("shows the business name and a tel: link from facts", () => {
    expect(out).toContain(">Reliable Rooter</a>");
    expect(out).toContain('href="tel:+15125550142" aria-label="Call (512) 555-0142"');
  });

  it("links to every page the site renders, in page order, and no section", () => {
    const hrefs = [...out.matchAll(/<li><a class="inline-flex[^"]*" href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(["/", "/services", "/about", "/gallery", "/contact"]);
    const minimal = String(renderHeader(makeContext(MINIMAL)));
    const minimalLinks = [...minimal.matchAll(/<li><a class="inline-flex[^"]*" href="([^"]+)"[^>]*>([^<]*)</g)].map((m) => `${m[1]} ${m[2]}`);
    expect(minimalLinks).toEqual(["/ Home", "/services Services", "/contact Contact"]);
  });

  it("links the brand to Home, and marks only the current page's link, in the desktop list and the phone menu, with more than colour", () => {
    expect(out).toContain('href="/">Reliable Rooter</a>');
    const services = String(renderHeader(makeContext(FULL, "services")));
    expect(services.match(/ aria-current="page"/g)).toHaveLength(2); // the desktop list and the phone menu
    const current = [...services.matchAll(/<a class="([^"]*)" href="([^"]+)" aria-current="page">([^<]*)</g)];
    expect(current.map((m) => `${m[2]} ${m[3]}`)).toEqual(["/services Services", "/services Services"]);
    for (const m of current) expect(m[1]).toContain("underline");
    expect(out.match(/ aria-current="page"/g)).toHaveLength(2);
    expect(out).toContain('href="/" aria-current="page">Home<');
  });

  it("keeps each desktop nav label on one line, and the links compact below 1280 px", () => {
    const classes = [...out.matchAll(/<li><a class="(inline-flex[^"]*)" href="\//g)].map((m) => (m[1] ?? "").split(" "));
    expect(classes).toHaveLength(5);
    for (const list of classes) expect(list).toEqual(expect.arrayContaining(["whitespace-nowrap", "px-2", "text-sm", "xl:text-base"]));
  });

  it("uses a native <details> menu, not JavaScript", () => {
    expect(out).toContain('<details class="group relative lg:hidden">');
    expect(out).toContain('<span class="sr-only">Menu</span>');
    expect(out).not.toContain("<script");
    expect(out).not.toMatch(/\son[a-z]+=/);
  });
});

describe("footer", () => {
  it("repeats contact details and credentials from facts", () => {
    const out = String(renderFooter(makeContext(FULL)));
    expect(out).toContain(">(512) 555-0142</a>");
    expect(out).toContain('href="mailto:office@example.com"');
    expect(out).toContain("100 Congress Ave, Austin, TX 78701");
    expect(out).toContain("Texas master plumber: M-40123");
    expect(out).toContain('<li class="mb-2">Insured</li>');
    expect(out).toContain('href="https://www.facebook.com/reliablerooter">Facebook</a>');
  });

  it("marks the column titles up as headings", () => {
    const out = String(renderFooter(makeContext(FULL)));
    expect(out).toContain('<h2 class="mb-2 font-medium text-heading">Contact</h2>');
    expect(out).toContain('<h2 class="mb-2 font-medium text-heading">Credentials</h2>');
  });

  it("omits credentials, street address and social links when the owner gave none", () => {
    const out = String(renderFooter(makeContext(MINIMAL)));
    expect(out).not.toContain("Credentials");
    expect(out).not.toContain("Insured");
    expect(out).not.toContain("border-t border-gray-200 py-6");
    expect(out).toContain("Cleaning · Austin, TX");
  });
});

describe("call bar", () => {
  it("is a phone-only sticky bar in its own landmark: Call, and Get a quote to the form", () => {
    const out = String(renderCallBar(makeContext(FULL)));
    expect(out).toMatch(/^<aside aria-label="Call us" class="sticky bottom-0 /);
    expect(out).toContain("sticky bottom-0");
    expect(out).toContain("md:hidden");
    expect(out).toContain("focus-outside:static");
    expect(out).toContain('href="tel:+15125550142"');
    expect(out).toContain('<div class="grid grid-cols-2 gap-2">');
    // The visible word starts the accessible name (WCAG 2.5.3).
    expect(out).toMatch(/<a class="btn-primary whitespace-nowrap" href="tel:\+15125550142" aria-label="Call \(512\) 555-0142"><svg[^>]*>.*<\/svg>Call<\/a>/);
    expect(out).toContain('<a class="btn-secondary" href="/contact#quote">Get a quote</a>');
    expect(out.match(/<aside/g)).toHaveLength(1);
  });
});
