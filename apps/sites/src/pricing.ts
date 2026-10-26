import { canonicalJson, sha256Hex } from "@asksite/core";
import type { Cart, CartLine } from "./cart.ts";

// Price integrity (pages lane proposal 1.5): a cart is priced from the live version's approved catalog alone. The
// cookie only names items and quantities; every price, name and total here comes from the catalog.

/**
 * The part of site-schema's Catalog (shop contract §3) that prices a cart: resolved values only. A product always has
 * its base price; `variants`, when present, means a variant must be chosen, and each carries its resolved price and
 * sold-out state (its own, or the product's).
 */
export interface PricingCatalog {
  products: ReadonlyArray<{
    id: string;
    slug: string;
    name: string;
    priceCents: number;
    compareAtCents?: number;
    soldOut: boolean;
    maxQty: number;
    variants?: ReadonlyArray<{ id: string; label: string; priceCents: number; compareAtCents?: number; soldOut: boolean }>;
  }>;
}

export interface PricedLine {
  productId: string;
  variantId: string | null;
  slug: string;
  name: string;
  variantLabel: string | null;
  unitCents: number;
  /** The catalog's resolved former price for what was chosen (the variant's, or the product's when it has no variants). */
  compareAtCents: number | null;
  qty: number;
  maxQty: number;
  lineCents: number;
}

export interface PricedCart {
  lines: PricedLine[];
  subtotalCents: number;
  /** True when a line was dropped (unknown, sold out, or a variant that does not fit) or its quantity lowered. */
  changed: boolean;
  /** The cart as priced: only the lines kept, each at the quantity priced. */
  cart: Cart;
}

/**
 * Prices each line from the catalog. A product with variants needs one of its own variants that is not sold out; a
 * product without variants takes none. There is never a fallback to another price (the base price of a product with
 * variants is never charged): a line that does not fit is dropped. A quantity above the product's maxQty is lowered to it.
 */
export function priceCart(catalog: PricingCatalog, cart: Cart): PricedCart {
  const lines: PricedLine[] = [];
  const kept: CartLine[] = [];
  let changed = false;
  for (const line of cart.lines) {
    const product = catalog.products.find((p) => p.id === line.productId);
    const variants = product?.variants;
    const variant = variants === undefined || line.variantId === null ? null : (variants.find((v) => v.id === line.variantId) ?? null);
    // Never the base price for a product with variants: such a line needs one of its own variants, not sold out.
    const fits = product !== undefined && !product.soldOut && (variants === undefined ? line.variantId === null : variant !== null && !variant.soldOut);
    if (!fits) {
      changed = true;
      continue;
    }
    const unitCents = variant === null ? product.priceCents : variant.priceCents;
    const qty = Math.min(line.qty, product.maxQty);
    if (qty !== line.qty) changed = true;
    const compareAtCents = (variant === null ? product.compareAtCents : variant.compareAtCents) ?? null;
    lines.push({
      productId: product.id, variantId: variant?.id ?? null, slug: product.slug, name: product.name, variantLabel: variant?.label ?? null,
      unitCents, compareAtCents, qty, maxQty: product.maxQty, lineCents: unitCents * qty,
    });
    kept.push({ productId: line.productId, variantId: line.variantId, qty });
  }
  const subtotalCents = lines.reduce((sum, l) => sum + l.lineCents, 0);
  if (!Number.isSafeInteger(subtotalCents)) throw new Error("priceCart: subtotal out of range");
  return { lines, subtotalCents, changed, cart: { ...cart, lines: kept } };
}

/**
 * What the buyer saw: the SHA-256 of the version and each line's item, unit price and quantity, in order. The cart page
 * puts it in the order form; the order is made only when the order post prices the same quote. It is a check, never a
 * price source.
 */
export function cartQuote(versionId: string, lines: readonly PricedLine[]): Promise<string> {
  return sha256Hex(canonicalJson({ versionId, lines: lines.map((l) => [l.productId, l.variantId, l.unitCents, l.qty]) }));
}
