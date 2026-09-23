import { Facts } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { faqPageJsonLd, jsonLdScript, localBusinessJsonLd, serializeJsonLd } from "../src/json-ld.ts";

const BREAKOUT = "Joe</script><script>alert(1)</script><!--";

const facts = Facts.parse({
  businessName: "Reliable Rooter",
  trade: "plumbing",
  phone: "+15125550142",
  email: "office@example.com",
  location: { streetAddress: "100 Congress Ave", city: "Austin", state: "TX", postalCode: "78701" },
  serviceArea: { places: ["Austin", "Round Rock", "78704"] },
  hours: [
    { days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], opens: "08:00", closes: "17:00" },
    { days: ["Saturday"], opens: "09:00", closes: "13:00" },
  ],
  services: [{ name: "Drain cleaning" }],
  yearFounded: 1998,
  socialLinks: [{ network: "facebook", url: "https://www.facebook.com/reliablerooter" }],
});

describe("serializeJsonLd", () => {
  it("never emits <, > or & and round-trips exactly", () => {
    const out = serializeJsonLd({ name: BREAKOUT, amp: "a&b", ls: "x\u2028y\u2029z" });
    expect(out).not.toMatch(/[<>&\u2028\u2029]/);
    expect(out).toContain("\\u003c/script\\u003e");
    expect(JSON.parse(out)).toEqual({ name: BREAKOUT, amp: "a&b", ls: "x\u2028y\u2029z" });
  });

  it("wraps the payload in one ld+json script", () => {
    const tag = String(jsonLdScript({ name: BREAKOUT }));
    expect(tag.startsWith('<script type="application/ld+json">')).toBe(true);
    expect(tag.match(/<\/script>/g)).toHaveLength(1);
    expect(tag.match(/<script/g)).toHaveLength(1);
  });
});

describe("localBusinessJsonLd", () => {
  it("uses the most specific type and owner facts only", () => {
    expect(localBusinessJsonLd(facts)).toEqual({
      "@context": "https://schema.org",
      "@type": "Plumber",
      name: "Reliable Rooter",
      telephone: "+15125550142",
      email: "office@example.com",
      address: {
        "@type": "PostalAddress",
        streetAddress: "100 Congress Ave",
        addressLocality: "Austin",
        addressRegion: "TX",
        postalCode: "78701",
        addressCountry: "US",
      },
      areaServed: ["Austin", "Round Rock", "78704"],
      openingHoursSpecification: [
        {
          "@type": "OpeningHoursSpecification",
          dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
          opens: "08:00",
          closes: "17:00",
        },
        { "@type": "OpeningHoursSpecification", dayOfWeek: ["Saturday"], opens: "09:00", closes: "13:00" },
      ],
      foundingDate: "1998",
      sameAs: ["https://www.facebook.com/reliablerooter"],
    });
  });

  it("falls back to HomeAndConstructionBusiness and omits missing optional facts", () => {
    const ld = localBusinessJsonLd(
      Facts.parse({
        businessName: "Mop",
        trade: "cleaning",
        phone: "+15125550142",
        email: "hi@example.com",
        location: { city: "Austin", state: "TX" },
        serviceArea: { places: ["Austin"] },
        services: [{ name: "Cleaning" }],
      }),
    );
    expect(ld["@type"]).toBe("HomeAndConstructionBusiness");
    expect(ld["address"]).toEqual({
      "@type": "PostalAddress",
      addressLocality: "Austin",
      addressRegion: "TX",
      addressCountry: "US",
    });
    expect(Object.keys(ld)).not.toContain("openingHoursSpecification");
    expect(Object.keys(ld)).not.toContain("sameAs");
  });
});

describe("faqPageJsonLd", () => {
  it("maps questions and answers", () => {
    expect(faqPageJsonLd([{ question: "Do you charge for estimates?", answer: "No, estimates are free." }])).toEqual({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: [
        {
          "@type": "Question",
          name: "Do you charge for estimates?",
          acceptedAnswer: { "@type": "Answer", text: "No, estimates are free." },
        },
      ],
    });
  });
});
