import { AiDraft } from "@asksite/core";
import { z } from "zod";

type Schema = Record<string, unknown>;

/** The JSON schema of the AI output, as Zod writes it (length caps, defaults and oneOf included). */
export const AI_DRAFT_JSON_SCHEMA: Schema = z.toJSONSchema(AiDraft) as Schema;

// Keywords providers reject or ignore. Anthropic structured outputs refuse minLength, maxLength,
// pattern, maxItems and minItems above 1; Groq strict mode also refuses default, const, oneOf and
// every minItems/maxItems (both checked 2026-09-24 on the providers' docs). Our validators
// (SiteDocument) enforce all of these after the answer arrives, so the wire copy drops them.
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
