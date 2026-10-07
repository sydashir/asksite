import { Facts, isSafeUrl, SiteDocument } from "@asksite/site-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadFixture } from "../../../../fixtures/index.ts";
import { VALID_FACTS } from "../support/facts.ts";

// The owner app's browser floor is iOS/Safari 16.4 (P4-7), which has no URL.canParse (Safari 17+).
// The client runs these site-schema validators in the browser, so they must work without it (A9).
describe("site-schema validators without URL.canParse (iOS/Safari 16.4)", () => {
  const original = URL.canParse;
  beforeAll(() => {
    Reflect.deleteProperty(URL, "canParse");
  });
  afterAll(() => {
    Object.defineProperty(URL, "canParse", { value: original, configurable: true, writable: true });
  });

  it("runs with URL.canParse removed", () => {
    expect((URL as { canParse?: unknown }).canParse).toBeUndefined();
  });

  it("isSafeUrl accepts safe links and refuses the rest", () => {
    expect(isSafeUrl("https://example.com/a")).toBe(true);
    expect(isSafeUrl("tel:+15125550142", ["tel:"])).toBe(true);
    expect(isSafeUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeUrl("not a url")).toBe(false);
  });

  it("Facts accepts a social link and refuses one with credentials", () => {
    const withLink = (url: string) => ({ ...VALID_FACTS, socialLinks: [{ network: "facebook", url }] });
    expect(Facts.safeParse(withLink("https://facebook.com/joesplumbing")).success).toBe(true);
    expect(Facts.safeParse(withLink("https://user:pass@facebook.com/joesplumbing")).success).toBe(false);
  });

  it("SiteDocument accepts a full fixture", () => {
    expect(SiteDocument.safeParse(loadFixture("plumber-austin")).success).toBe(true);
  });
});
