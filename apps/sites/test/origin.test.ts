import { describe, expect, it } from "vitest";
import { isSameOriginPost } from "../src/origin.ts";

// Every shop POST must come from a page of the same host (pages lane proposal 1.3). All customer sites are subdomains
// of one root, so they are the same "site" for SameSite cookies, and a cookie travels on a post from one tenant's page
// to another's: SameSite is no guard. The rule: Origin equals this host's origin exactly; with no Origin,
// Sec-Fetch-Site must be same-origin; never same-site; neither header, refused.

const URL_ = "https://shop-one.asksite.example/_o/11111111-1111-4111-8111-111111111111";
const post = (headers: Record<string, string>, url = URL_) => new Request(url, { method: "POST", headers });

describe("isSameOriginPost", () => {
  it("accepts an Origin equal to the request's own origin", () => {
    expect(isSameOriginPost(post({ origin: "https://shop-one.asksite.example" }))).toBe(true);
    expect(isSameOriginPost(post({ origin: "https://shop-one.asksite.example", "sec-fetch-site": "same-origin" }))).toBe(true);
  });

  it("refuses another tenant, the root, another scheme or port, and the opaque null origin", () => {
    expect(isSameOriginPost(post({ origin: "https://shop-two.asksite.example" }))).toBe(false);
    expect(isSameOriginPost(post({ origin: "https://asksite.example" }))).toBe(false);
    expect(isSameOriginPost(post({ origin: "http://shop-one.asksite.example" }))).toBe(false);
    expect(isSameOriginPost(post({ origin: "https://shop-one.asksite.example:8443" }))).toBe(false);
    expect(isSameOriginPost(post({ origin: "null" }))).toBe(false);
    expect(isSameOriginPost(post({ origin: "https://shop-one.asksite.example.evil.example" }))).toBe(false);
  });

  it("refuses a mismatched Origin even when Sec-Fetch-Site claims same-origin", () => {
    expect(isSameOriginPost(post({ origin: "https://shop-two.asksite.example", "sec-fetch-site": "same-origin" }))).toBe(false);
  });

  it("without Origin, accepts only Sec-Fetch-Site same-origin: never same-site, cross-site or none", () => {
    expect(isSameOriginPost(post({ "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(isSameOriginPost(post({ "sec-fetch-site": "same-site" }))).toBe(false);
    expect(isSameOriginPost(post({ "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(isSameOriginPost(post({ "sec-fetch-site": "none" }))).toBe(false);
  });

  it("refuses a post with neither header", () => {
    expect(isSameOriginPost(post({}))).toBe(false);
  });

  it("works for local development over http with a port", () => {
    expect(isSameOriginPost(post({ origin: "http://shop-one.localhost:8789" }, "http://shop-one.localhost:8789/_cart"))).toBe(true);
    expect(isSameOriginPost(post({ origin: "http://shop-two.localhost:8789" }, "http://shop-one.localhost:8789/_cart"))).toBe(false);
  });
});
