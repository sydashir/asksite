import { Facts } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { textFlags } from "../../src/worker/text-flags.ts";
import { VALID_FACTS } from "../support/harness.ts";

describe("textFlags", () => {
  it("is empty for ordinary facts, and the site's own phone number is not flagged", () => {
    const facts = Facts.parse({ ...VALID_FACTS, testimonials: [{ quote: "Call them on (512) 555-0142, great work.", name: "Ana" }] });
    expect(textFlags(facts)).toEqual([]);
  });

  it("flags web addresses, @, other phone numbers and phishing words in owner text", () => {
    const facts = Facts.parse({
      ...VALID_FACTS,
      businessName: "Joe's Plumbing www.joes-deals.example",
      testimonials: [{ quote: "Verify your bank login at paypa1-help.com or call 1-800-555-0199", name: "me@evil.example" }],
      photos: [{ url: "https://media.asksite.example/a/b.webp", alt: "Send gift cards here", width: 400, height: 300 }],
      serviceArea: { places: ["Austin"], note: "Text 512 555 0100 for crypto payments" },
    });
    expect(textFlags(facts)).toEqual([
      { path: "facts.businessName", reason: "web_address" },
      { path: "facts.serviceArea.note", reason: "other_phone" },
      { path: "facts.serviceArea.note", reason: "phishing_word" },
      { path: "facts.testimonials.0.quote", reason: "web_address" },
      { path: "facts.testimonials.0.quote", reason: "other_phone" },
      { path: "facts.testimonials.0.quote", reason: "phishing_word" },
      { path: "facts.testimonials.0.name", reason: "web_address" },
      { path: "facts.testimonials.0.name", reason: "at_sign" },
      { path: "facts.photos.0.alt", reason: "phishing_word" },
    ]);
  });

  it("flags the owner's own business type (trade Other) like any other free text", () => {
    const facts = Facts.parse({ ...VALID_FACTS, trade: "other", tradeOther: "Bakery joes.example" });
    expect(textFlags(facts)).toEqual([{ path: "facts.tradeOther", reason: "web_address" }]);
  });

  it("reads the text as a reader sees it: any ending, full-width text, spelled-out dots, any digits and dashes", () => {
    const facts = Facts.parse({
      ...VALID_FACTS,
      services: [
        { name: "Pay at paypa1-help.dev" },
        { name: "ｐａｙｐａｌ．ｃｏｍ refunds" },
        { name: "Visit joes(dot)top today" },
        { name: "Write to billing [.] ru" },
        { name: "Text ５１２ ５５５ ０１９９" },
        { name: "Call 512–555–0198" },
        { name: "Call ٥١٢٥٥٥٠١٩٧" },
      ],
      serviceArea: { places: ["Austin", "shop.xn--p1ai"] },
    });
    expect(textFlags(facts)).toEqual([
      { path: "facts.services.0.name", reason: "web_address" },
      { path: "facts.services.1.name", reason: "web_address" },
      { path: "facts.services.2.name", reason: "web_address" },
      { path: "facts.services.3.name", reason: "web_address" },
      { path: "facts.services.4.name", reason: "other_phone" },
      { path: "facts.services.5.name", reason: "other_phone" },
      { path: "facts.services.6.name", reason: "other_phone" },
      { path: "facts.serviceArea.places.1", reason: "web_address" },
    ]);
  });

  it("checks every owner-typed string the page shows: the address, the places and licence numbers too", () => {
    const facts = Facts.parse({
      ...VALID_FACTS,
      location: { streetAddress: "Suite 5, verify-account.example.com", city: "Austin", state: "TX" },
      serviceArea: { places: ["Austin", "support@evil.example"] },
      licences: [{ label: "City license", number: "Call 1-800-555-0199" }],
    });
    expect(textFlags(facts)).toEqual([
      { path: "facts.location.streetAddress", reason: "web_address" },
      { path: "facts.location.streetAddress", reason: "phishing_word" },
      { path: "facts.serviceArea.places.1", reason: "web_address" },
      { path: "facts.serviceArea.places.1", reason: "at_sign" },
      { path: "facts.licences.0.number", reason: "other_phone" },
    ]);
  });

  it("does not flag an ordinary licence number, ZIP code place, street address or review", () => {
    const facts = Facts.parse({
      ...VALID_FACTS,
      location: { streetAddress: "1200 Barton Springs Rd", city: "Austin", state: "TX", postalCode: "78704" },
      serviceArea: { places: ["Austin", "78704"] },
      licences: [{ label: "Texas plumbing license", number: "M-40123" }],
      testimonials: [{ quote: "Great work. Mr. Lee fixed our sink in 2 hours, on a Sunday.", name: "Ana P." }],
    });
    expect(textFlags(facts)).toEqual([]);
  });

  it("drops invisible characters before matching, so they cannot split a flagged word, and emoji alone are not flagged (A9)", () => {
    // U+200D and U+034F pass Facts today, and so do emoji with U+FE0F, skin tones and joiners. U+200B and
    // U+2060 do not, but a stored document is still read when a later rule refuses it (decision 36), so
    // the flags must not rely on Facts refusing them.
    const typed = Facts.parse({
      ...VALID_FACTS,
      services: [{ name: "Veri\u200Dfy your account" }, { name: "Pass\u034Fword help" }, { name: "Thanks \u2764\uFE0F \u{1F44D}\u{1F3FD} \u{1F468}\u200D\u{1F469}\u200D\u{1F467}" }],
    });
    const facts: Facts = { ...typed, services: [...typed.services, { name: "Pay at paypal.c\u200Bom" }, { name: "Gift\u2060cards taken" }] };
    expect(textFlags(facts)).toEqual([
      { path: "facts.services.0.name", reason: "phishing_word" },
      { path: "facts.services.1.name", reason: "phishing_word" },
      { path: "facts.services.3.name", reason: "web_address" },
      { path: "facts.services.4.name", reason: "phishing_word" },
    ]);
  });
});
