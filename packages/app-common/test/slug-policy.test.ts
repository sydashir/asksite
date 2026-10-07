import { describe, expect, it } from "vitest";
import { BLOCKED_WORDS, BRAND_SLUGS, slugFlags, slugProblem } from "../src/slug-policy.ts";

describe("slugProblem", () => {
  it.each(["joes-plumbing", "austin-hvac-pros", "abc", "a1-roofing", "green-thumb-lawn-care"])("accepts %s", (slug) => {
    expect(slugProblem(slug)).toBeNull();
  });

  it("keeps the shape and reserved-word checks from @asksite/core", () => {
    expect(slugProblem("ab")).toBe("invalid");
    expect(slugProblem("Joes")).toBe("invalid");
    expect(slugProblem("joes--plumbing")).toBe("invalid");
    expect(slugProblem("-joes")).toBe("invalid");
    expect(slugProblem("admin")).toBe("reserved");
    expect(slugProblem("send")).toBe("reserved");
  });

  it.each(["paypal", "wells-fargo", "wellsfargo", "bank-of-america", "irs", "usps", "home-depot", "rotorooter", "asksite"])(
    "blocks the brand or agency name %s",
    (slug) => {
      expect(slugProblem(slug)).toBe("blocked");
    },
  );

  it.each(["fuck-plumbing", "joes-shit-hauling", "shit", "cunt", "nazi-roofing", "kkk"])("blocks the word in %s", (slug) => {
    expect(slugProblem(slug)).toBe("blocked");
  });

  // Real business and place names that a naive substring filter would block.
  it.each([
    "spic-and-span-cleaning",
    "dickson-electric",
    "cumming-hvac",
    "hancock-roofing",
    "middlesex-plumbing",
    "scunthorpe-plumbing",
    "cockrell-roofing",
    "dick-smith-plumbing",
    "pineapple-cleaning",
    "chase-hvac",
  ])("does not block the real name %s", (slug) => {
    expect(slugProblem(slug)).toBeNull();
  });

  it("stores every list entry in slug form (lower case letters and digits, no hyphen)", () => {
    for (const word of [...BRAND_SLUGS, ...BLOCKED_WORDS]) expect(word).toMatch(/^[a-z0-9]+$/);
    expect(BRAND_SLUGS.size).toBeGreaterThanOrEqual(150);
  });
});

describe("slugFlags", () => {
  it("returns nothing for an ordinary name", () => {
    expect(slugFlags("joes-plumbing")).toEqual([]);
  });

  it("flags a brand used as a word, a phishing word, digits and profanity for the human reviewer", () => {
    expect(slugFlags("chase-hvac")).toEqual(["brand:chase"]);
    expect(slugFlags("paypal-refund-help")).toEqual(["brand:paypal", "word:refund"]);
    expect(slugFlags("secure-login-plumbing")).toEqual(["word:secure", "word:login"]);
    expect(slugFlags("plumber-5125550142")).toEqual(["digits"]);
    expect(slugFlags("dickson-electric")).toEqual(["profanity"]);
  });

  it("flags a brand hidden inside one long word when the brand has 6 or more letters", () => {
    expect(slugFlags("mypaypalhelp")).toEqual(["brand:paypal"]);
    expect(slugFlags("pineapple-cleaning")).toEqual([]);
  });
});
