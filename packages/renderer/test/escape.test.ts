import { describe, expect, it } from "vitest";
import { escapeAttr, escapeText } from "../src/escape.ts";

describe("escapeText", () => {
  it("neutralises markup", () => {
    expect(escapeText(`<script>alert("x")</script> & 'y'`)).toBe(`&lt;script&gt;alert("x")&lt;/script&gt; &amp; 'y'`);
  });
  it("escapes an existing entity so it renders literally", () => {
    expect(escapeText("&amp;")).toBe("&amp;amp;");
  });
});

describe("escapeAttr", () => {
  it("also escapes both quote characters", () => {
    expect(escapeAttr(`" onmouseover="alert(1)`)).toBe("&quot; onmouseover=&quot;alert(1)");
    expect(escapeAttr(`' onfocus='x`)).toBe("&#39; onfocus=&#39;x");
    expect(escapeAttr("<b>&")).toBe("&lt;b&gt;&amp;");
  });
});
