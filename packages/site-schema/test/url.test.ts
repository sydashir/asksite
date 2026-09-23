import { describe, expect, it } from "vitest";
import { isSafeUrl, LINK_SCHEMES } from "../src/url.ts";

describe("isSafeUrl", () => {
  it.each([
    "https://example.com/a?b=c",
    "http://example.com",
    "tel:+15125550142",
    "mailto:office@example.com",
  ])("accepts %s", (url) => {
    expect(isSafeUrl(url)).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    " javascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "//evil.example.com",
    "/relative/path",
    "#fragment",
    "",
    "https://example.com ",
  ])("rejects %j", (url) => {
    expect(isSafeUrl(url)).toBe(false);
  });

  it("can be narrowed to https only", () => {
    expect(isSafeUrl("https://example.com", ["https:"])).toBe(true);
    expect(isSafeUrl("http://example.com", ["https:"])).toBe(false);
  });

  it("lists exactly the four link schemes", () => {
    expect(LINK_SCHEMES).toEqual(["http:", "https:", "tel:", "mailto:"]);
  });
});
