import { describe, expect, it } from "vitest";
import { canonicalJson, hashPages, pagesDigest, sha256Hex, VersionPages } from "../src/index.ts";

// A16: a version is 1 to 5 pages, Home first (a version made by the one-page renderer has only Home).
// site_versions.pages_json stores each page's id and SHA-256, and html_sha256 becomes one digest over
// that list: what the admin approves covers every page. Which pages a site has is the renderer's rule.
const sha = (c: string) => c.repeat(64);
const FIVE = [
  { page: "home", sha256: sha("a") },
  { page: "services", sha256: sha("b") },
  { page: "about", sha256: sha("c") },
  { page: "gallery", sha256: sha("d") },
  { page: "contact", sha256: sha("e") },
];
const THREE = [FIVE[0], FIVE[1], FIVE[4]];

describe("VersionPages (A16)", () => {
  it("accepts every page list a site can have", () => {
    expect(VersionPages.parse(FIVE)).toEqual(FIVE);
    expect(VersionPages.parse(THREE)).toEqual(THREE);
    expect(VersionPages.safeParse([FIVE[0], FIVE[1], FIVE[2], FIVE[4]]).success).toBe(true);
    expect(VersionPages.safeParse([FIVE[0], FIVE[1], FIVE[3], FIVE[4]]).success).toBe(true);
    expect(VersionPages.parse([FIVE[0]])).toEqual([FIVE[0]]);
  });

  it.each([
    ["no pages (a row from before A16)", []],
    ["pages out of order", [FIVE[1], FIVE[0], FIVE[4]]],
    ["a page twice", [FIVE[0], FIVE[1], FIVE[1], FIVE[4]]],
    ["no Home", [FIVE[1], FIVE[2], FIVE[4]]],
    ["Home after another page", [FIVE[1], FIVE[0]]],
    ["an unknown page", [FIVE[0], FIVE[1], { page: "blog", sha256: sha("f") }, FIVE[4]]],
    ["an inherited name as the page", [FIVE[0], FIVE[1], { page: "constructor", sha256: sha("f") }, FIVE[4]]],
    ["an upper-case hash", [{ page: "home", sha256: sha("A") }, FIVE[1], FIVE[4]]],
    ["a short hash", [{ page: "home", sha256: "a".repeat(63) }, FIVE[1], FIVE[4]]],
    ["a long hash", [{ page: "home", sha256: "a".repeat(65) }, FIVE[1], FIVE[4]]],
    ["a hash with a prefix", [{ page: "home", sha256: `x${"a".repeat(64)}` }, FIVE[1], FIVE[4]]],
    ["a hash with a suffix", [{ page: "home", sha256: `${"a".repeat(64)}x` }, FIVE[1], FIVE[4]]],
    ["a hash with a line break", [{ page: "home", sha256: `${"a".repeat(64)}\n` }, FIVE[1], FIVE[4]]],
    ["an extra field", [{ ...FIVE[0], html: "<p>" }, FIVE[1], FIVE[4]]],
    ["six pages", [...FIVE, { page: "contact", sha256: sha("f") }]],
    ["not a list", { home: sha("a") }],
  ])("refuses %s", (_name, value) => {
    expect(VersionPages.safeParse(value).success).toBe(false);
  });
});

describe("hashPages", () => {
  it("adds each page's SHA-256 of its UTF-8 bytes and keeps the other fields", async () => {
    const pages = [
      { page: "home" as const, path: "/", html: "<p>Home – é</p>" },
      { page: "contact" as const, path: "/contact", html: "<p>Contact</p>" },
    ];
    expect(await hashPages(pages)).toEqual([
      { ...pages[0], sha256: await sha256Hex("<p>Home – é</p>") },
      { ...pages[1], sha256: await sha256Hex("<p>Contact</p>") },
    ]);
  });
});

describe("pagesDigest", () => {
  it("is the SHA-256 of the canonical JSON of the page ids and hashes, in order", async () => {
    expect(await pagesDigest(VersionPages.parse(FIVE))).toBe(await sha256Hex(canonicalJson(FIVE)));
  });

  it("changes when any page's bytes change or a page is added or dropped", async () => {
    const base = await pagesDigest(VersionPages.parse(FIVE));
    const changed = FIVE.map((p) => (p.page === "gallery" ? { ...p, sha256: sha("f") } : p));
    expect(await pagesDigest(VersionPages.parse(changed))).not.toBe(base);
    expect(await pagesDigest(VersionPages.parse(THREE))).not.toBe(base);
  });

  it("reads only the page id and hash of each entry", async () => {
    const withHtml = FIVE.map((p) => ({ ...p, path: "/x", html: "<p>" })) as unknown as VersionPages;
    expect(await pagesDigest(withHtml)).toBe(await pagesDigest(VersionPages.parse(FIVE)));
  });
});
