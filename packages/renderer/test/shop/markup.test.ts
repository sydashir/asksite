import { describe, expect, it } from "vitest";
import { escapeAttr, escapeText } from "../../src/escape.ts";
import { CART_ACTION_PATH } from "../../src/shop/paths.ts";
import { CART_FIELD, CART_OP } from "../../src/shop/fields.ts";
import {
  addToCartForm,
  breadcrumb,
  cardAction,
  formerPriceCents,
  productCard,
  productGridList,
  productInitials,
  productMedia,
  productPhotos,
  productPrice,
  productQuestions,
  productTile,
  SHOP_TEXT,
  soldOutBadge,
  typedText,
} from "../../src/shop/markup.ts";
import type { Product } from "../../src/shop/model.ts";
import { FULL } from "../support/doc.ts";
import { attr, elements, find, hasClass, liveMarkup, textIn, textOf } from "./dom.ts";
import { PAYLOADS } from "./payloads.ts";
import { BOSS_PRODUCT, MEDIA_BASE, ON_SALE, SETTINGS, shopContext, shopState, SOLD_OUT, UPLOADS, WITH_PHOTOS, WITH_VARIANTS } from "./support.ts";

const ctx = shopContext(FULL, shopState([BOSS_PRODUCT, WITH_PHOTOS, ON_SALE, WITH_VARIANTS, SOLD_OUT]));
const s = (value: unknown) => String(value);

describe("productInitials and the no-photo tile", () => {
  it.each([
    ["Mom Filpflop", "MF"],
    ["Canvas Beach Tote", "CB"],
    ["élan bowl", "ÉB"],
    ["3 pack socks", "3P"],
    ["  spaced   out  ", "SO"],
    ["& more", "M"],
    ["🌴🌴", ""],
    ["été hat", "ÉH"],
  ])("%j -> %j", (name, initials) => {
    expect(productInitials(name)).toBe(initials);
  });

  it("draws the initials on a decorative tile, cycling three colourways by position", () => {
    const tiles = [0, 1, 2, 3].map((i) => s(productTile(BOSS_PRODUCT, i)));
    expect(tiles[0]).toBe('<div class="shop-tile shop-tile--1" aria-hidden="true"><span class="shop-tile__mark">MF</span></div>');
    expect(tiles.map((t) => /shop-tile--(\d)/.exec(t)?.[1])).toEqual(["1", "2", "3", "1"]);
  });

  it("leaves the mark out when no word starts with a letter or digit", () => {
    expect(s(productTile({ ...BOSS_PRODUCT, name: "🌴" }, 0))).toBe('<div class="shop-tile shop-tile--1" aria-hidden="true"></div>');
  });

  it("is what a product without photos shows, everywhere", () => {
    expect(s(productMedia(ctx, BOSS_PRODUCT, { index: 2, lazy: true }))).toContain("shop-tile--3");
    expect(s(productPhotos(ctx, BOSS_PRODUCT))).toContain("shop-tile--1");
    expect(s(productMedia(ctx, { ...BOSS_PRODUCT, photos: [] }, { index: 0, lazy: false }))).toContain("shop-tile");
  });
});

describe("product photos", () => {
  it("use the media URL, size and the alt rule, lazy only when asked", () => {
    const [main] = find(s(productMedia(ctx, WITH_PHOTOS, { index: 0, lazy: false })), "img");
    expect(main && Object.fromEntries(main.attrs.map((a) => [a.name, a.value]))).toEqual({
      class: "shop-photo",
      src: `${MEDIA_BASE}${UPLOADS[0]}.webp`,
      width: "800",
      height: "1000",
      alt: "Canvas Beach Tote",
      decoding: "async",
    });
    expect(attr(find(s(productMedia(ctx, WITH_PHOTOS, { index: 5, lazy: true })), "img")[0]!, "loading")).toBe("lazy");
  });

  it("list every photo on the product page, the first eager and the rest lazy", () => {
    const imgs = find(s(productPhotos(ctx, WITH_PHOTOS)), "img");
    expect(imgs.map((i) => [attr(i, "alt"), attr(i, "loading")])).toEqual([
      ["Canvas Beach Tote", undefined],
      ["The tote's inside pockets", "lazy"],
      ["Canvas Beach Tote, photo 3", "lazy"],
    ]);
  });

  it("refuse an upload id that is not a record id, and a media base that is not https", () => {
    const bad = { ...WITH_PHOTOS, photos: [{ upload: "../../x", width: 1, height: 1 }] };
    expect(() => productMedia(ctx, bad, { index: 0, lazy: false })).toThrow("Invalid upload id");
    const http = shopContext(FULL, { ...shopState([WITH_PHOTOS]), mediaBase: "http://media.asksite.example/x/" });
    expect(() => productMedia(http, WITH_PHOTOS, { index: 0, lazy: false })).toThrow("Unsafe URL");
  });
});

