import { describe, expect, it } from "vitest";
import { fixedPageHeaders, livePageHeaders, mediaHeaders, pageCsp, rootHostname } from "../src/headers.ts";

describe("headers", () => {
  it("builds the page CSP from the root, port included", () => {
    expect(pageCsp("asksite.example")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src https://media.asksite.example; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    expect(pageCsp("localhost:8789")).toContain("img-src https://media.localhost:8789;");
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

  it("gives photos a day in browsers and five minutes at the edge", () => {
    expect(mediaHeaders().get("cache-control")).toBe("public, max-age=86400, s-maxage=300");
    expect(mediaHeaders().get("content-type")).toBe("image/webp");
  });

  it("strips the port from the root for email addresses", () => {
    expect(rootHostname("localhost:8789")).toBe("localhost");
    expect(rootHostname("asksite.example")).toBe("asksite.example");
  });
});
