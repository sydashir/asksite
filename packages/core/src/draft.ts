import { Copy, Layout, OwnerHidden, SECTION_VARIANTS, Theme, type SectionId } from "@asksite/site-schema";
import { z } from "zod";

/** What the model returns: Plan 1 copy, layout and theme. Owner facts never come from the model. */
export const AiDraft = z.strictObject({ copy: Copy, layout: Layout, theme: Theme });
export type AiDraft = z.infer<typeof AiDraft>;

const EditText = z.string().max(2000);

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
  serviceDescriptions: z.record(z.string().max(40), EditText).optional(), // key = facts.services[].name, exact
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
