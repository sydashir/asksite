import { describe, expect, it } from "vitest";
import { ProviderError, TRANSIENT_KINDS } from "../src/provider.ts";

describe("ProviderError", () => {
  it("is an Error with a kind", () => {
    const error = new ProviderError("rate_limited", "HTTP 429");
    expect(error).toBeInstanceOf(Error);
    expect([error.name, error.kind, error.message]).toEqual(["ProviderError", "rate_limited", "HTTP 429"]);
  });

  it("treats timeouts, rate limits and outages as worth another attempt, and nothing else", () => {
    expect([...TRANSIENT_KINDS].sort()).toEqual(["rate_limited", "timeout", "unavailable"]);
  });
});
