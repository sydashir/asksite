import { describe, expect, it } from "vitest";
import * as htmlModule from "../src/html.ts";
import { fragment, html, safeUrl, SafeHtml, trusted } from "../src/html.ts";

const PAYLOAD = `<img src=x onerror="alert(1)">'&`;
const JS = "javascript:alert(1)";

describe("html tagged template", () => {
  it("escapes text interpolations", () => {
    expect(String(html`<p>${PAYLOAD}</p>`)).toBe(`<p>&lt;img src=x onerror="alert(1)"&gt;'&amp;</p>`);
  });

  it("escapes attribute interpolations, including quotes", () => {
    expect(String(html`<p title="${PAYLOAD}">x</p>`)).toBe(
      `<p title="&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#39;&amp;">x</p>`,
    );
  });

  it("knows it is still inside a tag after an earlier interpolation", () => {
    const out = String(html`<a href="${safeUrl("https://example.com")}" title="${`"><script>`}">x</a>`);
    expect(out).toBe(`<a href="https://example.com" title="&quot;&gt;&lt;script&gt;">x</a>`);
  });

  it("renders numbers and skips false, null and undefined", () => {
    expect(String(html`<p>${3}${false}${null}${undefined}</p>`)).toBe("<p>3</p>");
  });

  it("joins arrays and passes nested templates through unescaped", () => {
    const items = ["a<", "b"].map((s) => html`<li>${s}</li>`);
    expect(String(html`<ul>${items}</ul>`)).toBe("<ul><li>a&lt;</li><li>b</li></ul>");
  });

  it("allows a trusted boolean attribute between attributes", () => {
    expect(String(html`<details name="faq"${trusted(" open")}>`)).toBe(`<details name="faq" open>`);
    expect(String(html`<details name="faq"${false}>`)).toBe(`<details name="faq">`);
  });

  it("refuses a plain string where an attribute name could be injected", () => {
    expect(() => html`<p ${"onclick=alert(1)"}>x</p>`).toThrow("double-quoted attribute value");
    expect(() => html`<p class=${"x"}>x</p>`).toThrow("double-quoted attribute value");
  });

  it("requires a SafeUrl in href, src and action", () => {
    expect(() => html`<a href="${"javascript:alert(1)"}">x</a>`).toThrow("needs a SafeUrl");
    expect(() => html`<img src="${"https://example.com/a.jpg"}" alt="">`).toThrow("needs a SafeUrl");
    expect(() => html`<form action="${undefined}"></form>`).toThrow("Missing URL");
  });

  it("finds the attribute name when there are spaces around =", () => {
    expect(() => html`<a href = "${"javascript:alert(1)"}">x</a>`).toThrow("needs a SafeUrl");
  });

  it("requires a SafeUrl in every other URL attribute", () => {
    expect(() => html`<button formaction="${"javascript:alert(1)"}">x</button>`).toThrow("needs a SafeUrl");
    expect(() => html`<video poster="${"javascript:alert(1)"}"></video>`).toThrow("needs a SafeUrl");
    expect(() => html`<object data="${"javascript:alert(1)"}"></object>`).toThrow("needs a SafeUrl");
  });

  it("never interpolates into event handlers, style, srcset or srcdoc", () => {
    expect(() => html`<p onclick="${"alert(1)"}">x</p>`).toThrow("never takes an interpolated value");
    expect(() => html`<p style="${"background:red"}">x</p>`).toThrow("never takes an interpolated value");
    expect(() => html`<img srcset="${safeUrl("https://example.com/a.jpg")}" alt="">`).toThrow("never takes an interpolated value");
    expect(() => html`<iframe srcdoc="${"<script>alert(1)</script>"}"></iframe>`).toThrow("never takes an interpolated value");
  });

  it("refuses markup inside an attribute", () => {
    expect(() => html`<p title="${html`<b>x</b>`}">x</p>`).toThrow("not allowed");
  });

  it("returns SafeHtml", () => {
    expect(html`<p></p>`).toBeInstanceOf(SafeHtml);
    expect(trusted(" open")).toBeInstanceOf(SafeHtml);
  });
});

describe("html composition and context tracking", () => {
  it("refuses an html fragment between attributes, because its values were escaped as text", () => {
    expect(() => html`<a${html` href="${JS}"`}>x</a>`).toThrow("double-quoted attribute value or trusted() markup");
    expect(() => html`<p${html` onclick="${"alert(1)"}"`}>x</p>`).toThrow("double-quoted attribute value or trusted() markup");
    expect(() => html`<details${html` open`}>`).toThrow("double-quoted attribute value or trusted() markup");
    expect(() => html`<details${new SafeHtml(" open")}>`).toThrow("double-quoted attribute value or trusted() markup");
  });

  it("still allows trusted() markup or nothing between attributes", () => {
    expect(String(html`<details name="faq"${trusted(" open")}>`)).toBe(`<details name="faq" open>`);
    expect(String(html`<details name="faq"${false}${null}${undefined}>`)).toBe(`<details name="faq">`);
  });

  it("refuses a template that ends inside a tag or an attribute value", () => {
    expect(() => html`<a`).toThrow("must not end inside a tag");
    expect(() => html`<a href="`).toThrow("must not end inside a tag");
    expect(() => html`<a title='x`).toThrow("must not end inside a tag");
    expect(() => html`<details${trusted(" open")}`).toThrow("must not end inside a tag");
  });

  it("refuses a partial-tag fragment spliced into text (the mirror case)", () => {
    expect(() => html`${html`<a`} href="${JS}">x</a>`).toThrow("must not end inside a tag");
    expect(() => html`${html`<p`} onclick="${"alert(1)"}">x</p>`).toThrow("must not end inside a tag");
  });

  it("refuses a value in an attribute whose name it cannot see", () => {
    expect(() => html`<a${trusted(" href")}="${JS}">x</a>`).toThrow("Cannot tell which attribute");
    expect(() => html`<p "${"x"}">x</p>`).toThrow("Cannot tell which attribute");
  });

  it("never interpolates inside a <style> or <script> element", () => {
    expect(() => html`<style>:root{--c:${"x"}}</style>`).toThrow("inside a <style> element");
    expect(() => html`<script>${"x"}</script>`).toThrow("inside a <script> element");
    expect(() => html`<SCRIPT type="application/ld+json">${new SafeHtml("{}")}</SCRIPT>`).toThrow("inside a <script> element");
    expect(() => html`<style media="print">${false}</style>`).toThrow("inside a <style> element");
    expect(() => html`${html`<style>`}${"x"}</style>`).toThrow("must not end inside a <style> element");
  });

  it("still places a whole <style> or <script> element built as SafeHtml, and escapes text after one", () => {
    const style = new SafeHtml("<style>a{color:red}</style>");
    const script = new SafeHtml(`<script type="application/ld+json">{}</script>`);
    expect(String(html`<head>${style}${script}<title>${"A & B"}</title></head>`)).toBe(
      `<head><style>a{color:red}</style><script type="application/ld+json">{}</script><title>A &amp; B</title></head>`,
    );
    expect(String(html`<style>a{}</style><p>${"<b>"}</p>`)).toBe("<style>a{}</style><p>&lt;b&gt;</p>");
  });

  it("tracks single-quoted attribute values, so a > inside one does not end the tag", () => {
    expect(String(html`<p title='a>b' class="${`" onmouseover="alert(1)`}">x</p>`)).toBe(
      `<p title='a>b' class="&quot; onmouseover=&quot;alert(1)">x</p>`,
    );
    expect(() => html`<a href='${safeUrl("https://example.com")}'>x</a>`).toThrow("double-quoted attribute value");
  });

  it("is not confused by quotes inside a comment", () => {
    expect(String(html`<!-- don't --><p title="it's > ${`" onmouseover="alert(1)`}">x</p>`)).toBe(
      `<!-- don't --><p title="it's > &quot; onmouseover=&quot;alert(1)">x</p>`,
    );
    expect(() => html`<!-- ${"x"} -->`).toThrow("inside a comment");
  });
});

describe("safeUrl", () => {
  it("accepts http, https, tel and mailto", () => {
    expect(String(safeUrl("http://example.com/"))).toBe("http://example.com/");
    expect(String(safeUrl("https://example.com/a?b=1"))).toBe("https://example.com/a?b=1");
    expect(String(safeUrl("tel:+15125550142"))).toBe("tel:+15125550142");
    expect(String(safeUrl("mailto:a@example.com"))).toBe("mailto:a@example.com");
  });
  it("throws on javascript: and friends", () => {
    expect(() => safeUrl("javascript:alert(1)")).toThrow("Unsafe URL rejected");
    expect(() => safeUrl(" JAVASCRIPT:alert(1)")).toThrow("Unsafe URL rejected");
    expect(() => safeUrl("http://example.com", ["https:"])).toThrow("Unsafe URL rejected");
  });
  it("is the only way (with fragment) to make a SafeUrl: the class is not exported", () => {
    expect(Object.keys(htmlModule)).not.toContain("SafeUrl");
  });
  it("escapes & in a URL attribute", () => {
    expect(String(html`<a href="${safeUrl("https://example.com/?a=1&b=2")}">x</a>`)).toBe(
      `<a href="https://example.com/?a=1&amp;b=2">x</a>`,
    );
  });
});

describe("fragment", () => {
  it("builds an in-page link to one of our ids", () => {
    expect(String(html`<a href="${fragment("service-area")}">x</a>`)).toBe(`<a href="#service-area">x</a>`);
  });
  it("rejects anything that is not a plain id", () => {
    expect(() => fragment(`x" onclick="y`)).toThrow("Invalid fragment id");
  });
});
