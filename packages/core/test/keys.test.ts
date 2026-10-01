import { describe, expect, it } from "vitest";
import {
  formActionUrl,
  livePageKey,
  livePointerKey,
  liveSitePrefix,
  mediaKey,
  mediaUrl,
  pageCacheUrl,
  parseHost,
  previewFormActionUrl,
  previewSiteUrl,
  publicPageUrl,
  RESERVED_SLUGS,
  siteUrl,
  slugIssue,
  versionKey,
  versionPageKey,
} from "../src/index.ts";
import { PAGE_IDS, type PageId } from "@asksite/site-schema";

const SITE = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const VERSION = "0b0c2d3e-4f50-4a6b-8c7d-8e9fa0b1c2d3";

describe("keys", () => {
  it("builds every R2 key and URL from ids and slugs only", () => {
    expect(versionKey(SITE, VERSION)).toBe(`versions/${SITE}/${VERSION}.html`);
    expect(mediaKey(SITE, VERSION)).toBe(`${SITE}/${VERSION}.webp`);
    expect(siteUrl("asksite.example", "joes")).toBe("https://joes.asksite.example/");
    expect(formActionUrl("localhost:8789", "joes", SITE)).toBe(`https://joes.localhost:8789/_f/${SITE}`);
    expect(previewFormActionUrl("asksite.example", null, SITE)).toBe(`https://preview.asksite.example/_f/${SITE}`);
    expect(previewFormActionUrl("asksite.example", "joes", SITE)).toBe(`https://joes.asksite.example/_f/${SITE}`);
    expect(mediaUrl("asksite.example", SITE, VERSION)).toBe(`https://media.asksite.example/${SITE}/${VERSION}.webp`);
  });
});

// A16 + U2 (user, 2026-10-01: all pages switch together, never mixed): LIVE holds one small pointer per site,
// naming its live version, and the approved pages at immutable keys under the slug and the version id. One
// pointer write switches every page at once. WORK keeps Home at today's key. Security: the builders accept
// only the 5 page ids (and, for LIVE pages, a real version id), so no request path or stored text becomes a key.
describe("page keys (A16)", () => {
  it("builds the site's LIVE pointer and each page's immutable LIVE key under the slug", () => {
    expect(livePointerKey("joes")).toBe("joes");
    expect(liveSitePrefix("joes")).toBe("joes/");
    expect(PAGE_IDS.map((page) => livePageKey("joes", VERSION, page))).toEqual([
      `joes/${VERSION}/home.html`,
      `joes/${VERSION}/services.html`,
      `joes/${VERSION}/about.html`,
      `joes/${VERSION}/gallery.html`,
      `joes/${VERSION}/contact.html`,
    ]);
    for (const page of PAGE_IDS) expect(livePageKey("joes", VERSION, page).startsWith(liveSitePrefix("joes"))).toBe(true);
    expect(livePointerKey("joes").startsWith(liveSitePrefix("joes"))).toBe(false);
    // Another site's prefix never covers this site's keys ("joe/" is not a prefix of "joes/...").
    expect(livePageKey("joes", VERSION, "home").startsWith(liveSitePrefix("joe"))).toBe(false);
  });

  it("builds each page's WORK key, Home at today's key", () => {
    expect(PAGE_IDS.map((page) => versionPageKey(SITE, VERSION, page))).toEqual([
      `versions/${SITE}/${VERSION}.html`,
      `versions/${SITE}/${VERSION}/services.html`,
      `versions/${SITE}/${VERSION}/about.html`,
      `versions/${SITE}/${VERSION}/gallery.html`,
      `versions/${SITE}/${VERSION}/contact.html`,
    ]);
    expect(versionPageKey(SITE, VERSION, "home")).toBe(versionKey(SITE, VERSION));
  });

  it("builds each page's public URL (the canonical) and the preview's site URL", () => {
    expect(PAGE_IDS.map((page) => publicPageUrl("asksite.example", "joes", page))).toEqual([
      "https://joes.asksite.example/",
      "https://joes.asksite.example/services",
      "https://joes.asksite.example/about",
      "https://joes.asksite.example/gallery",
      "https://joes.asksite.example/contact",
    ]);
    expect(publicPageUrl("asksite.example", "joes", "home")).toBe(siteUrl("asksite.example", "joes"));
    expect(previewSiteUrl("asksite.example", null)).toBe("https://preview.asksite.example/");
    expect(previewSiteUrl("asksite.example", "joes")).toBe("https://joes.asksite.example/");
  });

  // The sites Worker's edge-cache key: the version id is in the PATH (a zone's cache-key settings can strip a query).
  it("builds each page's edge-cache URL with the version id in the path", () => {
    expect(PAGE_IDS.map((page) => pageCacheUrl("asksite.example", "joes", VERSION, page))).toEqual([
      `https://joes.asksite.example/__v/${VERSION}/`,
      `https://joes.asksite.example/__v/${VERSION}/services`,
      `https://joes.asksite.example/__v/${VERSION}/about`,
      `https://joes.asksite.example/__v/${VERSION}/gallery`,
      `https://joes.asksite.example/__v/${VERSION}/contact`,
    ]);
    expect(pageCacheUrl("localhost:8789", "joes", VERSION, "contact")).toBe(`https://joes.localhost:8789/__v/${VERSION}/contact`);
  });

  it.each(["", "Home", "SERVICES", "../joes", "services/../../x", "/services", "services.html", "index", "__proto__", "constructor", "toString", "hasOwnProperty"])(
    "refuses %j as a page id in every builder",
    (value) => {
      const page = value as PageId;
      expect(() => livePageKey("joes", VERSION, page)).toThrow(/page/);
      expect(() => versionPageKey(SITE, VERSION, page)).toThrow(/page/);
      expect(() => publicPageUrl("asksite.example", "joes", page)).toThrow(/page/);
      expect(() => pageCacheUrl("asksite.example", "joes", VERSION, page)).toThrow(/page/);
    },
  );

  // The sites Worker reads the version id from the pointer's metadata: a damaged pointer must not choose the key.
  it.each(["", "../x", "x/../../y", `${VERSION}/../other`, VERSION.toUpperCase(), "not-an-id"])("refuses %j as a LIVE version id", (versionId) => {
    expect(() => livePageKey("joes", versionId, "home")).toThrow(/version/);
    expect(() => pageCacheUrl("asksite.example", "joes", versionId, "home")).toThrow(/version/);
  });
});

