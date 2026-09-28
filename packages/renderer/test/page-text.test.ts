import { describe, expect, it } from "vitest";
import { countInText, squash, squashedText } from "./support/page-text.ts";

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
