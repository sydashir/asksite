import { describe, expect, it } from "vitest";
import { Photo, SocialLink } from "../src/facts.ts";
import { isSafeUrl, LINK_SCHEMES } from "../src/url.ts";

describe("isSafeUrl", () => {
  it.each([
    "https://example.com/a?b=c",
    "http://example.com",
    "HTTPS://example.com/a",
    "tel:+15125550142",
    "mailto:office@example.com",
  ])("accepts %s", (url) => {
    expect(isSafeUrl(url)).toBe(true);
  });

  // A page of the same scheme resolves these against its own address ("https:facebook.com/x" on
  // https://joes.example/ is https://joes.example/facebook.com/x), so they are not absolute links (A9).
  // The one exception, "https:" + two backslashes, does reach facebook.com, but it is refused too:
  // A9 asks for a literal "//" after http: or https:.
  it.each([
    "https:facebook.com/mop",
    "https:/facebook.com/mop",
    "HTTPS:facebook.com/mop",
    "https:\\facebook.com/mop",
    "https:\\\\facebook.com/mop",
    "http:example.com",
    "http:/example.com",
  ])("rejects %j: http and https must be followed by //", (url) => {
    expect(isSafeUrl(url)).toBe(false);
  });

  it("never accepts an http or https URL that would resolve against the page", () => {
    const tails = ["", "/", "//", "///", "\\", "\\\\", "/\\"];
    const hosts = ["facebook.com/mop", "ｆacebook.com", "example.com:443/a", "[::1]/a"];
    for (const scheme of ["https:", "http:", "HTTPS:"])
      for (const tail of tails)
        for (const host of hosts) {
          const url = `${scheme}${tail}${host}`;
          if (!isSafeUrl(url)) continue;
          const base = `${new URL(url).protocol}//joes.example/page/`;
          expect(new URL(url, base).href, url).toBe(new URL(url).href);
        }
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

// The owner app runs these checks in the browser, and iOS 16 Safari has no URL.canParse (A9).
describe("every URL check without URL.canParse", () => {
  const URLS = [
    "https://example.com/a?b=c",
    "http://example.com",
    "tel:+15125550142",
    "mailto:office@example.com",
    "https://user:pw@example.com/a.jpg",
    "https://www.facebook.com/mop",
    "https://evil.example/facebook.com",
    "https:facebook.com/mop",
    "javascript:alert(1)",
    "/relative/path",
    "https://exa mple.com",
    "https://[::1",
    "",
  ];
  const photo = (url: string) => ({ url, alt: "Van", width: 800, height: 600 });
  const answers = () =>
    URLS.map((url) => [
      isSafeUrl(url),
      isSafeUrl(url, ["https:"]),
      Photo.safeParse(photo(url)).success,
      SocialLink.safeParse({ network: "facebook", url }).success,
    ]);

  it("gives the same answers as with it", () => {
    const withCanParse = answers();
    const canParse = Object.getOwnPropertyDescriptor(URL, "canParse");
    expect(canParse).toBeDefined();
    Reflect.deleteProperty(URL, "canParse");
    try {
      expect("canParse" in URL).toBe(false);
      expect(answers()).toEqual(withCanParse);
    } finally {
      if (canParse) Object.defineProperty(URL, "canParse", canParse);
    }
    expect(typeof URL.canParse).toBe("function");
  });
});