describe("prices (short format; Was only from the client's attested former price)", () => {
  it("shows one price", () => {
    expect(s(productPrice(BOSS_PRODUCT, SETTINGS))).toBe('<p class="shop-price"><span class="visually-hidden">Price: </span><span class="shop-price__now">$50</span></p>');
    expect(textIn(s(productPrice({ ...BOSS_PRODUCT, priceCents: 4950 }, SETTINGS)))).toBe("Price: $49.50");
  });

  it("shows Was next to the price only when the former price is typed, attested and higher", () => {
    expect(textIn(s(productPrice(ON_SALE, SETTINGS)))).toBe("Price: $28 Was $36");
    expect(find(s(productPrice(ON_SALE, SETTINGS)), "s", "shop-price__was").map(textOf)).toEqual(["Was $36"]);
    expect(textIn(s(productPrice(ON_SALE, { ...SETTINGS, formerPricesConfirmed: undefined } as never)))).toBe("Price: $28");
    expect(textIn(s(productPrice(ON_SALE, undefined)))).toBe("Price: $28");
    expect(textIn(s(productPrice({ ...ON_SALE, compareAtCents: 2800 }, SETTINGS)))).toBe("Price: $28");
    expect(textIn(s(productPrice({ ...ON_SALE, compareAtCents: 2000 }, SETTINGS)))).toBe("Price: $28");
  });

  it("shows From the lowest when variant prices differ, and one price when they do not", () => {
    expect(textIn(s(productPrice(WITH_VARIANTS, SETTINGS)))).toBe("Price: From $42");
    const same: Product = { ...WITH_VARIANTS, variants: WITH_VARIANTS.variants!.map(({ priceCents: _p, compareAtCents: _c, ...v }) => v) };
    expect(textIn(s(productPrice(same, SETTINGS)))).toBe("Price: $42");
    const allWas: Product = { ...same, compareAtCents: 5000 };
    expect(textIn(s(productPrice(allWas, SETTINGS)))).toBe("Price: $42 Was $50");
  });

  it("formerPriceCents: a variant takes its own former price, else the product's, only above its own price", () => {
    const [v1, , , v4, v5] = WITH_VARIANTS.variants!;
    expect(formerPriceCents(WITH_VARIANTS, SETTINGS, v5)).toBe(5200);
    expect(formerPriceCents(WITH_VARIANTS, SETTINGS, v4)).toBeUndefined();
    expect(formerPriceCents({ ...WITH_VARIANTS, compareAtCents: 4500 }, SETTINGS, v1)).toBe(4500);
    expect(formerPriceCents({ ...WITH_VARIANTS, compareAtCents: 4500 }, SETTINGS, v4)).toBeUndefined();
  });
});

