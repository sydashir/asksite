// What each product field says about what was typed. Every text here is NEW (for the user's approval); the price texts are
// draft C §4.8's, from lib/money.ts. The schema still decides what is stored: this is the form's own, immediate check, and the
// container (lane A) may add the schema's issues (a slug another product already uses, for example).

import { parseUsdCents, priceErrors } from "../lib/money.ts";
import { PRODUCT_LIMITS, PRODUCT_SLUG, type ProductDraft, type ProductPath } from "./catalog.ts";

const tooLong = (text: string, max: number) => ([...text].length > max ? [`Please use ${max} characters or fewer.`] : []);

/** A "was" price must be above the price it sits next to (the contract's refine). */
function compareAtErrors(text: string, priceText: string): string[] {
  const errors = priceErrors(text, false);
  if (errors.length > 0) return errors;
  const was = parseUsdCents(text);
  const price = parseUsdCents(priceText);
  return was.ok && price.ok && was.cents <= price.cents ? ["The “was” price must be higher than the price."] : [];
}

export function productErrors(product: ProductDraft, path: ProductPath): string[] {
  const [field, index, part] = path;
  switch (field) {
    case "name":
      return product.name.trim() === "" ? ["Give the product a name."] : tooLong(product.name.trim(), PRODUCT_LIMITS.name);
    case "slug":
      if (product.slug === "") return ["Give the product a link, like mom-flipflop."];
      return PRODUCT_SLUG.test(product.slug) ? [] : ["Use lower-case letters, numbers and single dashes, like mom-flipflop."];
    case "price":
      return priceErrors(product.priceText, true);
    case "compareAt":
      return compareAtErrors(product.compareAtText, product.priceText);
    case "description":
      return tooLong(product.description.trim(), PRODUCT_LIMITS.description);
    case "maxQty": {
      const text = product.maxQtyText.trim();
      if (text === "") return [];
      const qty = /^\d{1,2}$/.test(text) ? Number(text) : 0;
      return qty >= 1 && qty <= PRODUCT_LIMITS.maxQty ? [] : [`Enter a whole number from 1 to ${PRODUCT_LIMITS.maxQty}, or leave it empty.`];
    }
    case "photos":
      return typeof index === "number" && part === "alt" ? tooLong(product.photos[index]?.alt.trim() ?? "", PRODUCT_LIMITS.alt) : [];
    case "options": {
      if (typeof index !== "number" || part !== "name") return [];
      const option = product.options[index];
      if (option === undefined) return [];
      const name = option.name.trim().toLowerCase();
      if (name === "") return option.values.length > 0 ? ["Name this list, like Size or Colour."] : [];
      return product.options.some((o, i) => i < index && o.name.trim().toLowerCase() === name) ? ["Each list needs its own name."] : [];
    }
    case "variants": {
      const variant = typeof index === "number" ? product.variants[index] : undefined;
      if (variant === undefined || !variant.offered) return [];
      if (part === "price") return priceErrors(variant.priceText, false);
      if (part === "compareAt") return compareAtErrors(variant.compareAtText, variant.priceText.trim() === "" ? product.priceText : variant.priceText);
      return [];
    }
    default:
      return [];
  }
}
