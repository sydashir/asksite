import { describe, expect, it } from "vitest";
import { countInText, readableTexts, squash, squashedText } from "./support/page-text.ts";

// The content checks read page text the same way in every design (A12 §8), so what squashedText() keeps
// and drops is pinned here.
describe("squashedText", () => {
  it("reads a phrase however a design splits it across elements", () => {
    for (const markup of ['<p>From <span class="tnum">$89</span></p>', "<p><small>From</small>$89</p>", '<p class="price">From $89</p>']) {
      expect(squashedText(markup)).toBe(squash("From $89"));
    }
    expect(squashedText('<li>Texas master plumber<span class="sr-only">:</span> <span>M-40123</span></li>')).toBe(squash("Texas master plumber: M-40123"));
  });

  it("drops comments, <style> and <script> bodies and attribute values, and keeps entities escaped", () => {
    const markup =
      '<style>p::before{content:"From $1"}</style><script type="application/ld+json">{"x":"From $2"}</script><!-- From $3 -->' +
      '<img alt="From $4"><p title="a > b">&lt;b&gt; From $5</p>';
    expect(squashedText(markup)).toBe("&lt;b&gt;From$5");
    expect(countInText(markup, "From $")).toBe(1);
  });
});

// The claims check (A12-0 round-4 rulings) reads words, so readableTexts() keeps the break between two
// elements and decodes character references as the browser does.
describe("readableTexts", () => {
  it("keeps each text node apart, so words in separate elements stay separate words", () => {
    expect(readableTexts("<ul><li>Licensed</li><li>Insured</li></ul>")).toEqual(["Licensed", "Insured"]);
    expect(readableTexts("<p>Licensed <strong>and</strong> insured</p>")).toEqual(["Licensed ", "and", " insured"]);
  });

  it("decodes character references as the browser does, in text and in attribute values", () => {
    // &#150; is a Windows-1252 code the HTML standard reads as an en dash; an out-of-range number reads as U+FFFD.
    expect(readableTexts("<p>Licensed &amp; insured &#x26; b&#111;nded&nbsp;&lt;ok&gt; &ldquo;Top&#150;rated&rdquo; &mdash; &bogus; &#1114112;</p>")).toEqual([
      "Licensed & insured & bonded\u00a0<ok> \u201cTop\u2013rated\u201d \u2014 &bogus; \ufffd",
    ]);
    expect(readableTexts('<img alt="Ins&#117;red &amp; b&#x6F;nded" src="x">')).toEqual(["Insured & bonded"]);
  });

  it("reads the text a person sees or hears: alt, title and aria-label values, not other attributes", () => {
    expect(readableTexts('<svg aria-label="Bonded"></svg><img alt="Certified" src="x" title="Top rated"><a href="#licensed" class="insured">Go</a>')).toEqual([
      "Bonded",
      "Certified",
      "Top rated",
      "Go",
    ]);
  });

  it("drops the doctype, comments and <style> and <script> bodies", () => {
    expect(readableTexts('<!DOCTYPE html><!-- bonded --><style>p::before{content:"bonded"}</style><script type="application/ld+json">{"x":"bonded"}</script><p>Hi</p>')).toEqual([
      "Hi",
    ]);
  });
});
