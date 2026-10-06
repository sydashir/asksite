import { describe, expect, it } from "vitest";
import { fixedPageHeaders, livePageHeaders, mediaHeaders, pageCsp, rootHostname } from "../src/headers.ts";

describe("headers", () => {
  it("builds the page CSP from the root, port included", () => {
    expect(pageCsp("asksite.example")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src https://media.asksite.example; font-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    expect(pageCsp("localhost:8789")).toContain("img-src https://media.localhost:8789;");
  });

  // Bold (impact) embeds its heading font as a data: URI in its sheet (user decision 2026-09-27; A12). The page may
  // load fonts from data: URIs and from nowhere else: no host, no 'self', no wildcard, one font-src directive only.
  it("allows fonts from data: URIs only", () => {
    const directives = pageCsp("asksite.example").split("; ");
    expect(directives.filter((d) => d.startsWith("font-src"))).toEqual(["font-src data:"]);
    expect(directives.filter((d) => /\bdata:/.test(d))).toEqual(["font-src data:"]);
  });

  it("sends HSTS in production only", () => {
    expect(livePageHeaders("asksite.example", true).get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
    expect(fixedPageHeaders("asksite.example").get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
    expect(livePageHeaders("localhost:8789", true).get("strict-transport-security")).toBeNull();
    expect(fixedPageHeaders("dev.localhost:8789").get("strict-transport-security")).toBeNull();
  });

  it("adds noindex to a live page only when the site is not indexable", () => {
    expect(livePageHeaders("asksite.example", true).get("x-robots-tag")).toBeNull();
    expect(livePageHeaders("asksite.example", false).get("x-robots-tag")).toBe("noindex");
    expect(fixedPageHeaders("asksite.example").get("x-robots-tag")).toBe("noindex");
  });

  it("gives photos an hour in browsers and a minute at the edge", () => {
    expect(mediaHeaders().get("cache-control")).toBe("public, max-age=3600, s-maxage=60");
    expect(mediaHeaders().get("content-type")).toBe("image/webp");
  });

  it("strips the port from the root for email addresses", () => {
    expect(rootHostname("localhost:8789")).toBe("localhost");
    expect(rootHostname("asksite.example")).toBe("asksite.example");
  });
});
