import { describe, expect, it } from "vitest";
import { cleanOwnerText } from "../src/owner-text.ts";
import * as appCommon from "../src/index.ts";

describe("cleanOwnerText (mirrors readLead's clean() for multi-line text, apps/sites/src/lead.ts)", () => {
  it("removes bidi controls and zero-width characters", () => {
    expect(cleanOwnerText("a\u202Eb\u200Bc\u0007d")).toBe("abcd");
  });

  it("keeps newlines and U+200D (emoji joiner)", () => {
    expect(cleanOwnerText("one\ntwo \u{1F468}\u200D\u{1F469}")).toBe("one\ntwo \u{1F468}\u200D\u{1F469}");
  });

  it("turns every line break form into a newline, a lone CR included, and a tab into a space", () => {
    expect(cleanOwnerText("a\r\nb\rc\vd\fe\u0085f\u2028g\u2029h\ti")).toBe("a\nb\nc\nd\ne\nf\ng\nh i");
  });

  it("trims, and gives an empty string when nothing is left", () => {
    expect(cleanOwnerText("  \u200B\u202E \n\t ")).toBe("");
    expect(cleanOwnerText("  hello  ")).toBe("hello");
  });

  it("never lengthens a text", () => {
    const text = "x\r\n\u200By\t".repeat(100);
    expect(cleanOwnerText(text).length).toBeLessThanOrEqual(text.length);
  });

  it("is exported from the package", () => {
    expect(appCommon.cleanOwnerText).toBe(cleanOwnerText);
  });
});
