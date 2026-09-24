import { describe, expect, it } from "vitest";
import {
  formActionUrl,
  liveKey,
  mediaKey,
  mediaUrl,
  parseHost,
  previewFormActionUrl,
  RESERVED_SLUGS,
  siteUrl,
  slugIssue,
  versionKey,
} from "../src/index.ts";

const SITE = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const VERSION = "0b0c2d3e-4f50-4a6b-8c7d-8e9fa0b1c2d3";

describe("keys", () => {
  it("builds every R2 key and URL from ids and slugs only", () => {
    expect(liveKey("joes")).toBe("joes.html");
    expect(versionKey(SITE, VERSION)).toBe(`versions/${SITE}/${VERSION}.html`);
    expect(mediaKey(SITE, VERSION)).toBe(`${SITE}/${VERSION}.webp`);
    expect(siteUrl("asksite.example", "joes")).toBe("https://joes.asksite.example/");
    expect(formActionUrl("localhost:8789", "joes", SITE)).toBe(`https://joes.localhost:8789/_f/${SITE}`);
    expect(previewFormActionUrl("asksite.example", null, SITE)).toBe(`https://preview.asksite.example/_f/${SITE}`);
    expect(previewFormActionUrl("asksite.example", "joes", SITE)).toBe(`https://joes.asksite.example/_f/${SITE}`);
    expect(mediaUrl("asksite.example", SITE, VERSION)).toBe(`https://media.asksite.example/${SITE}/${VERSION}.webp`);
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
