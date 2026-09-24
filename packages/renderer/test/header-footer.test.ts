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

  it("links only to visible sections, in page order", () => {
    const hrefs = [...out.matchAll(/<li><a class="inline-flex[^"]*" href="(#[a-z-]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(["#services", "#reviews", "#our-work", "#about", "#service-area", "#faq", "#contact"]);
    const minimal = String(renderHeader(makeContext(MINIMAL)));
    const minimalHrefs = [...minimal.matchAll(/<li><a class="inline-flex[^"]*" href="(#[a-z-]+)"/g)].map((m) => m[1]);
    expect(minimalHrefs).toEqual(["#services", "#service-area", "#contact"]);
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
  it("is a phone-only sticky tel: button in its own landmark", () => {
    const out = String(renderCallBar(makeContext(FULL)));
    expect(out).toMatch(/^<aside aria-label="Call us" class="sticky bottom-0 /);
    expect(out).toContain("sticky bottom-0");
    expect(out).toContain("md:hidden");
    expect(out).toContain("focus-outside:static");
    expect(out).toContain('href="tel:+15125550142"');
    expect(out).toContain("Call (512) 555-0142</a>");
  });
});
