import { describe, expect, it } from "vitest";
import { addedText, addOptionValues, choiceName, combinations, PRODUCT_SLUG, productStatus, slugFromName, syncVariants, variantsProblem, type ProductOptionDraft, type VariantDraft } from "../../src/client/shop/catalog.ts";
import { productErrors } from "../../src/client/shop/product-errors.ts";
import { buyerMailto, emptyOrdersText, filterLabel, lineText, linesSummary, type OrderLine } from "../../src/client/shop/orders.ts";

describe("addOptionValues: the sizes or colors an owner types", () => {
  it("adds one value, or several separated by commas, trimmed, in order", () => {
    expect(addOptionValues([], "6")).toEqual({ values: ["6"], problems: [], added: ["6"] });
    expect(addOptionValues(["6"], " 7 ,8,  9  ")).toEqual({ values: ["6", "7", "8", "9"], problems: [], added: ["7", "8", "9"] });
  });

  it("skips blank parts and squeezes inner spaces", () => {
    expect(addOptionValues([], " , ,Extra   large,, ")).toEqual({ values: ["Extra large"], problems: [], added: ["Extra large"] });
    expect(addOptionValues(["S"], "   ")).toEqual({ values: ["S"], problems: [], added: [] });
  });

  it("leaves out a value already in the list, in any letter case, and names it", () => {
    expect(addOptionValues(["Red"], "red, Blue, BLUE")).toEqual({
      values: ["Red", "Blue"],
      problems: ["“red” is already in the list.", "“BLUE” is already in the list."],
      added: ["Blue"],
    });
  });

  it("leaves out a value that is too long, counting characters people see (emoji count once)", () => {
    const limits = { maxValues: 20, maxLength: 3 };
    expect(addOptionValues([], "🩴🩴🩴", limits).values).toEqual(["🩴🩴🩴"]);
    expect(addOptionValues([], "XXXL", limits)).toEqual({ values: [], problems: ["“XXXL” is too long. Keep each one to 3 characters."], added: [] });
  });

  it("uses the contract's limits by default: 10 values of up to 20 characters", () => {
    expect(addOptionValues([], "x".repeat(20)).added).toEqual(["x".repeat(20)]);
    expect(addOptionValues([], "x".repeat(21)).added).toEqual([]);
    expect(addOptionValues([], "1,2,3,4,5,6,7,8,9,10,11")).toMatchObject({ added: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"], problems: ["“11” was not added: the list holds up to 10."] });
  });

  it("stops at the limit and says which values did not fit", () => {
    expect(addOptionValues(["S", "M"], "L, XL", { maxValues: 3, maxLength: 30 })).toEqual({
      values: ["S", "M", "L"],
      problems: ["“XL” was not added: the list holds up to 3."],
      added: ["L"],
    });
  });

  it("never changes the list it was given", () => {
    const values = ["S"];
    addOptionValues(values, "M");
    expect(values).toEqual(["S"]);
  });
});

describe("addedText", () => {
  it.each([
    [[], ""],
    [["6"], "Added 6."],
    [["6", "7"], "Added 6 and 7."],
    [["6", "7", "8"], "Added 6, 7 and 8."],
  ])("%j says %j", (added, text) => {
    expect(addedText(added)).toBe(text);
  });
});

describe("combinations and syncVariants: one row for every combination of choices", () => {
  const size: ProductOptionDraft = { name: "Size", values: ["6", "7"] };
  const color: ProductOptionDraft = { name: "Color", values: ["Red", "Blue"] };

  it("has no rows without values", () => {
    expect(combinations([])).toEqual([]);
    expect(combinations([{ name: "Size", values: [] }])).toEqual([]);
  });

  it("lists every combination in typed order, skipping an option with no values", () => {
    expect(combinations([size])).toEqual([["6"], ["7"]]);
    expect(combinations([size, color])).toEqual([["6", "Red"], ["6", "Blue"], ["7", "Red"], ["7", "Blue"]]);
    expect(combinations([{ name: "Size", values: [] }, color])).toEqual([["Red"], ["Blue"]]);
  });

  const row = (values: string[], more: Partial<VariantDraft> = {}): VariantDraft => ({ id: null, values, offered: true, priceText: "", compareAtText: "", soldOut: false, ...more });

  it("keeps a combination's row (id, prices, marks), starts new ones offered and empty, drops gone ones", () => {
    const before = [row(["6"], { id: "v6", priceText: "8.50" }), row(["7"], { id: "v7", soldOut: true, offered: false, compareAtText: "12" }), row(["5"], { id: "v5" })];
    expect(syncVariants([{ name: "Size", values: ["7", "6", "8"] }], before)).toEqual([before[1], before[0], row(["8"])]);
  });

  it("starts fresh rows when a second option is added (a size alone is not a size and color)", () => {
    const before = [row(["6"], { id: "v6", priceText: "8.50", soldOut: true })];
    expect(syncVariants([{ name: "Size", values: ["6"] }, { name: "Color", values: ["Red"] }], before)).toEqual([row(["6", "Red"])]);
  });

  it("counts only offered rows against the limit of 20", () => {
    const rows = Array.from({ length: 21 }, (_, i) => row([String(i)]));
    expect(variantsProblem(rows)).toBe("21 choices are offered; a product can have up to 20. Uncheck the ones the shop doesn't sell, or remove some sizes or colors.");
    expect(variantsProblem(rows.map((r, i) => (i === 0 ? { ...r, offered: false } : r)))).toBeNull();
  });

  it("names a combination with its option names", () => {
    expect(choiceName([size, color], ["7", "Red"])).toBe("Size 7, Color Red");
    expect(choiceName([{ name: "  ", values: ["S"] }], ["S"])).toBe("Option S");
    expect(choiceName([{ name: "Size", values: [] }, color], ["Red"])).toBe("Color Red");
  });
});

describe("productStatus: always in words", () => {
  it.each([
    [{ soldOut: true, soldOutChoices: ["Size 8"] }, [{ text: "Sold out", tone: "neutral" }]],
    [{ soldOut: false, soldOutChoices: [] }, [{ text: "On sale", tone: "brand" }]],
    [{ soldOut: false, soldOutChoices: ["Size 8"] }, [{ text: "On sale", tone: "brand" }, { text: "Size 8 sold out", tone: "neutral" }]],
    [{ soldOut: false, soldOutChoices: ["Size 8", "Size 9"] }, [{ text: "On sale", tone: "brand" }, { text: "2 choices sold out", tone: "neutral" }]],
  ])("%j", (product, words) => {
    expect(productStatus(product)).toEqual(words);
  });
});

describe("order words", () => {
  const line = (name: string, choice: string | null, quantity: number): OrderLine => ({ name, choice, quantity, unitCents: 990, lineCents: 990 * quantity });

  it("writes a line with its choice and quantity", () => {
    expect(lineText(line("Mom Flipflop", "Size 8", 2))).toBe("Mom Flipflop (Size 8) × 2");
    expect(lineText(line("Beach Tote", null, 1))).toBe("Beach Tote × 1");
  });

  it("sums up the lines as the first one and how many more", () => {
    expect(linesSummary([])).toBe("No items");
    expect(linesSummary([line("Beach Tote", null, 1)])).toBe("Beach Tote × 1");
    expect(linesSummary([line("Mom Flipflop", "Size 8", 2), line("Kid Flipflop", "Size 6", 1)])).toBe("Mom Flipflop (Size 8) × 2 and 1 more");
  });

  it("labels the filters, with a count only when there is one", () => {
    expect(filterLabel("new", 2)).toBe("New (2)");
    expect(filterLabel("all", undefined)).toBe("All");
  });

  it("says what an empty filter means", () => {
    expect(emptyOrdersText("all", "Hip Hop Flip Flopp")).toBe("No orders yet. When someone orders from the website, it shows up here and Hip Hop Flip Flopp gets an email.");
    expect(emptyOrdersText("new", "x")).toBe("No new orders. Orders you have opened are under Open.");
  });
});

describe("buyerMailto: a link only for a plain address", () => {
  const order = (email: string | null) => ({ number: 1042, buyer: { name: "Maria", email, phone: null, address: null } });

  it("puts the order in the subject", () => {
    expect(buyerMailto(order("maria@example.com"), "Hip Hop & Co")).toBe("mailto:maria@example.com?subject=Your%20order%20%231042%20from%20Hip%20Hop%20%26%20Co");
  });

  it.each([null, "maria@example.com?cc=x@evil.example", "a@b.com&body=hi", "a@b.com#x", "a%40b.com", "a b@c.com"])("gives no link for %j", (email) => {
    expect(buyerMailto(order(email), "Shop")).toBeNull();
  });
});

describe("slugFromName: a product's link from its name, always a valid link", () => {
  it.each([
    ["Mom Flipflop", "mom-flipflop"],
    ["Mom Flipflop, extra soft summer edition, size 6-11", "mom-flipflop-extra-soft-summer-edition-size-6-11"],
    ["  Crème Brûlée Candle  ", "creme-brulee-candle"],
    ["Hip Hop 🩴 Flip--Flop!!", "hip-hop-flip-flop"],
    ["🩴🩴", "product"],
    ["", "product"],
    ["A".repeat(60), "a".repeat(50)],
    [`${"a".repeat(49)} b`, "a".repeat(49)],
  ])("%j becomes %j", (name, slug) => {
    expect(slugFromName(name)).toBe(slug);
    expect(PRODUCT_SLUG.test(slug)).toBe(true);
  });
});

describe("productErrors: each product field's own check (NEW texts)", () => {
  const base = {
    name: "Mom Flipflop",
    slug: "mom-flipflop",
    priceText: "9.90",
    compareAtText: "",
    description: "",
    soldOut: false,
    maxQtyText: "",
    photos: [{ upload: "u1", url: "https://example.com/a.webp", alt: "" }],
    options: [{ name: "Size", values: ["6", "7"] }],
    variants: [
      { id: "v6", values: ["6"], offered: true, priceText: "", compareAtText: "", soldOut: false },
      { id: "v7", values: ["7"], offered: false, priceText: "abc", compareAtText: "", soldOut: false },
    ],
  };
  const errors = (patch: object, path: ReadonlyArray<string | number>) => productErrors({ ...base, ...patch }, path);

  it("is quiet for a good product, and for a row that is not sold here", () => {
    for (const path of [["name"], ["slug"], ["price"], ["compareAt"], ["description"], ["maxQty"], ["photos", 0, "alt"], ["options", 0, "name"], ["variants", 0, "price"], ["variants", 1, "price"]]) {
      expect(errors({}, path)).toEqual([]);
    }
  });

  it("asks for a name and a link, and checks the link's form", () => {
    expect(errors({ name: "   " }, ["name"])).toEqual(["Give the product a name."]);
    expect(errors({ name: "x".repeat(121) }, ["name"])).toEqual(["Please use 120 characters or fewer."]);
    expect(errors({ slug: "" }, ["slug"])).toEqual(["Give the product a link, like mom-flipflop."]);
    for (const slug of ["Mom-Flipflop", "mom--flipflop", "-mom", "mom-", "mom flipflop", "x".repeat(51)]) {
      expect(errors({ slug }, ["slug"])).toEqual(["Use lower-case letters, numbers and single dashes, like mom-flipflop."]);
    }
  });

  it("checks prices with the money texts, and a size's empty price is fine", () => {
    expect(errors({ priceText: "" }, ["price"])).toEqual(["Enter a price for this product."]);
    expect(errors({ priceText: "9,90" }, ["price"])).toEqual(["Use a point for cents, like 9.99."]);
    expect(errors({ variants: [{ ...base.variants[0], priceText: "-1" }] }, ["variants", 0, "price"])).toEqual(["A price can't be below zero."]);
  });

  it("wants a “was” price above the price it sits next to", () => {
    expect(errors({ compareAtText: "9.90" }, ["compareAt"])).toEqual(["The “was” price must be higher than the price."]);
    expect(errors({ compareAtText: "12" }, ["compareAt"])).toEqual([]);
    // A size without its own price sits next to the product's price; with its own, next to that.
    expect(errors({ variants: [{ ...base.variants[0], compareAtText: "9" }] }, ["variants", 0, "compareAt"])).toEqual(["The “was” price must be higher than the price."]);
    expect(errors({ variants: [{ ...base.variants[0], priceText: "5", compareAtText: "9" }] }, ["variants", 0, "compareAt"])).toEqual([]);
  });

  it("takes a whole number from 1 to 99 as the most one buyer can order", () => {
    for (const ok of ["", "1", "10", "99", " 5 "]) expect(errors({ maxQtyText: ok }, ["maxQty"])).toEqual([]);
    for (const bad of ["0", "100", "1.5", "-1", "ten", "007"]) expect(errors({ maxQtyText: bad }, ["maxQty"])).toEqual(["Enter a whole number from 1 to 99, or leave it empty."]);
  });

  it("wants each list named, once", () => {
    expect(errors({ options: [{ name: "", values: ["6"] }] }, ["options", 0, "name"])).toEqual(["Name this list, like Size or Color."]);
    expect(errors({ options: [{ name: "", values: [] }] }, ["options", 0, "name"])).toEqual([]);
    expect(errors({ options: [{ name: "Size", values: ["6"] }, { name: " size ", values: ["Red"] }] }, ["options", 1, "name"])).toEqual(["Each list needs its own name."]);
  });
});
