import { describe, expect, it } from "vitest";
import { renderAbout } from "../src/sections/about.ts";
import { renderContact } from "../src/sections/contact.ts";
import { renderFaq } from "../src/sections/faq.ts";
import { renderServiceArea } from "../src/sections/service-area.ts";
import { FULL, makeContext, MINIMAL } from "./support/doc.ts";

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
    expect(out).toContain('<form action="https://forms.example.com/submit" method="post">');
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

  it("has a hidden, unfocusable honeypot", () => {
    expect(out).toContain('aria-hidden="true"><label for="contact-website">Leave this field empty</label><input id="contact-website" name="website" type="text" tabindex="-1" autocomplete="off">');
  });

  it("uses the AI call-to-action as the heading", () => {
    expect(out).toContain(">Get a free quote</h2>");
    expect(String(renderContact(makeContext(MINIMAL), "card"))).toContain(">Book a clean</h2>");
  });
});
