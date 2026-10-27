// STARTER shop blocks (B0): plain, design-neutral arrangements of shop/markup.ts, so every design draws a working shop
// before its own shop.ts exists. Each design builder replaces its designs/<design>/shop.ts (which re-exports these)
// with the design's own layout; nothing else imports this file.
import { html, shopUrl, type SafeHtml } from "../html.ts";
import type { ProductGridOptions, ShopRenderContext } from "./design.ts";
import {
  addToCartForm,
  breadcrumb,
  cardAction,
  productGridList,
  productMedia,
  productPhotos,
  productPrice,
  productQuestions,
  SHOP_TEXT,
  seeAllLink,
  soldOutBadge,
  typedText,
} from "./markup.ts";
import { isBuyable, type Product } from "./model.ts";

/** Fixed headings of the product page (NEW texts, for approval). */
export const PRODUCT_PAGE_TEXT = { sizing: "Sizing", returns: "Returns", more: "More from the shop", seeDetails: SHOP_TEXT.seeDetails } as const;

/** One product, featured: its media beside its name, price, description and action, plus "See details". */
function feature(ctx: ShopRenderContext, product: Product, level: 1 | 2): SafeHtml {
  const link = html`<a href="${shopUrl({ product: product.slug })}">${product.name}</a>`;
  return html`<article class="shop-feature">
<div class="shop-feature__media">${productMedia(ctx, product, { index: 0, lazy: false })}</div>
<div class="shop-feature__info">
${!isBuyable(product) && soldOutBadge()}
${level === 1 ? html`<h2 class="shop-feature__name">${link}</h2>` : html`<h3 class="shop-feature__name">${link}</h3>`}
${productPrice(product, ctx.shop.settings)}
${product.description !== undefined && typedText(product.description)}
${cardAction(product)}
<p><a class="shop-feature__details" href="${shopUrl({ product: product.slug })}">${PRODUCT_PAGE_TEXT.seeDetails}<span class="visually-hidden">: ${product.name}</span></a></p>
</div>
</article>`;
}

export function renderProductGrid(ctx: ShopRenderContext, products: readonly Product[], { heading, level, limit }: ProductGridOptions): SafeHtml {
  const [only] = products;
  if (only === undefined) throw new Error("A product block needs at least one product");
  const shown = limit === undefined ? products : products.slice(0, limit);
  const title = level === 1 ? html`<h1 class="shop-block__title" id="shop-title">${heading}</h1>` : html`<h2 class="shop-block__title" id="shop-title">${heading}</h2>`;
  return html`<section class="shop-block" id="shop" aria-labelledby="shop-title">
<div class="shop-wrap">
${title}
${products.length === 1 ? feature(ctx, only, level) : productGridList(ctx, shown, level === 1 ? 2 : 3)}
${shown.length < products.length && html`<p class="shop-block__more">${seeAllLink()}</p>`}
</div>
</section>`;
}

export function renderProductPage(ctx: ShopRenderContext, product: Product): SafeHtml {
  const { settings, products } = ctx.shop;
  const others = products.filter((p) => p.slug !== product.slug).slice(0, 4);
  return html`<div class="shop-wrap shop-product">
${breadcrumb(ctx, product)}
<div class="shop-product__layout">
<div class="shop-product__media">${productPhotos(ctx, product)}</div>
<div class="shop-product__info">
<h1 class="shop-product__name">${product.name}</h1>
${productPrice(product, settings)}
${!isBuyable(product) && soldOutBadge()}
${addToCartForm(ctx, product)}
${product.description !== undefined && typedText(product.description)}
${settings?.sizing !== undefined && html`<h2 class="shop-product__sub">${PRODUCT_PAGE_TEXT.sizing}</h2>${typedText(settings.sizing)}`}
${settings?.returns !== undefined && html`<h2 class="shop-product__sub">${PRODUCT_PAGE_TEXT.returns}</h2>${typedText(settings.returns)}`}
${productQuestions(ctx, product)}
</div>
</div>
${others.length > 0 && html`<section class="shop-more" aria-labelledby="shop-more-title"><h2 class="shop-more__title" id="shop-more-title">${PRODUCT_PAGE_TEXT.more}</h2>${productGridList(ctx, others, 3)}</section>`}
</div>`;
}
