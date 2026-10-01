import { AiAnswer } from "@asksite/core";
import { z } from "zod";

type Schema = Record<string, unknown>;

/**
 * The JSON schema of the AI output, as Zod writes it (length caps, defaults and oneOf included): the model's answer,
 * with no page design (A12: the server adds the trade's design, draftFromAnswer).
 */
export const AI_DRAFT_JSON_SCHEMA: Schema = z.toJSONSchema(AiAnswer) as Schema;

// Keywords providers reject or ignore. Anthropic structured outputs refuse minLength, maxLength,
// maxItems and minItems above 1, and support only simple regex patterns (checked 2026-09-25 on
// platform.claude.com/docs/en/build-with-claude/structured-outputs, "JSON Schema limitations").
// Groq strict mode is documented to refuse default, const, oneOf and the length/item keywords, but
// its current docs no longer list them, so that is unconfirmed. We drop pattern too, so one schema
// works for every provider; our validators (SiteDocument) enforce every dropped rule after the
// answer arrives.
const DROPPED = new Set(["$schema", "minLength", "maxLength", "pattern", "minItems", "maxItems", "default"]);
const KNOWN = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const", "oneOf", "anyOf"]);

/**
 * The one schema every adapter sends: `oneOf` becomes `anyOf`, `const` becomes a one-value `enum`,
 * every object property is required (an optional one becomes nullable), unsupported keywords are
 * dropped. A keyword this function does not know throws, so a new Zod output is reviewed, never
 * sent blind. Pair it with `dropNulls` on the answer.
 */
export function toWireSchema(schema: Schema): Schema {
  const out: Schema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (DROPPED.has(key)) continue;
    if (!KNOWN.has(key)) throw new Error(`toWireSchema: unsupported JSON schema keyword "${key}"`);
    if (key === "const") out.enum = [value];
    else if (key === "oneOf" || key === "anyOf") out.anyOf = (value as Schema[]).map(toWireSchema);
    else if (key === "items") out.items = toWireSchema(value as Schema);
    else if (key === "properties") {
      const required = new Set((schema.required as string[] | undefined) ?? []);
      const properties: Schema = {};
      for (const [name, child] of Object.entries(value as Record<string, Schema>)) {
        const wire = toWireSchema(child);
        properties[name] = required.has(name) ? wire : { anyOf: [wire, { type: "null" }] };
      }
      out.properties = properties;
      out.required = Object.keys(properties);
      out.additionalProperties = false;
    } else if (key !== "required" && key !== "additionalProperties") out[key] = value;
  }
  return out;
}

/** Removes null object values (the wire schema's stand-in for "left out") at any depth. */
export function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== null)
      .map(([key, child]) => [key, dropNulls(child)]),
  );
}
