import { Copy, Layout, OwnerHidden, SECTION_VARIANTS, Theme, type SectionId } from "@asksite/site-schema";
import { z } from "zod";

/** What the model returns: Plan 1 copy, layout and theme. Owner facts never come from the model. */
export const AiDraft = z.strictObject({ copy: Copy, layout: Layout, theme: Theme });
export type AiDraft = z.infer<typeof AiDraft>;

const EditText = z.string().max(2000);

/** A plain object (prototype Object.prototype or null), as JSON.parse makes. Like z.record, this refuses
 *  null, arrays and class instances such as Map or Date. */
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Service name -> owner text. Not a plain z.record: zod 4.6.5's record drops an own "__proto__" key
 * without an issue (its prototype-pollution guard), which would silently lose the owner's text for a
 * service with that name (§2.8: such a name behaves like any other). The entries are checked as a Map
 * and rebuilt with Object.fromEntries, which defines own data properties, so "__proto__" stays plain
 * data and never sets a prototype. The limits and issue paths are z.record's; only a name over 40
 * characters is reported as too_big instead of invalid_key.
 */
const ServiceDescriptionEdits = z
  .preprocess((value, ctx) => {
    if (isPlainObject(value)) return new Map(Object.entries(value));
    ctx.issues.push({ code: "invalid_type", expected: "record", input: value });
    return value;
  }, z.map(z.string().max(40), EditText))
  .transform((edits) => Object.fromEntries(edits));

/** Owner wording edits. After composition every Plan 1 Copy rule applies to them (design §2.2). */
export const CopyEdits = z.strictObject({
  heroHeadline: EditText.optional(),
  heroSubheadline: EditText.optional(),
  ctaText: EditText.optional(),
  about: EditText.nullable().optional(), // null = remove the about text
  sectionIntros: z
    .strictObject({
      services: EditText.nullable().optional(),
      gallery: EditText.nullable().optional(),
      faq: EditText.nullable().optional(),
      contact: EditText.nullable().optional(),
    })
    .optional(),
  serviceDescriptions: ServiceDescriptionEdits.optional(), // key = the trimmed facts.services[].name (Decision 14)
  faq: z.array(z.strictObject({ question: EditText, answer: EditText })).max(8).optional(), // replaces the AI list
});
export type CopyEdits = z.infer<typeof CopyEdits>;

export const SECTION_IDS = Object.keys(SECTION_VARIANTS) as [SectionId, ...SectionId[]];

/** A full order: every section id exactly once, hero first. The editor always saves all of them
 *  (it lists only the visible ones and keeps the rest in place). */
export const SectionOrder = z
  .array(z.enum(SECTION_IDS))
  .length(SECTION_IDS.length)
  .refine((ids) => new Set(ids).size === ids.length && ids[0] === "hero", { error: "Order must list every section once, hero first" });

export const OwnerEdits = z.strictObject({
  baseGenerationId: z.string().nullable(), // copy and order edits apply only to this generation
  copy: CopyEdits,
  order: SectionOrder.nullable(),
  hidden: OwnerHidden, // A6 schema from @asksite/site-schema (unique, hideable ids only)
  theme: Theme.nullable(),
});
export type OwnerEdits = z.infer<typeof OwnerEdits>;

/** A site's edits before the owner changes anything. Frozen, arrays included: every caller shares it. */
export const EMPTY_EDITS: OwnerEdits = { baseGenerationId: null, copy: {}, order: null, hidden: [], theme: null };
Object.freeze(EMPTY_EDITS.copy);
Object.freeze(EMPTY_EDITS.hidden);
Object.freeze(EMPTY_EDITS);
