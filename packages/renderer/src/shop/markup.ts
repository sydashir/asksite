// The shop's design-neutral building blocks: the product tile and photos, the price, the "Sold out" badge, the card,
// the grid list, the add-to-cart form, the card's action, the breadcrumb, typed text and the questions line. Each
// design's shop.ts arranges them in its own layout; each design's <design>-shop.css styles the SAME class names:
//
//   ul.shop-grid[role=list] > li.shop-card     a product card: .shop-card__media, .shop-badge, .shop-card__name > a, .shop-price, action
//   .shop-tile.shop-tile--1|2|3[aria-hidden]   the no-photo tile, three colourways cycled by position; .shop-tile__mark = the initials
//   img.shop-photo                             a product photo (width, height, alt; lazy when asked)
//   ul.shop-photos[role=list] > li             every photo of a product (product page)
//   p.shop-price                               .shop-price__now ("$50", "From $45"), s.shop-price__was ("Was $60")
//   span.shop-badge                            "Sold out"
//   form.shop-add                              the product page's add form: fieldset.shop-variants (legend.shop-variants__legend,
//                                              .shop-variant > input.shop-variant__input + label.shop-variant__label),
//                                              .shop-qty (label.shop-qty__label, input.shop-qty__input, p.shop-qty__hint),
//                                              button.shop-add__button
//   p.shop-soldout                             in place of the add form when nothing can be bought
//   form.shop-card-add / a.shop-card-options   the card's action: "Add to cart" (qty 1) or "Choose options"
//   nav.shop-crumbs[aria-label=Breadcrumb]     Home / Shop / <Product>
//   .shop-text                                 the client's typed paragraphs (description, sizing, returns)
//   p.shop-questions                           "Questions about this product? Call … or email …"
//   .visually-hidden                           screen-reader-only words (each shop sheet defines it)
//
// Every value is the client's own (staff type it from what the client gave, contract §1): the blocks add no claim of
// their own. Every fixed word is in SHOP_TEXT (NEW texts, for approval). Prices are "short" (contract §2.1); "Was"
// shows only the client's typed, attested former price (contract §2.5). The forms post to the pages lane's endpoint
// (shop/paths.ts) with the field names of shop/fields.ts. Escaping is html.ts's: every value goes through html``.
import { PAGES } from "@asksite/site-schema";
import { pageLink } from "../context.ts";
import { formatPhone, mailtoUrl, telUrl } from "../format.ts";
import { html, safeUrl, shopUrl, trusted, type SafeHtml } from "../html.ts";
import type { ShopRenderContext } from "./design.ts";
import { CART_FIELD, CART_OP } from "./fields.ts";
import { isBuyable, maxQtyOf, priceRangeCents, productPhotoAlt, productPhotoUrl, variantLabel, variantPriceCents, type Product, type ProductVariant, type ShopSettings } from "./model.ts";
import { formatUsd } from "./money.ts";
import { isRecordId } from "./paths.ts";

/** Every fixed word the shop blocks write (NEW texts, for approval). */
export const SHOP_TEXT = {
  shop: "Shop",
  cart: "Cart",
  addToCart: "Add to cart",
  chooseOptions: "Choose options",
  seeAll: "See all products",
  seeDetails: "See details",
  soldOut: "Sold out",
  variantSoldOut: "(sold out)",
  price: "Price: ",
  from: "From",
  was: "Was",
  quantity: "Quantity",
  upTo: "Up to",
  options: "Options",
  questions: "Questions about this product?",
  askAboutIt: "Ask about it:",
} as const;

// Whole class strings, one per colourway: neighbouring tiles differ.
const TILE_CLASS = ["shop-tile shop-tile--1", "shop-tile shop-tile--2", "shop-tile shop-tile--3"] as const;

/**
 * The tile's initials: the first letter or digit (with its combining marks) of the name's first two words that start
 * with one, upper-cased and composed (NFC): "Mom Filpflop" -> "MF", "élan bowl" -> "ÉB", "3 pack socks" -> "3P". "" when no
 * word does.
 */
export function productInitials(name: string): string {
  return name
    .split(/\s+/)
    .map((word) => /^[\p{L}\p{N}]\p{M}*/u.exec(word)?.[0])
    .filter((first): first is string => first !== undefined)
    .slice(0, 2)
    .map((first) => first.toLocaleUpperCase("en-US"))
    .join("")
    .normalize("NFC");
}

