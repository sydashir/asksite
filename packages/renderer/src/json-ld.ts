import { serviceAreaScopeOf, type FaqItem, type Facts, type Trade } from "@asksite/site-schema";
import { SafeHtml } from "./html.ts";
import { isBuyable, priceRangeCents, productPhotoUrl, variantLabel, variantPriceCents, type Product } from "./shop/model.ts";
import { CURRENCY, jsonLdPrice } from "./shop/money.ts";

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

// Most specific schema.org type per trade. schema.org has no cleaning, landscaping or IT type, and its
// ProfessionalService "was deprecated due to confusion with Service" (https://schema.org/ProfessionalService),
// so an IT firm is a plain LocalBusiness; a law firm is a LegalService (https://schema.org/LegalService).
export const SCHEMA_TYPE: Record<Trade, string> = {
  plumbing: "Plumber",
  hvac: "HVACBusiness",
  electrical: "Electrician",
  roofing: "RoofingContractor",
  cleaning: "HomeAndConstructionBusiness",
  landscaping: "HomeAndConstructionBusiness",
  it: "LocalBusiness",
  law: "LegalService",
  other: "LocalBusiness",
};

/**
 * Where the business works, per schema.org areaServed (https://schema.org/areaServed: AdministrativeArea, GeoShape,
 * Place or Text), from the owner's facts only: the listed places; the country, a schema.org Country
 * (https://schema.org/Country, an AdministrativeArea), which is the United States for every site (a US phone and
 * address, addressCountry "US" below); and nothing for worldwide, which no schema.org place names.
 */
function areaServed(facts: Facts): { areaServed?: unknown } {
  switch (serviceAreaScopeOf(facts)) {
    case "places":
      return { areaServed: facts.serviceArea.places };
    case "country":
      return { areaServed: { "@type": "Country", name: "United States" } };
    case "worldwide":
      return {};
  }
}

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
    ...areaServed(facts),
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

/**
 * A shop business's schema.org type (trade "shop" in phase 2; PROVISIONAL: the shop render's shopFirst flag until then):
 * a Store, "A retail good store" and a LocalBusiness (https://schema.org/Store), when the business gives a street
 * address; else an OnlineStore, "An eCommerce site" (https://schema.org/OnlineStore: Organization > OnlineBusiness),
 * which is not a Place, so it carries no opening hours. Everything else is localBusinessJsonLd's, from the facts only.
 */
export function shopBusinessJsonLd(facts: Facts, url: string): Record<string, unknown> {
  const business = localBusinessJsonLd(facts, url);
  if (facts.location.streetAddress) return { ...business, "@type": "Store" };
  const { openingHoursSpecification: _hours, ...online } = business;
  return { ...online, "@type": "OnlineStore" };
}

// Option names that map to a schema.org property Google reads on a variant (developers.google.com/search/docs/
// appearance/structured-data/product-variants, variesBy: color, size, …). Others are left out of variesBy.
const VARIES_BY: Readonly<Record<string, "size" | "color">> = { size: "size", colour: "color", color: "color" };

const availability = (buyable: boolean) => (buyable ? "https://schema.org/InStock" : "https://schema.org/SoldOut");

const offer = (cents: number, buyable: boolean): Record<string, unknown> => ({ "@type": "Offer", price: jsonLdPrice(cents), priceCurrency: CURRENCY, availability: availability(buyable) });

/**
 * A product page's JSON-LD (contract §4; Google product snippets, developers.google.com/search/docs/appearance/
 * structured-data/product-snippet): a Product with one Offer (price as jsonLdPrice text, "USD", InStock or SoldOut), or,
 * when its variants' prices differ, a ProductGroup with one Product per listed variant in hasVariant (productGroupID =
 * the product id, sku = the variant id, size/color from the option names that map). Names, description and photos are
 * the client's own; no former price (a "Was" is shown on the page only). `url` is the product page's own address.
 */
export function productJsonLd(product: Product, url: string, mediaBase: string): Record<string, unknown> {
  const images = (product.photos ?? []).map((photo) => productPhotoUrl(mediaBase, photo));
  const common = {
    "@context": "https://schema.org",
    name: product.name,
    url,
    ...(product.description !== undefined ? { description: product.description } : {}),
    ...(images.length > 0 ? { image: images } : {}),
  };
  const variants = product.variants ?? [];
  const { low, high } = priceRangeCents(product);
  if (variants.length === 0 || low === high) return { ...common, "@type": "Product", offers: offer(low, isBuyable(product)) };
  const options = product.options ?? [];
  const mapped = options.map((o) => VARIES_BY[o.name.trim().toLowerCase()]);
  return {
    ...common,
    "@type": "ProductGroup",
    productGroupID: product.id,
    ...(mapped.some((m) => m !== undefined) ? { variesBy: mapped.flatMap((m) => (m === undefined ? [] : [`https://schema.org/${m}`])) } : {}),
    hasVariant: variants.map((v) => ({
      "@type": "Product",
      name: `${product.name} – ${variantLabel(product, v)}`,
      sku: v.id,
      ...Object.fromEntries(mapped.flatMap((m, i) => (m === undefined || v.values[i] === undefined ? [] : [[m, v.values[i]]]))),
      offers: offer(variantPriceCents(product, v), product.soldOut !== true && v.soldOut !== true),
    })),
  };
}
