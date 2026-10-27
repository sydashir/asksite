import type { RenderContext, ShopState } from "../context.ts";
import type { SafeHtml } from "../html.ts";
import type { Product } from "./model.ts";

/** The context of a page on a site with products: ctx.shop is always there. */
export type ShopRenderContext = RenderContext & { readonly shop: ShopState };

/** How a product block is drawn: its heading, its heading level, and at most how many products. */
export interface ProductGridOptions {
  /** The block's heading: "Shop". */
  readonly heading: string;
  /** 1 on the Shop page (its one <h1>; each card's name an h2); 2 on Home (an h2; each card's name an h3). */
  readonly level: 1 | 2;
  /** Home: 4, with "See all products" (shop/markup.ts seeAllLink) when there are more. The Shop page: absent (all). */
  readonly limit?: number;
}

/**
 * What each design's shop.ts exports (src/designs/<design>/shop.ts), drawn in the design's own header, footer, tokens,
 * type and spacing; shop/designs.ts collects them. The blocks come from shop/markup.ts, so the class names, fields and
 * fixed words are the same in all three designs. The cart and order-sent pages are not here: they are shells whose
 * slot the sites Worker fills with shop/cart-markup.ts (ADDENDUM 2).
 */
export interface ShopDesign {
  /**
   * Home's product block (level 2, limit 4) and the Shop page's (level 1, every product), in the products' order.
   * One product is a FEATURE (a deliberate featured layout, never one lonely small card).
   */
  renderProductGrid(ctx: ShopRenderContext, products: readonly Product[], options: ProductGridOptions): SafeHtml;
  /** A product page's content inside <main>: breadcrumb, photos, the <h1> name, price, add form, typed text, more products. */
  renderProductPage(ctx: ShopRenderContext, product: Product): SafeHtml;
}