describe("the add-to-cart form (product page)", () => {
  const form = s(addToCartForm(ctx, BOSS_PRODUCT));
  const [el] = find(form, "form");

  it("posts to the cart endpoint with op=add, the product id and qty", () => {
    expect([attr(el!, "method"), attr(el!, "action"), attr(el!, "class")]).toEqual(["post", CART_ACTION_PATH, "shop-add"]);
    expect(find(form, "input").map((i) => [attr(i, "type"), attr(i, "name"), attr(i, "value")])).toEqual([
      ["hidden", CART_FIELD.op, CART_OP.add],
      ["hidden", CART_FIELD.product, BOSS_PRODUCT.id],
      ["text", CART_FIELD.qty, "1"],
    ]);
    expect(find(form, "input", "shop-variant__input")).toEqual([]);
  });

  it("labels the quantity, a numeric text field (GOV.UK), with its limit as a visible hint", () => {
    const [qty] = find(form, "input", "shop-qty__input");
    expect(Object.fromEntries(qty!.attrs.map((a) => [a.name, a.value]))).toMatchObject({ id: "add-qty", inputmode: "numeric", pattern: "[0-9]*", "data-max": "10", required: "", "aria-describedby": "add-qty-hint" });
    expect(find(form, "label").map((l) => [attr(l, "for"), textOf(l)])).toEqual([["add-qty", "Quantity"]]);
    expect(textOf(elements(form).find((e) => attr(e, "id") === "add-qty-hint")!)).toBe("Up to 10");
    expect(s(addToCartForm(ctx, WITH_VARIANTS))).toContain('data-max="4"');
  });

  it("names its button with the visible words first (WCAG 2.5.3)", () => {
    const [button] = find(form, "button");
    expect([attr(button!, "type"), textOf(button!)]).toEqual(["submit", "Add to cart: Mom Filpflop"]);
    expect(find(form, "span", "visually-hidden").map(textOf)).toEqual([": Mom Filpflop"]);
  });

  it("offers the listed variants as one radio group, sold-out ones disabled and labelled, nothing pre-selected", () => {
    const variants = s(addToCartForm(ctx, WITH_VARIANTS));
    expect(find(variants, "legend").map(textOf)).toEqual(["Size / Colour"]);
    const radios = find(variants, "input", "shop-variant__input");
    expect(radios.map((r) => [attr(r, "name"), attr(r, "value"), attr(r, "disabled") !== undefined, attr(r, "required") !== undefined, attr(r, "checked")])).toEqual(
      WITH_VARIANTS.variants!.map((v) => [CART_FIELD.variant, v.id, v.soldOut === true, v.soldOut !== true, undefined]),
    );
    expect(find(variants, "label", "shop-variant__label").map(textOf)).toEqual(["7 / Sand, $42", "8 / Sand, $42", "9 / Sand, $42 (sold out)", "8 / Navy, $46", "9 / Navy, $46 (was $52)"]);
    for (const r of radios) expect(find(variants, "label").some((l) => attr(l, "for") === attr(r, "id"))).toBe(true);
  });

  it("leaves prices out of the variant labels when they are all the same", () => {
    const same: Product = { ...WITH_VARIANTS, variants: WITH_VARIANTS.variants!.map(({ priceCents: _p, compareAtCents: _c, ...v }) => v) };
    expect(find(s(addToCartForm(ctx, same)), "label", "shop-variant__label").map(textOf)).toEqual(["7 / Sand", "8 / Sand", "9 / Sand (sold out)", "8 / Navy", "9 / Navy"]);
  });

  it("shows the visible text Sold out and no form or button when nothing can be bought", () => {
    for (const p of [SOLD_OUT, { ...WITH_VARIANTS, variants: WITH_VARIANTS.variants!.map((v) => ({ ...v, soldOut: true as const })) }]) {
      const out = s(addToCartForm(ctx, p));
      expect(out).toBe('<p class="shop-soldout">Sold out</p>');
      expect(find(out, "button")).toEqual([]);
    }
  });

  it("refuses ids that are not record ids", () => {
    expect(() => addToCartForm(ctx, { ...BOSS_PRODUCT, id: '"><x' })).toThrow("Invalid product id");
    expect(() => addToCartForm(ctx, { ...WITH_VARIANTS, variants: [{ id: "v1", values: ["7", "Sand"] }] })).toThrow("Invalid variant id");
  });
});

