// The shop's URLs: the one place the renderer writes them, so phase 2 swaps them for lane A's constants (shop
// contract §2.7) and the pages lane's routes (pages-proposal §1.3) in one place. html.ts's shopUrl() is the only code
// that turns them into a link (a SafeUrl).

// mirrors site-schema pages.ts §2.7; replaced by the import in phase 2
export const SHOP_PATH = "/shop";
// mirrors site-schema pages.ts §2.7; replaced by the import in phase 2
export const PRODUCT_PATH_PREFIX = "/shop/";
// mirrors site-schema pages.ts §2.7; replaced by the import in phase 2
export const CART_PATH = "/cart";

/** The cart endpoint every cart form posts to: op=add|set|remove (pages-proposal §1.3). */
export const CART_ACTION_PATH = "/_cart";

/** A record id as core's isId() checks it (packages/core/src/ids.ts:5): a lower-case v4 UUID. */
export const isRecordId = (id: unknown): id is string =>
  typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);

/** The product slug rule (contract §2.3 ProductSlug): lower-case letters, digits and single dashes, 1-50 long. */
export const isProductSlug = (slug: unknown): slug is string =>
  typeof slug === "string" && /^(?:[a-z0-9]|[a-z0-9](?:[a-z0-9]|-(?!-)){0,48}[a-z0-9])$/.test(slug);

/** The order endpoint, "/_o/<siteId>" (pages-proposal §1.6); throws unless siteId is a record id. */
export function orderActionPath(siteId: string): string {
  if (!isRecordId(siteId)) throw new Error(`Invalid site id: ${JSON.stringify(siteId)}`);
  return `/_o/${siteId}`;
}
