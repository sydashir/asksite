import { DESIGN_IDS, type SiteDocumentInput } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { navItems } from "../../src/context.ts";
import { SHOP_DESIGNS } from "../../src/shop/designs.ts";
import * as neutral from "../../src/shop/neutral.ts";
import { FULL, makeContext, MINIMAL } from "../support/doc.ts";
import { BOSS_PRODUCT, ON_SALE, shopContext, shopState, SOLD_OUT, WITH_PHOTOS, WITH_VARIANTS } from "./support.ts";

const nav = (ctx: Parameters<typeof navItems>[0]) => navItems(ctx).map((i) => [String(i.href), i.label, i.current]);

describe("navItems on a site with products (context.ts)", () => {
  it("is unchanged on a site without products", () => {
    expect(nav(makeContext(FULL, "about"))).toEqual([
      ["/", "Home", false],
      ["/services", "Services", false],
      ["/about", "About", true],
      ["/gallery", "Gallery", false],
      ["/contact", "Contact", false],
    ]);
  });

  it("adds Shop after Services, and Cart last, for a business that also sells", () => {
    expect(nav(shopContext(FULL, shopState([BOSS_PRODUCT], undefined, false)))).toEqual([
      ["/", "Home", true],
      ["/services", "Services", false],
      ["/shop", "Shop", false],
      ["/about", "About", false],
      ["/gallery", "Gallery", false],
      ["/contact", "Contact", false],
      ["/cart", "Cart", false],
    ]);
  });

  it("puts Shop right after Home for a shop business", () => {
    expect(nav(shopContext(FULL, shopState([BOSS_PRODUCT], undefined, true))).map(([href]) => href)).toEqual(["/", "/shop", "/services", "/about", "/gallery", "/contact", "/cart"]);
  });

  it("puts Shop after Home when the site has no Services page", () => {
    // Every stored site has Services today (site-schema ALWAYS_PAGES); a pure shop drops it in phase 2.
    const ctx = shopContext(MINIMAL, shopState([BOSS_PRODUCT], undefined, false));
    const noServices = { ...ctx, pages: ctx.pages.filter((p) => p.id !== "services") };
    expect(nav(noServices).map(([href]) => href)).toEqual(["/", "/shop", "/contact", "/cart"]);
  });

  it("marks the Shop page or the cart current, and no site page, on a shop page", () => {
    const state = shopState([BOSS_PRODUCT]);
    const current = (ctx: Parameters<typeof navItems>[0]) => nav(ctx).filter(([, , c]) => c).map(([href]) => href);
    expect(current(shopContext(FULL, state, "shop"))).toEqual(["/shop"]);
    expect(current(shopContext(FULL, state, "cart"))).toEqual(["/cart"]);
    expect(current(shopContext(FULL, state, "product"))).toEqual([]);
    expect(current(shopContext(FULL, state, "sent"))).toEqual([]);
    expect(current(shopContext(FULL, state))).toEqual(["/"]);
  });
});

describe("the shop design registry (shop/designs.ts)", () => {
  it("has the shop blocks of every design", () => {
    expect(Object.keys(SHOP_DESIGNS)).toEqual([...DESIGN_IDS]);
    for (const id of DESIGN_IDS) {
      expect(typeof SHOP_DESIGNS[id].renderProductGrid).toBe("function");
      expect(typeof SHOP_DESIGNS[id].renderProductPage).toBe("function");
    }
    expect(Object.isFrozen(SHOP_DESIGNS)).toBe(true);
  });

  it("starts every design on the neutral starter blocks (B1-B3 replace them)", () => {
    // A STARTER pin: each design builder changes this expectation when its own shop.ts lands.
    for (const id of DESIGN_IDS) expect(SHOP_DESIGNS[id].renderProductGrid).toBe(neutral.renderProductGrid);
  });
});

describe("the neutral starter blocks", () => {
  const doc: SiteDocumentInput = FULL;
  it("draw one product as a feature with a See details link, and many as a grid with See all products past the limit", () => {
    const one = BOSS_PRODUCT;
    const solo = String(neutral.renderProductGrid(shopContext(doc, shopState([one])), [one], { heading: "Shop", level: 2, limit: 4 }));
    expect(solo).toContain('class="shop-feature"');
    expect(solo).toContain("See details");
    expect(solo).not.toContain("See all products");
    const five = [one, WITH_PHOTOS, ON_SALE, WITH_VARIANTS, SOLD_OUT];
    const home = String(neutral.renderProductGrid(shopContext(doc, shopState(five)), five, { heading: "Shop", level: 2, limit: 4 }));
    expect(home.match(/class="shop-card"/g)).toHaveLength(4);
    expect(home).toContain('<h2 class="shop-block__title" id="shop-title">Shop</h2>');
    expect(home).toContain('href="/shop">See all products</a>');
    const page = String(neutral.renderProductGrid(shopContext(doc, shopState(five), "shop"), five, { heading: "Shop", level: 1 }));
    expect(page.match(/class="shop-card"/g)).toHaveLength(5);
    expect(page).toContain('<h1 class="shop-block__title" id="shop-title">Shop</h1>');
    expect(page).not.toContain("See all products");
    expect(() => neutral.renderProductGrid(shopContext(doc, shopState(five)), [], { heading: "Shop", level: 2 })).toThrow("at least one product");
  });

  it("draw a product page with one h1, the add form and up to 4 other products", () => {
    const five = [BOSS_PRODUCT, WITH_PHOTOS, ON_SALE, WITH_VARIANTS, SOLD_OUT];
    const page = String(neutral.renderProductPage(shopContext(doc, shopState(five), "product"), WITH_VARIANTS));
    expect(page.match(/<h1\b/g)).toHaveLength(1);
    expect(page).toContain('<form class="shop-add" method="post" action="/_cart">');
    expect(page.match(/class="shop-card"/g)).toHaveLength(4);
    expect(page).not.toContain("/shop/everyday-slide\">Everyday Slide</a></h3>");
    const typed = shopState(five, { fulfilment: ["pickup"], sizing: "Runs small.", returns: "Exchanges within 14 days." });
    const withPolicies = String(neutral.renderProductPage(shopContext(doc, typed, "product"), BOSS_PRODUCT));
    expect(withPolicies).toContain('<h2 class="shop-product__sub">Sizing</h2><div class="shop-text"><p>Runs small.</p></div>');
    expect(withPolicies).toContain('<h2 class="shop-product__sub">Returns</h2><div class="shop-text"><p>Exchanges within 14 days.</p></div>');
    expect(String(neutral.renderProductPage(shopContext(doc, shopState(five), "product"), BOSS_PRODUCT))).not.toMatch(/Sizing|Returns/);
  });
});
