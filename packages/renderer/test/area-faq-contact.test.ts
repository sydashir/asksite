import type { SectionId } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { renderAbout } from "../src/sections/about.ts";
import { renderContact } from "../src/sections/contact.ts";
import { renderFaq } from "../src/sections/faq.ts";
import { renderServiceArea } from "../src/sections/service-area.ts";
import { FULL, makeContext, MINIMAL } from "./support/doc.ts";

/** FULL with `id` ahead of every other section but the hero, so it leads its page. */
const leading = (id: SectionId): typeof FULL => ({ ...FULL, layout: [...FULL.layout.filter((s) => s.id === "hero"), ...FULL.layout.filter((s) => s.id === id), ...FULL.layout.filter((s) => s.id !== "hero" && s.id !== id)] });

// A16: the first section of an inner page draws the page's one <h1>, and its item headings go one level up.
describe("heading levels on an inner page", () => {
  it("about: the page's h1", () => {
    const out = String(renderAbout(makeContext(FULL, "about"), "plain"));
    expect(out).toContain('<h1 id="about-title"');
    expect(out).not.toContain("<h2");
  });

  it("service area and hours: an h1 with h2 items when first on the page, an h2 with h3 items otherwise", () => {
    const first = String(renderServiceArea(makeContext(leading("serviceArea"), "contact"), "split"));
    expect(first).toContain('<h1 id="service-area-title"');
    expect(first).toMatch(/<h2 class="[^"]*">.*Areas we serve<\/h2>/);
    expect(first).toMatch(/<h2 class="[^"]*">.*Hours<\/h2>/);
    expect(first).not.toContain("<h3");
    const second = String(renderServiceArea(makeContext(FULL, "contact"), "split"));
    expect(second).toContain('<h2 id="service-area-title"');
    expect(second).toMatch(/<h3 class="[^"]*">.*Areas we serve<\/h3>/);
  });

  it("faq: questions are h3 under an h2, h2 under the h1", () => {
    for (const variant of ["accordion", "open"] as const) {
      const under = String(renderFaq(makeContext(FULL, "services"), variant));
      expect(under).toContain('<h2 id="faq-title"');
      expect(under).toContain(">Do you charge for estimates?</h3>");
      const first = String(renderFaq(makeContext(leading("faq"), "services"), variant));
      expect(first).toContain('<h1 id="faq-title"');
      expect(first).toContain(">Do you charge for estimates?</h2>");
      expect(first).not.toContain("<h3");
    }
  });

  it("contact: the heading is the h1 when the form leads the page", () => {
    expect(String(renderContact(makeContext(FULL, "contact"), "card"))).toContain('<h1 id="contact-title"');
    expect(String(renderContact(makeContext(FULL), "card"))).toContain('<h2 id="contact-title"');
  });
});

describe("about", () => {
  it("uses the owner's name in the heading and the AI paragraph as text", () => {
    const out = String(renderAbout(makeContext(FULL), "plain"));
    expect(out).toContain(">About Reliable Rooter</h2>");
    expect(out).toContain(">We are a family business that treats every home like our own.</p>");
  });
});

describe("service area and hours", () => {
  it("lists places, the street address and a full week of hours from facts", () => {
    const out = String(renderServiceArea(makeContext(FULL), "split"));
    expect(out).toContain(">Service area &amp; hours</h2>");
    expect(out).toContain('<p class="mt-4 text-xl text-pretty text-muted">Within 25 miles of downtown Austin</p>');
    expect(out).toContain(">Round Rock</li>");
    expect(out).toContain(">100 Congress Ave<br>Austin, TX 78701</address>");
    expect(out).toContain('<th scope="row" class="py-2 pr-4 font-medium text-heading">Monday</th><td class="py-2 text-default">8:00 AM – 5:00 PM</td>');
    expect(out).toContain(">Sunday</th><td class=\"py-2 text-default\">Closed</td>");
    expect(out).toContain("24/7 emergency service available");
  });

  it("drops the hours column and the word hours when the owner gave no hours", () => {
    const out = String(renderServiceArea(makeContext(MINIMAL), "split"));
    expect(out).toContain(">Service area</h2>");
    expect(out).not.toMatch(/hours/i);
    expect(out).not.toContain("<table");
    expect(out).toContain('<div class="mx-auto max-w-3xl">');
    expect(out).toContain(">Based in Austin, TX</p>");
  });
});