/**
 * A product with no photo: the no-photo plan's typographic tile (initials, in the design's palette). It names the
 * product and never pictures it; it is decoration, hidden from assistive tech, because the name is real text beside it.
 * `index` is the product's position in its list, which picks the colourway.
 */
export function productTile(product: Product, index: number): SafeHtml {
  const mark = productInitials(product.name);
  return html`<div class="${TILE_CLASS[index % TILE_CLASS.length] ?? TILE_CLASS[0]}" aria-hidden="true">${mark !== "" && html`<span class="shop-tile__mark">${mark}</span>`}</div>`;
}

/** One product photo: its media URL (an https URL under mediaBase, the upload id checked), size, alt and loading. */
export function productPhoto(ctx: ShopRenderContext, product: Product, i: number, lazy: boolean): SafeHtml {
  const photo = product.photos?.[i];
  if (photo === undefined) throw new Error(`${product.slug} has no photo ${i + 1}`);
  if (!isRecordId(photo.upload)) throw new Error(`Invalid upload id: ${JSON.stringify(photo.upload)}`);
  const src = safeUrl(productPhotoUrl(ctx.shop.mediaBase, photo), ["https:"]);
  return html`<img class="shop-photo" src="${src}" width="${photo.width}" height="${photo.height}" alt="${productPhotoAlt(product, i)}"${lazy && trusted(' loading="lazy"')} decoding="async">`;
}

/** The product's main picture: its first photo, else its tile. */
export function productMedia(ctx: ShopRenderContext, product: Product, { index, lazy }: { readonly index: number; readonly lazy: boolean }): SafeHtml {
  return product.photos === undefined || product.photos.length === 0 ? productTile(product, index) : productPhoto(ctx, product, 0, lazy);
}

/** Every photo of the product (the product page shows them all: no carousel, which would need JavaScript), else its tile. */
export function productPhotos(ctx: ShopRenderContext, product: Product): SafeHtml {
  const photos = product.photos ?? [];
  if (photos.length === 0) return productTile(product, 0);
  return html`<ul class="shop-photos" role="list">${photos.map((_, i) => html`<li>${productPhoto(ctx, product, i, i > 0)}</li>`)}</ul>`;
}

/**
 * The client's former price for the product or one variant, when the client confirmed former prices (contract §2.5)
 * and it is above the price it sits next to; else undefined. A variant without its own takes the product's.
 */
export function formerPriceCents(product: Product, settings: ShopSettings | undefined, variant?: ProductVariant): number | undefined {
  if (settings?.formerPricesConfirmed !== true) return undefined;
  const price = variant === undefined ? product.priceCents : variantPriceCents(product, variant);
  const was = variant === undefined ? product.compareAtCents : (variant.compareAtCents ?? product.compareAtCents);
  return was !== undefined && was > price ? was : undefined;
}

/** What the price line shows: one price (with "Was" when it applies), or "From" the lowest when variant prices differ. */
function shownPrice(product: Product, settings: ShopSettings | undefined): { readonly now: string; readonly was: number | undefined } {
  if (product.variants === undefined) return { now: formatUsd(product.priceCents, "short"), was: formerPriceCents(product, settings) };
  const { low, high } = priceRangeCents(product);
  if (low !== high) return { now: `${SHOP_TEXT.from} ${formatUsd(low, "short")}`, was: undefined };
  const formers = new Set(product.variants.map((v) => formerPriceCents(product, settings, v)));
  const [only] = formers;
  return { now: formatUsd(low, "short"), was: formers.size === 1 ? only : undefined };
}

/** The price line: "$50", "$50 Was $60" (the word carries the meaning; the strike is decoration), or "From $45". */
export function productPrice(product: Product, settings: ShopSettings | undefined): SafeHtml {
  const { now, was } = shownPrice(product, settings);
  return html`<p class="shop-price"><span class="visually-hidden">${SHOP_TEXT.price}</span><span class="shop-price__now">${now}</span>${was !== undefined && html` <s class="shop-price__was">${SHOP_TEXT.was} ${formatUsd(was, "short")}</s>`}</p>`;
}

