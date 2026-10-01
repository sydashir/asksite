import type { FaqItem, Facts, Trade } from "@asksite/site-schema";
import { SafeHtml } from "./html.ts";

// JSON has no "\x3C" escape, so "<", ">" and "&" become \u003c, \u003e and \u0026: the output
// can never contain "</script" or "<!--" (WHATWG "Restrictions for contents of script elements").
// U+2028/U+2029 are escaped for older parsers that treat them as line breaks.
const JSON_LD_ESCAPES: Record<string, string> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/[<>&\u2028\u2029]/g, (c) => JSON_LD_ESCAPES[c] ?? c);
}

export function jsonLdScript(data: unknown): SafeHtml {
  return new SafeHtml(`<script type="application/ld+json">${serializeJsonLd(data)}</script>`);
}

// Most specific schema.org type per trade. schema.org has no cleaning or landscaping type.
export const SCHEMA_TYPE: Record<Trade, string> = {
  plumbing: "Plumber",
  hvac: "HVACBusiness",
  electrical: "Electrician",
  roofing: "RoofingContractor",
  cleaning: "HomeAndConstructionBusiness",
  landscaping: "HomeAndConstructionBusiness",
};

/** `url` is the site's own address (the Home page's canonical). */
export function localBusinessJsonLd(facts: Facts, url: string): Record<string, unknown> {
  const { location } = facts;
  return {
    "@context": "https://schema.org",
    "@type": SCHEMA_TYPE[facts.trade],
    name: facts.businessName,
    url,
    telephone: facts.phone,
    email: facts.email,
    address: {
      "@type": "PostalAddress",
      ...(location.streetAddress ? { streetAddress: location.streetAddress } : {}),
      addressLocality: location.city,
      addressRegion: location.state,
      ...(location.postalCode ? { postalCode: location.postalCode } : {}),
      addressCountry: "US",
    },
    areaServed: facts.serviceArea.places,
    ...(facts.hours.length > 0
      ? {
          openingHoursSpecification: facts.hours.map((h) => ({
            "@type": "OpeningHoursSpecification",
            dayOfWeek: h.days,
            opens: h.opens,
            closes: h.closes,
          })),
        }
      : {}),
    ...(facts.yearFounded ? { foundingDate: String(facts.yearFounded) } : {}),
    ...(facts.heroPhoto ? { image: facts.heroPhoto.url } : {}),
    ...(facts.socialLinks.length > 0 ? { sameAs: facts.socialLinks.map((s) => s.url) } : {}),
  };
}

export function faqPageJsonLd(items: readonly FaqItem[]): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: { "@type": "Answer", text: item.answer },
    })),
  };
}