describe("faq", () => {
  it("is a native exclusive accordion with the first item open", () => {
    const out = String(renderFaq(makeContext(FULL), "accordion"));
    expect(out.match(/<details class="group" name="faq"/g)).toHaveLength(2);
    expect(out).toContain('<details class="group" name="faq" open>');
    expect(out.match(/ open>/g)).toHaveLength(1);
    expect(out).toContain(">Do you charge for estimates?</h3>");
    expect(out).not.toContain("<script");
  });

  it("has an always-open two-column variant", () => {
    const out = String(renderFaq(makeContext(FULL), "open"));
    expect(out).not.toContain("<details");
    expect(out).toContain('<div class="mx-auto grid max-w-4xl grid-cols-1 gap-8 sm:grid-cols-2 md:gap-y-8">');
  });
});

describe("contact", () => {
  const out = String(renderContact(makeContext(FULL), "card"));

  it("posts to the configured https action", () => {
    expect(out).toContain('<form id="quote" action="https://forms.example.com/submit" method="post">');
    expect(out).toContain('<section id="contact" aria-labelledby="contact-title">');
  });

  it("labels every field, marks the optional ones and requires name and phone", () => {
    expect(out).toContain(">Email (optional)</label>");
    expect(out).toContain(">Service needed (optional)</label>");
    expect(out).toContain(">How can we help? (optional)</label>");
    for (const id of ["contact-name", "contact-phone", "contact-email", "contact-service", "contact-message", "contact-website"]) {
      expect(out).toContain(`<label for="${id}"`);
      expect(out).toContain(`id="${id}"`);
    }
    expect(out).toMatch(/id="contact-name" name="name" type="text" autocomplete="name" required/);
    expect(out).toMatch(/id="contact-phone" name="phone" type="tel" autocomplete="tel" required/);
    expect(out).not.toMatch(/id="contact-email"[^>]*required/);
  });

  it("offers the owner's services in the select", () => {
    expect(out).toContain("<option>Drain cleaning</option>");
    expect(out).toContain("<option>Something else</option>");
  });

  it("draws the service select like the text fields, with its own decorative arrow", () => {
    // WebKit draws a native select at its own font-based height (23-25 px) and ignores its padding.
    const selectClasses = out.match(/<select id="contact-service" name="service" class="([^"]*)">/)?.[1]?.split(" ");
    expect(selectClasses).toEqual(expect.arrayContaining(["appearance-none", "min-h-12", "rounded-lg", "border-muted", "py-3", "pl-4", "pr-12"]));
    // WebKit counts a chosen option's whole text as page width, so a long service name must be clipped.
    expect(selectClasses).toContain("truncate");
    // The arrow sits over the select without taking clicks from it and is hidden from assistive tech.
    // It inherits the text colour, so forced-colours (high-contrast) mode recolours it with the text.
    const arrowClasses = out.match(/<\/select><svg class="([^"]*)" viewBox="0 0 24 24" aria-hidden="true">/)?.[1]?.split(" ") ?? [];
    expect(arrowClasses).toEqual(expect.arrayContaining(["pointer-events-none", "absolute"]));
    expect(arrowClasses.filter((c) => c.startsWith("text-"))).toEqual([]);
    expect(out).toContain('<div class="relative mt-1 text-default"><select id="contact-service"');
  });

  it("has a hidden, unfocusable honeypot", () => {
    expect(out).toContain('aria-hidden="true"><label for="contact-website">Leave this field empty</label><input id="contact-website" name="website" type="text" tabindex="-1" autocomplete="off">');
  });

  it("moves the owner's email to the next line whole, never splitting an address that fits", () => {
    const mailClasses = out.match(/<a class="([^"]*)" href="mailto:office@example.com">/)?.[1]?.split(" ");
    expect(mailClasses).toContain("wrap-anywhere");
    expect(mailClasses).not.toContain("break-all");
  });

  it("uses the AI call-to-action as the heading", () => {
    expect(out).toContain(">Get a free quote</h2>");
    expect(String(renderContact(makeContext(MINIMAL), "card"))).toContain(">Book a clean</h2>");
  });
});