describe("parseHost", () => {
  const root = "asksite.example";

  it.each([
    ["asksite.example", { kind: "apex" }],
    ["www.asksite.example", { kind: "www" }],
    ["media.asksite.example", { kind: "media" }],
    ["joes.asksite.example", { kind: "site", slug: "joes" }],
    ["JOES.AskSite.Example", { kind: "site", slug: "joes" }],
    ["joes-plumbing-2.asksite.example", { kind: "site", slug: "joes-plumbing-2" }],
    ["app.asksite.example", { kind: "unknown" }],
    ["admin.asksite.example", { kind: "unknown" }],
    ["a.b.asksite.example", { kind: "unknown" }],
    ["www.joes.asksite.example", { kind: "unknown" }],
    ["jo.asksite.example", { kind: "unknown" }],
    ["jo--es.asksite.example", { kind: "unknown" }],
    ["joes.asksite.example.evil.test", { kind: "unknown" }],
    ["evilasksite.example", { kind: "unknown" }],
    ["joes.asksite.example:8443", { kind: "unknown" }],
    ["", { kind: "unknown" }],
  ])("%j", (host, kind) => {
    expect(parseHost(host, root)).toEqual(kind);
  });

  it("includes the port for local development", () => {
    expect(parseHost("joes.localhost:8789", "localhost:8789")).toEqual({ kind: "site", slug: "joes" });
    expect(parseHost("localhost:8789", "localhost:8789")).toEqual({ kind: "apex" });
    expect(parseHost("joes.localhost:8790", "localhost:8789")).toEqual({ kind: "unknown" });
    expect(parseHost("joes.localhost", "localhost:8789")).toEqual({ kind: "unknown" });
  });
});

describe("slugIssue", () => {
  it.each(["joes", "abc", "joes-plumbing", "a1b", "x".repeat(40)])("accepts %j", (slug) => {
    expect(slugIssue(slug)).toBeNull();
  });

  it.each(["ab", "x".repeat(41), "-joes", "joes-", "jo--es", "Joes", "joe's", "joe_s", "jöes", " joes", "joes.example"])(
    "rejects %j as invalid",
    (slug) => {
      expect(slugIssue(slug)).toBe("invalid");
    },
  );

  it("reserves every hostname, mail label and look-alike the design lists", () => {
    const listed = (
      "www app admin media api mail email smtp imap pop ftp static assets cdn img images files status help support docs " +
      "blog abuse security billing account accounts login signin signup auth dashboard staging stage dev test preview " +
      "ns1 ns2 mx autodiscover autoconfig webmail send inbound bounce"
    ).split(" ");
    for (const slug of listed) expect(RESERVED_SLUGS.has(slug), slug).toBe(true);
    expect(slugIssue("admin")).toBe("reserved");
    expect(slugIssue("preview")).toBe("reserved");
  });
});