describe("cards and the grid", () => {
  it("a card: media, badge, linked name at the given level, price, action", () => {
    const card = s(productCard(ctx, SOLD_OUT, { level: 3, index: 4 }));
    expect(elements(card).map((e) => e.tagName)).toEqual(["li", "div", "div", "span", "span", "h3", "a", "p", "span", "span"]);
    expect(find(card, "a").map((a) => attr(a, "href"))).toEqual(["/shop/kids-flip-flop"]);
    expect(textOf(find(card, "span", "shop-badge")[0]!)).toBe("Sold out");
    expect(find(s(productCard(ctx, BOSS_PRODUCT, { level: 2, index: 0 })), "h2", "shop-card__name").map(textOf)).toEqual(["Mom Filpflop"]);
    expect(find(s(productCard(ctx, WITH_PHOTOS, { level: 3, index: 4 })), "img").map((i) => attr(i, "loading"))).toEqual(["lazy"]);
    expect(find(s(productCard(ctx, WITH_PHOTOS, { level: 3, index: 3 })), "img").map((i) => attr(i, "loading"))).toEqual([undefined]);
  });

  it("card actions: Add to cart with qty 1, Choose options for variants, nothing when sold out", () => {
    const add = s(cardAction(BOSS_PRODUCT));
    expect([attr(find(add, "form")[0]!, "method"), attr(find(add, "form")[0]!, "action")]).toEqual(["post", "/_cart"]);
    expect(find(add, "input").map((i) => [attr(i, "type"), attr(i, "name"), attr(i, "value")])).toEqual([
      ["hidden", "op", "add"],
      ["hidden", "product", BOSS_PRODUCT.id],
      ["hidden", "qty", "1"],
    ]);
    expect(textIn(add)).toBe("Add to cart: Mom Filpflop");
    const options = s(cardAction(WITH_VARIANTS));
    expect([attr(find(options, "a")[0]!, "href"), textIn(options)]).toEqual(["/shop/everyday-slide", "Choose options for Everyday Slide"]);
    expect(cardAction(SOLD_OUT)).toBe(false);
  });

  it("the grid is a list with list semantics kept", () => {
    const grid = s(productGridList(ctx, [BOSS_PRODUCT, ON_SALE], 3));
    expect(find(grid, "ul").map((u) => [attr(u, "class"), attr(u, "role")])).toEqual([["shop-grid", "list"]]);
    expect(find(grid, "li", "shop-card")).toHaveLength(2);
  });
});

describe("breadcrumb, typed text and the questions line", () => {
  it("breadcrumb: Home / Shop / the product, the last marked current", () => {
    const crumbs = s(breadcrumb(ctx, BOSS_PRODUCT));
    expect(attr(find(crumbs, "nav")[0]!, "aria-label")).toBe("Breadcrumb");
    expect(find(crumbs, "a").map((a) => [attr(a, "href"), textOf(a), attr(a, "aria-current")])).toEqual([
      ["/", "Home", undefined],
      ["/shop", "Shop", undefined],
      ["/shop/mom-filpflop", "Mom Filpflop", "page"],
    ]);
  });

  it("typed text keeps the client's paragraphs and line breaks", () => {
    expect(s(typedText("One.\nTwo.\r\n\r\nThree.\n \n\n"))).toBe('<div class="shop-text"><p>One.<br>Two.</p><p>Three.</p></div>');
  });

  it("the questions line uses the facts' phone and email", () => {
    expect(textIn(s(productQuestions(ctx, BOSS_PRODUCT)))).toBe("Questions about this product? Call (512) 555-0142 or email office@example.com.");
    expect(textIn(s(productQuestions(ctx, SOLD_OUT)))).toBe("Ask about it: call (512) 555-0142 or email office@example.com.");
    expect(find(s(productQuestions(ctx, BOSS_PRODUCT)), "a").map((a) => attr(a, "href"))).toEqual(["tel:+15125550142", "mailto:office@example.com"]);
  });

  it("the badge is the words Sold out", () => {
    expect(s(soldOutBadge())).toBe('<span class="shop-badge">Sold out</span>');
  });
});