/** "Sold out": text, never colour alone (WCAG 1.4.1). Shown only from the facts (isBuyable). */
export function soldOutBadge(): SafeHtml {
  return html`<span class="shop-badge">${SHOP_TEXT.soldOut}</span>`;
}

const hidden = (name: string, value: string): SafeHtml => html`<input type="hidden" name="${name}" value="${value}">`;

function checkedProductId(product: Product): string {
  if (!isRecordId(product.id)) throw new Error(`Invalid product id: ${JSON.stringify(product.id)}`);
  return product.id;
}

/** "M / Blue", plus the price when variant prices differ, its former price, and "(sold out)". */
function variantText(product: Product, settings: ShopSettings | undefined, variant: ProductVariant, pricesDiffer: boolean): string {
  const price = pricesDiffer ? `, ${formatUsd(variantPriceCents(product, variant), "short")}` : "";
  const former = formerPriceCents(product, settings, variant);
  const was = pricesDiffer && former !== undefined ? ` (${SHOP_TEXT.was.toLowerCase()} ${formatUsd(former, "short")})` : "";
  const soldOut = variant.soldOut === true || product.soldOut === true ? ` ${SHOP_TEXT.variantSoldOut}` : "";
  return `${variantLabel(product, variant)}${price}${was}${soldOut}`;
}

/**
 * The variant choice: ONE radio group (fieldset + legend from the option names, "Size / Colour"), one radio per listed
 * variant, posting `variant`. Radios, not a <select>: every choice and its price is visible at once, and a sold-out
 * one stays readable but disabled (GOV.UK and WCAG 1.4.1: the words say it). Nothing is pre-selected; every enabled
 * radio is `required` (a disabled control is barred from validation, so the first one alone could leave none).
 */
function variantChoice(product: Product, settings: ShopSettings | undefined, variants: readonly ProductVariant[]): SafeHtml {
  const { low, high } = priceRangeCents(product);
  const legend = product.options?.map((o) => o.name).join(" / ") || SHOP_TEXT.options;
  return html`<fieldset class="shop-variants">
<legend class="shop-variants__legend">${legend}</legend>
${variants.map((variant, i) => {
  if (!isRecordId(variant.id)) throw new Error(`Invalid variant id: ${JSON.stringify(variant.id)}`);
  const id = `add-variant-${i + 1}`;
  const off = variant.soldOut === true || product.soldOut === true;
  return html`<div class="shop-variant"><input class="shop-variant__input" type="radio" id="${id}" name="${CART_FIELD.variant}" value="${variant.id}"${off ? trusted(" disabled") : trusted(" required")}><label class="shop-variant__label" for="${id}">${variantText(product, settings, variant, low !== high)}</label></div>`;
})}
</fieldset>`;
}

/**
 * The product page's add form: POST /_cart with op=add, the product id, the variant (only when the product has
 * variants) and qty. The quantity is `type="text" inputmode="numeric"` (GOV.UK: type="number" changes value on a
 * scroll and accepts "e"), 1 by default, with its limit as a visible hint; the pages lane clamps it to maxQty. A
 * product nobody can buy (isBuyable) gets the "Sold out" text and no button. One per page (its ids are fixed).
 */
export function addToCartForm(ctx: ShopRenderContext, product: Product): SafeHtml {
  if (!isBuyable(product)) return html`<p class="shop-soldout">${SHOP_TEXT.soldOut}</p>`;
  const id = checkedProductId(product);
  const max = maxQtyOf(product);
  return html`<form class="shop-add" method="post" action="${shopUrl("cartAction")}">
${hidden(CART_FIELD.op, CART_OP.add)}
${hidden(CART_FIELD.product, id)}
${product.variants !== undefined && variantChoice(product, ctx.shop.settings, product.variants)}
<div class="shop-qty"><label class="shop-qty__label" for="add-qty">${SHOP_TEXT.quantity}</label><input class="shop-qty__input" id="add-qty" name="${CART_FIELD.qty}" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="2" value="1" data-max="${max}" autocomplete="off" required aria-describedby="add-qty-hint"><p class="shop-qty__hint" id="add-qty-hint">${SHOP_TEXT.upTo} ${max}</p></div>
<button class="shop-add__button" type="submit">${SHOP_TEXT.addToCart}<span class="visually-hidden">: ${product.name}</span></button>
</form>`;
}

