import { AiAnswer } from "@asksite/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
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
  it("is z.toJSONSchema(AiAnswer): copy, layout and theme with the length caps", () => {
    expect(AI_DRAFT_JSON_SCHEMA).toEqual(z.toJSONSchema(AiAnswer));
    expect(AI_DRAFT_JSON_SCHEMA.type).toBe("object");
    expect(Object.keys(AI_DRAFT_JSON_SCHEMA.properties as Json)).toEqual(["copy", "layout", "theme"]);
    expect(JSON.stringify(AI_DRAFT_JSON_SCHEMA)).toContain('"maxLength":80');
  });

  // A12 (user decision 2026-09-26): the page design follows the trade; the model never chooses it, so it is not on the wire.
  it("has no design: the theme's properties and required list are palette and font, in the Zod schema and on the wire", () => {
    for (const schema of [AI_DRAFT_JSON_SCHEMA, toWireSchema(AI_DRAFT_JSON_SCHEMA)]) {
      const theme = (schema.properties as Json).theme as Json;
      expect({ properties: Object.keys(theme.properties as Json), required: theme.required }).toEqual({ properties: ["palette", "font"], required: ["palette", "font"] });
    }
    expect(JSON.stringify(toWireSchema(AI_DRAFT_JSON_SCHEMA))).not.toContain("design");
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

// Anthropic structured outputs, "Schema complexity limits" > "Explicit limits", for every request with
// output_config.format (platform.claude.com/docs/en/build-with-claude/structured-outputs, checked 2026-09-27):
//   "Optional parameters | 24 | Total optional parameters across all strict tool schemas and JSON output schemas.
//    Each parameter not listed in `required` counts toward this limit."
//   "Parameters with union types | 16 | Total parameters that use `anyOf` or type arrays (for example,
//    `"type": ["string", "null"]`) across all strict schemas."
// The adapters send one schema per request, toWireSchema(AI_DRAFT_JSON_SCHEMA), and no tools.
describe("toWireSchema within Anthropic's structured-output limits", () => {
  const MAX_OPTIONAL = 24;
  const MAX_UNION = 16;
  const propertiesOf = (node: Json): Json => (node.properties ?? {}) as Json;
  /** Every schema position at any depth: the node, then its properties, its items and its anyOf branches. */
  const positions = (node: Json): Json[] => [
    node,
    ...[...Object.values(propertiesOf(node)), ...(node.items === undefined ? [] : [node.items]), ...((node.anyOf ?? []) as unknown[])].flatMap((child) => positions(child as Json)),
  ];
  /** The docs' count: each property not listed in its object's `required`. */
  const notRequired = (schema: Json): number =>
    positions(schema).reduce((n, node) => n + Object.keys(propertiesOf(node)).filter((key) => !((node.required ?? []) as string[]).includes(key)).length, 0);
  const allowsNull = (node: Json): boolean => (Array.isArray(node.type) && node.type.includes("null")) || ((node.anyOf ?? []) as Json[]).some((branch) => branch.type === "null");
  /** A stricter count: each property that may be null, toWireSchema's stand-in for an optional property (all are listed in `required`). */
  const nullable = (schema: Json): number => positions(schema).reduce((n, node) => n + Object.values(propertiesOf(node)).filter((child) => allowsNull(child as Json)).length, 0);
  /** Each position that uses anyOf or a type array: every position counts, not only object properties (so layout's items count too). */
  const unions = (schema: Json): number => positions(schema).filter((node) => Array.isArray(node.anyOf) || Array.isArray(node.type)).length;

  it("counts as the docs define: a property left out of required, and anyOf or a type array, at any depth", () => {
    const sample: Json = {
      type: "object",
      properties: {
        a: { type: ["string", "null"] },
        b: { anyOf: [{ type: "string" }, { type: "null" }] },
        c: { type: "array", items: { type: "object", properties: { d: { anyOf: [{ type: "string" }, { type: "number" }] }, e: { type: "string" } }, required: ["d"] } },
      },
      required: ["a", "b"],
    };
    expect({ notRequired: notRequired(sample), nullable: nullable(sample), unions: unions(sample) }).toEqual({ notRequired: 2, nullable: 2, unions: 3 });
  });

  it("stays within 24 optional parameters and 16 union-typed parameters, counted the docs' way and the stricter way", () => {
    const wire = toWireSchema(AI_DRAFT_JSON_SCHEMA);
    expect(notRequired(wire)).toBeLessThanOrEqual(MAX_OPTIONAL);
    expect(nullable(wire)).toBeLessThanOrEqual(MAX_OPTIONAL);
    expect(unions(wire)).toBeLessThanOrEqual(MAX_UNION);
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