describe("escaping of client text (STRICT: the XSS cases of xss.test.ts)", () => {
  it.each(PAYLOADS)("%j in a name, an option, a value, a description and an alt is text, never markup", (payload) => {
    const p: Product = {
      ...WITH_VARIANTS,
      name: payload,
      description: payload,
      options: [{ name: payload, values: ["7", "8", "9"] }, { name: "Colour", values: [payload, "Navy"] }],
      variants: [{ id: "33333333-3333-4333-8333-333333333301", values: ["7", payload] }],
      photos: [{ upload: UPLOADS[0], width: 10, height: 10, alt: payload }],
    };
    const state = shopState([p]);
    const c = shopContext(FULL, state);
    const out = [
      productCard(c, p, { level: 2, index: 0 }),
      addToCartForm(c, p),
      breadcrumb(c, p),
      typedText(payload),
      productPhotos(c, p),
      productMedia(c, p, { index: 0, lazy: false }),
      cardAction(p),
      cardAction({ ...BOSS_PRODUCT, name: payload }),
    ].map(s);
    for (const markup of out) expect(liveMarkup(markup)).toEqual([]);
    const all = out.join("\n");
    // The payload reads back as the client typed it: as text, and in the alt attribute.
    expect(textIn(s(productCard(c, p, { level: 2, index: 0 })))).toContain(payload.trim().split("\n")[0]);
    expect(find(s(productPhotos(c, p)), "img").map((i) => attr(i, "alt"))).toEqual([payload]);
    expect(all).toContain(escapeText(payload.split("\n")[0]!.trim()));
    expect(all).toContain(`alt="${escapeAttr(payload)}"`);
  });

  it("refuses a slug that is not the contract's (no link is ever built from it)", () => {
    expect(() => productCard(ctx, { ...BOSS_PRODUCT, slug: "javascript:alert(1)" }, { level: 2, index: 0 })).toThrow("Invalid product slug");
    expect(() => breadcrumb(ctx, { ...BOSS_PRODUCT, slug: "../cart" })).toThrow("Invalid product slug");
  });
});

describe("honest copy: the shop blocks' own words (contract §5)", () => {
  // Shipping, delivery, pickup, sizing, returns, payment, stock/scarcity, sale and quality words of our own (F1-F3, G2,
  // S4, S7). "Was" is drawn only from the client's attested former price (tested above), so it is not listed here.
  const BANNED =
    /\b(?:ship\w*|deliver\w*|pick ?up|curbside|siz(?:e|ing)\w*|fits?\b|returns?|exchange\w*|refund\w*|pay\w*|card|cash|in stock|stock|selling fast|few left|limited|sale|discount\w*|off\b|save\w*|deal\w*|clearance|promo\w*|quality|premium|best|finest|durable|comfort\w*|organic|natural|handmade|material\w*|free)\b|%/i;

  it("SHOP_TEXT holds none of them", () => {
    expect(Object.values(SHOP_TEXT).filter((t) => BANNED.test(t))).toEqual([]);
  });

  it("no block writes one when the client typed none", () => {
    const blocks = [
      ...[BOSS_PRODUCT, WITH_PHOTOS, ON_SALE, WITH_VARIANTS, SOLD_OUT].flatMap((p) => [productCard(ctx, p, { level: 2, index: 0 }), addToCartForm(ctx, p), productQuestions(ctx, p), breadcrumb(ctx, p)]),
      productGridList(ctx, [BOSS_PRODUCT, SOLD_OUT], 3),
    ].map(s);
    // The client's own words are allowed (staff typed them): product names, option names and values, the email.
    const products = [BOSS_PRODUCT, WITH_PHOTOS, ON_SALE, WITH_VARIANTS, SOLD_OUT];
    const clientWords = [...products.flatMap((p) => [p.name, ...(p.options ?? []).flatMap((o) => [o.name, ...o.values])]), "office@example.com"];
    const texts = blocks.map((b) => clientWords.reduce((text, word) => text.replaceAll(word, ""), textIn(b)));
    expect(texts.filter((t) => BANNED.test(t))).toEqual([]);
    // The RED proof of the check itself.
    expect(BANNED.test("Free shipping on every order")).toBe(true);
    expect(BANNED.test("Only a few left in stock")).toBe(true);
    expect(BANNED.test("20% off")).toBe(true);
    expect(hasClass(elements('<p class="a b">x</p>')[0]!, "b")).toBe(true);
  });
});
