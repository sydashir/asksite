import { describe, expect, it } from "vitest";
import { loadFixture } from "../../../fixtures/index.ts";
import { contactHeading } from "../src/contact-heading.ts";

describe("contactHeading", () => {
  it("keeps a label of two or more words", () => {
    expect(contactHeading("Get a free quote")).toBe("Get a free quote");
  });

  it("turns a one-word label into a fuller heading", () => {
    expect(contactHeading("Book")).toBe("Request a booking");
    expect(contactHeading("Quote.")).toBe("Request a quote");
    expect(contactHeading("Hello")).toBe("Send us a request");
  });

  it("trims surrounding spaces", () => {
    expect(contactHeading("  Book  ")).toBe("Request a booking");
    expect(contactHeading("  Get a quote ")).toBe("Get a quote");
  });

  it.each([
    ["book", "Request a booking"],
    ["quote", "Request a quote"],
    ["estimate", "Request an estimate"],
    ["schedule", "Request a visit"],
    ["contact", "Send us a request"],
    ["enquire", "Send us a request"],
    ["inquire", "Send us a request"],
    ["call", "Send us a request"],
  ])("maps %s to %s, ignoring case and trailing punctuation", (key, heading) => {
    expect(contactHeading(key.toUpperCase() + "!")).toBe(heading);
  });

  it("keeps a markup label unchanged; escaping stays the caller's job", () => {
    const { copy } = loadFixture("electrical-xss");
    expect(contactHeading(copy.ctaText)).toBe(copy.ctaText);
  });
});