/**
 * A card's action: "Add to cart" (POST, qty 1) for a product with no variants; "Choose options" (a link to its page,
 * because a choice is needed) when it has variants; nothing when nobody can buy it (its badge says why). Each names
 * its product for assistive tech after the visible words, so the visible label starts the name (WCAG 2.5.3).
 */
export function cardAction(product: Product): SafeHtml | false {
  if (!isBuyable(product)) return false;
  if (product.variants !== undefined) {
    return html`<a class="shop-card-options" href="${shopUrl({ product: product.slug })}">${SHOP_TEXT.chooseOptions}<span class="visually-hidden"> for ${product.name}</span></a>`;
  }
  return html`<form class="shop-card-add" method="post" action="${shopUrl("cartAction")}">${hidden(CART_FIELD.op, CART_OP.add)}${hidden(CART_FIELD.product, checkedProductId(product))}${hidden(CART_FIELD.qty, "1")}<button class="shop-card-add__button" type="submit">${SHOP_TEXT.addToCart}<span class="visually-hidden">: ${product.name}</span></button></form>`;
}

/**
 * A product card for a grid: media, the "Sold out" badge, the name (an h2 on the Shop page, an h3 under a section's h2)
 * linking to its page, the price and the action. `index` is its position: it picks the tile's colourway, and photos
 * from the 5th card on load lazily.
 */
export function productCard(ctx: ShopRenderContext, product: Product, { level, index }: { readonly level: 2 | 3; readonly index: number }): SafeHtml {
  const link = html`<a href="${shopUrl({ product: product.slug })}">${product.name}</a>`;
  return html`<li class="shop-card">
<div class="shop-card__media">${productMedia(ctx, product, { index, lazy: index >= 4 })}</div>
${!isBuyable(product) && soldOutBadge()}
${level === 2 ? html`<h2 class="shop-card__name">${link}</h2>` : html`<h3 class="shop-card__name">${link}</h3>`}
${productPrice(product, ctx.shop.settings)}
${cardAction(product)}
</li>`;
}

/** Cards in a list (role="list": Safari drops list semantics from a list styled without markers). */
export function productGridList(ctx: ShopRenderContext, products: readonly Product[], level: 2 | 3): SafeHtml {
  return html`<ul class="shop-grid" role="list">
${products.map((product, index) => productCard(ctx, product, { level, index }))}
</ul>`;
}

/** The "See all products" link to the Shop page. */
export function seeAllLink(): SafeHtml {
  return html`<a class="shop-see-all" href="${shopUrl("shop")}">${SHOP_TEXT.seeAll}</a>`;
}

/** Home / Shop / <Product>: the current page's link carries aria-current="page" (WAI-ARIA APG breadcrumb pattern). */
export function breadcrumb(ctx: ShopRenderContext, product: Product): SafeHtml {
  return html`<nav class="shop-crumbs" aria-label="Breadcrumb"><ol><li><a href="${pageLink(ctx, "home")}">${PAGES.home.label}</a></li><li><a href="${shopUrl("shop")}">${SHOP_TEXT.shop}</a></li><li><a href="${shopUrl({ product: product.slug })}" aria-current="page">${product.name}</a></li></ol></nav>`;
}

/**
 * The client's typed text as typed: paragraphs at blank lines, line breaks kept, nothing reworded (descriptions,
 * sizing, returns).
 */
export function typedText(text: string): SafeHtml {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  return html`<div class="shop-text">${paragraphs.map((p) => html`<p>${p.split("\n").map((line, i) => (i === 0 ? line : [html`<br>`, line]))}</p>`)}</div>`;
}

/** "Questions about this product? Call … or email …" (or "Ask about it: …" when it is sold out), from the facts. */
export function productQuestions(ctx: ShopRenderContext, product: Product): SafeHtml {
  const { phone, email } = ctx.doc.facts;
  const lead = isBuyable(product) ? html`${SHOP_TEXT.questions} Call` : html`${SHOP_TEXT.askAboutIt} call`;
  return html`<p class="shop-questions">${lead} <a href="${telUrl(phone)}">${formatPhone(phone)}</a> or email <a href="${mailtoUrl(email)}">${email}</a>.</p>`;
}
