import { describe, expect, it } from "vitest";
import { ProviderError } from "../src/provider.ts";
import { checkApiKey, sharesKeyFragment, tokenCount } from "../src/providers/shared.ts";

// P3-11 (l): a token count is usable only if it is a finite integer from 0 to 10,000,000. NaN and Infinity cannot
// come from a JSON body (JSON has no such values; 1e400 parses to Infinity), so they are tested here directly.
describe("tokenCount (P3-11 l)", () => {
  it.each([0, 1, 2900, 10_000_000])("keeps %s", (value) => {
    expect(tokenCount(value)).toBe(value);
  });

  it.each([
    ["-1", -1],
    ["1.5", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["1e308", 1e308],
    ["10,000,001", 10_000_001],
    ['the string "12"', "12"],
    ["null", null],
    ["undefined", undefined],
    ["true", true],
    ["an object", { value: 12 }],
  ])("refuses %s", (_name, value) => {
    expect(tokenCount(value)).toBeUndefined();
  });
});

const ch = (...codes: number[]): string => String.fromCodePoint(...codes);

// P3-11 (k): a key an HTTP header cannot carry as typed is refused at setup as auth, before any request. The Fetch
// Standard refuses NUL, CR and LF in a header value and anything above U+00FF (ByteString); RFC 9110 and Node's HTTP
// stack (undici headerCharRegex) refuse the other C0 controls and DEL too. Every control character is refused.
describe("checkApiKey (P3-11 k)", () => {
  it.each([
    ["an empty key", ""],
    ["spaces only", "   "],
    ["a tab only", ch(9)],
    ["no-break spaces only", ch(0xa0, 0xa0)],
    ["a newline inside", `sk-a${ch(10)}b`],
    ["a trailing newline", `sk-ab${ch(10)}`],
    ["a carriage return", `sk-a${ch(13)}b`],
    ["a NUL", `sk-a${ch(0)}b`],
    ["a tab inside", `sk-a${ch(9)}b`],
    ["a control character", `sk-a${ch(1)}b`],
    ["DEL", `sk-a${ch(0x7f)}b`],
    ["a C1 control", `sk-a${ch(0x85)}b`],
    ["an em dash (above U+00FF)", `sk-a${ch(0x2014)}b`],
    ["an emoji", `sk-a${ch(0x1f600)}b`],
  ])("refuses %s as auth, never naming the key", (_name, key) => {
    let error: unknown;
    try {
      checkApiKey(key, "TEST_API_KEY");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: "auth", message: "TEST_API_KEY is blank or holds a character an HTTP header cannot carry" });
  });

  it.each([
    ["a typical key", "sk-ant-api03-abc_DEF-123"],
    ["a single character", "k"],
    ["a space inside", "sk a"],
    ["a Latin-1 letter", `sk-${ch(0xe9)}`],
  ])("accepts %s", (_name, key) => {
    expect(() => checkApiKey(key, "TEST_API_KEY")).not.toThrow();
  });
});

// P3-11 (t): a provider token is left out of an error message when it shares any run of 8 or more characters with
// the key, ignoring case; a key shorter than 8 characters drops a token that holds the whole key, ignoring case.
describe("sharesKeyFragment (P3-11 t)", () => {
  const KEY = "gsk_live_abcDEF123";

  it.each(["gsk_live", "GSK_LIVE_x", "abcdef12", "bcdef123", "x_live_abcd", "invalid_gsk_live_abcdef123_key"])("finds a fragment of the key in %s", (token) => {
    expect(sharesKeyFragment(token, KEY)).toBe(true);
  });

  it.each(["invalid_api_key", "insufficient_quota", "blocked_api_access", "gsk_liv", "abcdef1", "live_ab", "rate_limit_exceeded"])("finds none in %s", (token) => {
    expect(sharesKeyFragment(token, KEY)).toBe(false);
  });

  it.each([
    ["xk1aby", true],
    ["K1AB", true],
    ["k1a", false],
    ["invalid_api_key", false],
  ])("matches a key shorter than 8 characters whole: %s gives %s", (token, found) => {
    expect(sharesKeyFragment(token, "k1aB")).toBe(found);
  });

  // The longest short key (review survivor A15: a threshold of 7 sends it to the 8-character windows, which never match).
  it.each([
    ["xK1AB2C3y", true],
    ["k1ab2c3", true],
    ["k1ab2c", false],
    ["1ab2c3x", false],
  ])("matches a key of 7 characters whole: %s gives %s", (token, found) => {
    expect(sharesKeyFragment(token, "k1aB2c3")).toBe(found);
  });

  it.each([
    ["xxabcdefghxx", true],
    ["abcdefg", false],
  ])("matches a key of exactly 8 characters whole: %s gives %s", (token, found) => {
    expect(sharesKeyFragment(token, "ABCDEFGH")).toBe(found);
  });
});
