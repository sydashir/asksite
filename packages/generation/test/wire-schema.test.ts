import { describe, expect, it } from "vitest";
import { AI_DRAFT_JSON_SCHEMA, dropNulls, toWireSchema } from "../src/wire-schema.ts";

type Json = Record<string, unknown>;
const keywords = (schema: unknown, found = new Set<string>()): Set<string> => {
  if (Array.isArray(schema)) schema.forEach((s) => keywords(s, found));
  else if (schema !== null && typeof schema === "object")
    for (const [key, value] of Object.entries(schema)) {
      if (key !== "properties") found.add(key);
      keywords(key === "properties" ? Object.values(value as Json) : value, found);
    }
  return found;
};

describe("AI_DRAFT_JSON_SCHEMA", () => {
  it("is z.toJSONSchema(AiDraft): copy, layout and theme with the length caps", () => {
    expect(AI_DRAFT_JSON_SCHEMA.type).toBe("object");
    expect(Object.keys(AI_DRAFT_JSON_SCHEMA.properties as Json)).toEqual(["copy", "layout", "theme"]);
    expect(JSON.stringify(AI_DRAFT_JSON_SCHEMA)).toContain('"maxLength":80');
  });
});

describe("toWireSchema", () => {
  const wire = toWireSchema(AI_DRAFT_JSON_SCHEMA);

  it("keeps only keywords that Anthropic structured outputs and Groq strict mode both accept", () => {
    expect([...keywords(wire)].sort()).toEqual(["additionalProperties", "anyOf", "enum", "items", "required", "type"]);
  });

  it("makes every property required and every optional one nullable", () => {
    const copy = (wire.properties as Json).copy as Json;
    expect(copy.required).toEqual(Object.keys(copy.properties as Json));
    expect((copy.properties as Json).about).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
    expect((copy.properties as Json).heroHeadline).toEqual({ type: "string" });
  });

  it("turns const into a one-value enum and oneOf into anyOf", () => {
    const layout = (wire.properties as Json).layout as Json;
    const hero = ((layout.items as Json).anyOf as Json[])[0] as Json;
    expect((hero.properties as Json).id).toEqual({ type: "string", enum: ["hero"] });
  });

  it("does not change its input", () => {
    const before = JSON.stringify(AI_DRAFT_JSON_SCHEMA);
    toWireSchema(AI_DRAFT_JSON_SCHEMA);
    expect(JSON.stringify(AI_DRAFT_JSON_SCHEMA)).toBe(before);
  });

  it("fails closed on a keyword it does not know", () => {
    expect(() => toWireSchema({ type: "string", pattern: "^a" })).not.toThrow();
    expect(() => toWireSchema({ type: "string", contentEncoding: "base64" })).toThrow(/contentEncoding/);
  });
});

describe("dropNulls", () => {
  it("removes null object values at any depth and keeps everything else", () => {
    expect(dropNulls({ a: null, b: { c: null, d: 1 }, e: [{ f: null, g: "x" }], h: [null] })).toEqual({
      b: { d: 1 },
      e: [{ g: "x" }],
      h: [null],
    });
  });
});
