import { describe, expect, it } from "vitest";
import { flatten, textChanges } from "../../src/client/lib/diff.ts";

describe("textChanges", () => {
  it("lists changed, added and removed values by path", () => {
    const live = { copy: { heroHeadline: "Old", faq: [{ q: "A?" }] }, facts: { insured: false } };
    const next = { copy: { heroHeadline: "New", faq: [] }, facts: { insured: true, yearFounded: 2016 } };
    expect(textChanges(live, next)).toEqual([
      { path: "copy.faq.0.q", before: "A?", after: null },
      { path: "copy.heroHeadline", before: "Old", after: "New" },
      { path: "facts.insured", before: "false", after: "true" },
      { path: "facts.yearFounded", before: null, after: "2016" },
    ]);
  });

  it("is empty for identical documents and flattens nested lists", () => {
    expect(textChanges({ a: [1, { b: "x" }] }, { a: [1, { b: "x" }] })).toEqual([]);
    expect([...flatten({ a: [1, { b: "x" }] })]).toEqual([["a.0", "1"], ["a.1.b", "x"]]);
  });
});
