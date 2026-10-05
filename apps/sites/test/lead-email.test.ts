import { describe, expect, it } from "vitest";
import { leadEmail } from "../src/lead-email.ts";

const base = {
  to: "owner@example.com",
  leadId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  siteUrl: "https://joes.asksite.example/",
  lead: { name: "Dana", phone: "(512) 555-0199", email: "dana@example.com", service: "Drain cleaning", message: "Line one\nLine two" },
};

describe("leadEmail", () => {
  it("builds the text and HTML parts, the reply-to and the idempotency key", () => {
    const email = leadEmail(base);
    expect(email).toMatchObject({
      to: "owner@example.com",
      subject: "New request from your website: Dana",
      replyTo: "dana@example.com",
      tag: "lead",
      idempotencyKey: "lead:7c9e6679-7425-40de-944b-e07fc1f90ae7",
    });
    expect(email.text).toBe(
      [
        "You have a new request from your website.",
        "",
        "Name: Dana",
        "Phone: (512) 555-0199",
        "Email: dana@example.com",
        "Service: Drain cleaning",
        "",
        "Message:",
        "Line one\nLine two",
        "",
        "Reply to this email to answer them.",
        "",
        "Sent from the contact form on https://joes.asksite.example/",
      ].join("\n"),
    );
    expect(email.html).toContain("<strong>Message:</strong><br>\nLine one<br>\nLine two</p>");
    expect(email.html).toContain('<a href="https://joes.asksite.example/">https://joes.asksite.example/</a>');
  });

  it("asks for a call back and sets no reply-to when there is no email", () => {
    const email = leadEmail({ ...base, lead: { ...base.lead, email: null, service: null, message: null } });
    expect(email).not.toHaveProperty("replyTo");
    expect(email.text).toContain("They did not leave an email address, so please call them back.");
    expect(email.text).not.toContain("Email:");
    expect(email.text).not.toContain("Message:");
  });

  it("puts visitor values only into escaped text, never into markup, links or attributes", () => {
    const payload = '<img src=x onerror=alert(1)><a href="https://evil.example">x</a>';
    const email = leadEmail({ ...base, lead: { name: payload, phone: "5125550199", email: null, service: payload, message: payload } });
    expect(email.html).not.toContain("<img");
    expect(email.html).not.toContain("evil.example\">");
    expect(email.html.match(/<a /g)).toHaveLength(1);
    expect(email.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("keeps the subject on one line and at most 100 characters", () => {
    const email = leadEmail({ ...base, lead: { ...base.lead, name: `Dana\r\nBcc: victim@example.com ${"x".repeat(200)}` } });
    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(Array.from(email.subject)).toHaveLength(100);
  });

  it("never splits an emoji when cutting the subject", () => {
    const email = leadEmail({ ...base, lead: { ...base.lead, name: "\u{1F527}".repeat(80) } });
    expect(email.subject.endsWith("\u{1F527}")).toBe(true);
  });

  // B-N3: the subject cleans the name the way readLead cleans a one-line field (lead.ts LINE_BREAK and HIDDEN), even
  // though its only caller already passes cleaned text: a line break reads as a space, a hidden character goes.
  it.each([
    ["U+2028 (line separator)", "Da na", "Da na"],
    ["U+2029 (paragraph separator)", "Da na", "Da na"],
    ["U+202E (right-to-left override)", "Da‮na", "Dana"],
    ["U+200B (zero-width space)", "Da​na", "Dana"],
    ["U+FEFF (zero-width no-break space)", "Da﻿na", "Dana"],
  ])("cleans %s out of the subject", (_label, name, shown) => {
    expect(leadEmail({ ...base, lead: { ...base.lead, name } }).subject).toBe(`New request from your website: ${shown}`);
  });

  it("keeps an emoji joined by U+200D whole in the subject", () => {
    const mechanic = "\u{1F469}‍\u{1F527}";
    expect(leadEmail({ ...base, lead: { ...base.lead, name: `Dana ${mechanic}` } }).subject).toBe(`New request from your website: Dana ${mechanic}`);
  });
});
