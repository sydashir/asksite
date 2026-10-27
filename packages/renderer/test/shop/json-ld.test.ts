import { SiteDocument } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { localBusinessJsonLd, productJsonLd, serializeJsonLd, shopBusinessJsonLd } from "../../src/json-ld.ts";
import type { Product } from "../../src/shop/model.ts";
import { FULL } from "../support/doc.ts";
import { PAYLOADS } from "./payloads.ts";
import { BOSS_PRODUCT, MEDIA_BASE, SOLD_OUT, UPLOADS, WITH_PHOTOS, WITH_VARIANTS } from "./support.ts";

const URL_OF = (p: Product) => `https://shop.asksite.example/shop/${p.slug}`;

describe("productJsonLd (contract §4; Google product snippets)", () => {
  it("a product without variants: a Product with one Offer, price as text, USD, InStock", () => {
    expect(productJsonLd(BOSS_PRODUCT, URL_OF(BOSS_PRODUCT), MEDIA_BASE)).toEqual({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Mom Filpflop",
      url: "https://shop.asksite.example/shop/mom-filpflop",
      offers: { "@type": "Offer", price: "50.00", priceCurrency: "USD", availability: "https://schema.org/InStock" },
    });
  });

  it("carries the client's description and every photo's media URL, and SoldOut when nobody can buy it", () => {
    const withPhotos = productJsonLd(WITH_PHOTOS, URL_OF(WITH_PHOTOS), MEDIA_BASE);
    expect(withPhotos["description"]).toBe(WITH_PHOTOS.description);
    expect(withPhotos["image"]).toEqual(UPLOADS.map((u) => `${MEDIA_BASE}${u}.webp`));
    expect((productJsonLd(SOLD_OUT, URL_OF(SOLD_OUT), MEDIA_BASE)["offers"] as Record<string, unknown>)["availability"]).toBe("https://schema.org/SoldOut");
  });

  it("never states a former price", () => {
    const json = serializeJsonLd(productJsonLd({ ...BOSS_PRODUCT, compareAtCents: 9000 }, URL_OF(BOSS_PRODUCT), MEDIA_BASE));
    expect(json).not.toContain("90.00");
    expect(json).not.toMatch(/priceSpecification|StrikethroughPrice/);
  });

  it("variants with one price: still a Product with one Offer", () => {
    const same: Product = { ...WITH_VARIANTS, variants: WITH_VARIANTS.variants!.map(({ priceCents: _p, compareAtCents: _c, ...v }) => v) };
    expect(productJsonLd(same, URL_OF(same), MEDIA_BASE)).toMatchObject({ "@type": "Product", offers: { price: "42.00", availability: "https://schema.org/InStock" } });
  });

  it("variant prices that differ: a ProductGroup with each listed variant, size and color mapped from the option names", () => {
    const group = productJsonLd(WITH_VARIANTS, URL_OF(WITH_VARIANTS), MEDIA_BASE);
    expect(group).toMatchObject({ "@type": "ProductGroup", name: "Everyday Slide", productGroupID: WITH_VARIANTS.id, variesBy: ["https://schema.org/size", "https://schema.org/color"] });
    expect(group["hasVariant"]).toEqual(
      WITH_VARIANTS.variants!.map((v) => ({
        "@type": "Product",
        name: `Everyday Slide – ${v.values.join(" / ")}`,
        sku: v.id,
        size: v.values[0],
        color: v.values[1],
        offers: { "@type": "Offer", price: v.priceCents === 4600 ? "46.00" : "42.00", priceCurrency: "USD", availability: v.soldOut ? "https://schema.org/SoldOut" : "https://schema.org/InStock" },
      })),
    );
  });

  it("leaves option names Google does not read out of variesBy", () => {
    const scent: Product = { ...WITH_VARIANTS, options: [{ name: "Scent", values: ["7", "8", "9"] }, { name: "Colour", values: ["Sand", "Navy"] }] };
    const group = productJsonLd(scent, URL_OF(scent), MEDIA_BASE);
    expect(group["variesBy"]).toEqual(["https://schema.org/color"]);
    expect((group["hasVariant"] as Record<string, unknown>[])[0]).not.toHaveProperty("size");
  });

  it.each(PAYLOADS)("keeps %j inside the JSON-LD script as data", (payload) => {
    const json = serializeJsonLd(productJsonLd({ ...BOSS_PRODUCT, name: payload, description: payload }, URL_OF(BOSS_PRODUCT), MEDIA_BASE));
    expect(json).not.toMatch(/<\/script|<!--/i);
    expect(JSON.parse(json)).toMatchObject({ name: payload, description: payload });
  });
});

describe("shopBusinessJsonLd (a shop business's Home)", () => {
  const facts = SiteDocument.parse(FULL).facts;

  it("is a Store (a LocalBusiness) when the business gives a street address", () => {
    expect(shopBusinessJsonLd(facts, "https://x.asksite.example/")).toEqual({ ...localBusinessJsonLd(facts, "https://x.asksite.example/"), "@type": "Store" });
  });

  it("is an OnlineStore without opening hours (an Organization, not a Place) when it gives none", () => {
    const { streetAddress: _s, ...location } = facts.location;
    const online = shopBusinessJsonLd({ ...facts, location }, "https://x.asksite.example/");
    expect(online["@type"]).toBe("OnlineStore");
    expect(online).not.toHaveProperty("openingHoursSpecification");
    expect(online["telephone"]).toBe(facts.phone);
  });
});
