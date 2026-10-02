import { describe, expect, it } from "vitest";
import { sha256OfBytes, verifiedHtml } from "../../src/client/lib/verified-page.ts";

const bytesOf = (...values: number[]): ArrayBuffer => new Uint8Array(values).buffer;
const encode = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer;

describe("verifiedHtml: the review shows only the bytes that were sent for review (honesty: 'The exact pages that will go live')", () => {
  it("gives the page's html when its raw bytes hash to the listed sha256, and that html encodes back to the same bytes", async () => {
    const bytes = encode("<!doctype html><title>Joe's Plumbing – Café</title>");
    const html = await verifiedHtml(bytes, await sha256OfBytes(bytes));
    expect(html).toBe("<!doctype html><title>Joe's Plumbing – Café</title>");
    expect(new TextEncoder().encode(html ?? "")).toEqual(new Uint8Array(bytes));
  });

  it("gives null when one byte changed", async () => {
    const bytes = encode("<p>call us</p>");
    const listed = await sha256OfBytes(bytes);
    const changed = new Uint8Array(bytes.slice(0));
    changed[3] = changed[3]! ^ 1;
    expect(await verifiedHtml(changed.buffer, listed)).toBeNull();
  });

  it("gives null for a body with a byte-order mark added, though the text is the same (the hash is over the raw bytes, not over text())", async () => {
    const plain = encode("<p>call us</p>");
    const listed = await sha256OfBytes(plain);
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new Uint8Array(plain)]).buffer;
    // text() would drop the mark and give the listed text: the check must not be fooled by that.
    expect(await new Response(withBom).text()).toBe("<p>call us</p>");
    expect(await verifiedHtml(withBom, listed)).toBeNull();
  });

  it("keeps a byte-order mark that IS in the hashed bytes, so the string shown still encodes to those bytes", async () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("<p>hi</p>")]).buffer;
    const html = await verifiedHtml(withBom, await sha256OfBytes(withBom));
    expect(html).toBe("﻿<p>hi</p>");
    expect(new TextEncoder().encode(html ?? "")).toEqual(new Uint8Array(withBom));
  });

  it("gives null for invalid UTF-8 even when its own hash is the listed one", async () => {
    const invalid = bytesOf(0x3c, 0x70, 0x3e, 0xff, 0xfe, 0x3c, 0x2f, 0x70, 0x3e);
    expect(await verifiedHtml(invalid, await sha256OfBytes(invalid))).toBeNull();
  });

  it("compares with THIS page's hash: another page's hash does not pass", async () => {
    const home = encode("<p>home</p>");
    const services = encode("<p>services</p>");
    expect(await verifiedHtml(home, await sha256OfBytes(services))).toBeNull();
    expect(await verifiedHtml(home, await sha256OfBytes(home))).toBe("<p>home</p>");
  });
});
