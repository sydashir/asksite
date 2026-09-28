import { describe, expect, it } from "vitest";
import { ProviderError, TRANSIENT_KINDS } from "../src/provider.ts";

describe("ProviderError", () => {
  it("is an Error with a kind", () => {
    const error = new ProviderError("rate_limited", "HTTP 429");
    expect(error).toBeInstanceOf(Error);
    expect([error.name, error.kind, error.message]).toEqual(["ProviderError", "rate_limited", "HTTP 429"]);
  });

  it("carries noResponse only when it is set, and never as an own property holding undefined (P3-16 fix 5)", () => {
    expect(new ProviderError("unavailable", "fetch failed", { noResponse: true }).noResponse).toBe(true);
    expect(Object.hasOwn(new ProviderError("unavailable", "HTTP 503"), "noResponse")).toBe(false);
    expect(Object.hasOwn(new ProviderError("unavailable", "2xx", { afterHeaders: true }), "noResponse")).toBe(false);
  });

  it("treats timeouts, rate limits and outages as worth another attempt, and nothing else", () => {
    expect([...TRANSIENT_KINDS].sort()).toEqual(["rate_limited", "timeout", "unavailable"]);
  });
});
