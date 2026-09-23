import { describe, expect, it } from "vitest";
import { fragment, html, safeUrl, SafeHtml, trusted } from "../src/html.ts";

const PAYLOAD = `<img src=x onerror="alert(1)">'&`;

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
  });
});

describe("safeUrl", () => {
  it("accepts http, https, tel and mailto", () => {
    expect(String(safeUrl("tel:+15125550142"))).toBe("tel:+15125550142");
    expect(String(safeUrl("mailto:a@example.com"))).toBe("mailto:a@example.com");
  });
  it("throws on javascript: and friends", () => {
    expect(() => safeUrl("javascript:alert(1)")).toThrow("Unsafe URL rejected");
    expect(() => safeUrl(" JAVASCRIPT:alert(1)")).toThrow("Unsafe URL rejected");
    expect(() => safeUrl("http://example.com", ["https:"])).toThrow("Unsafe URL rejected");
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
