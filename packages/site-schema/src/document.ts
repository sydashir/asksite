import { z } from "zod";
import { HIDDEN_IN_COPY, proseIn, unbackedClaims } from "./claims.ts";
import { Copy } from "./copy.ts";
import { Facts } from "./facts.ts";
import { Layout, OwnerHidden, type LayoutSection, type SectionId } from "./layout.ts";
import { Theme } from "./theme.ts";

/**
 * Sections whose content is owner facts, for the facts this owner gave. The layout must list
 * each of them: the AI chooses order and variants but can never hide an owner fact.
 */
export function factSections(facts: Facts): SectionId[] {
  const sections: SectionId[] = ["services", "serviceArea", "contact"];
  if (facts.licences.length > 0 || facts.insured || facts.yearFounded !== undefined || facts.emergency247) sections.push("trust");
  if (facts.testimonials.length > 0) sections.push("testimonials");
  if (facts.photos.length > 0) sections.push("gallery");
  return sections;
}

export const SiteDocument = z
  .strictObject({ facts: Facts, copy: Copy, layout: Layout, theme: Theme, hidden: OwnerHidden.default([]) })
  // The hero shows the owner's hero photo only in its "photo" variant, so a hero photo decides the
  // variant and the AI's layout can never hide it. Without a hero photo both variants render the
  // same text-only hero, so the AI's choice stands.
  .overwrite((doc) =>
    doc.facts.heroPhoto === undefined
      ? doc
      : { ...doc, layout: doc.layout.map((s): LayoutSection => (s.id === "hero" ? { id: "hero", variant: "photo" } : s)) },
  )
  .superRefine((doc, ctx) => {
    const names = doc.facts.services.map((s) => s.name);
    const described = doc.copy.serviceDescriptions.map((d) => d.service);
    if (described.length !== names.length || described.some((name, i) => name !== names[i])) {
      ctx.addIssue({
        code: "custom",
        path: ["copy", "serviceDescriptions"],
        message: "copy.serviceDescriptions must name every facts.services entry once, in the same order",
      });
    }

    const listed = new Set(doc.layout.map((s) => s.id));
    const missing = factSections(doc.facts).filter((id) => !listed.has(id));
    if (missing.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["layout"],
        message: `The layout must include every section that shows owner facts; missing: ${missing.join(", ")}`,
      });
    }

    for (const [path, text] of proseIn(doc.copy)) {
      // A hidden mark can split a claim word (e.g. "Licen\u034Fsed"). The claim check below removes
      // combining marks (A9) and still finds the claim, but an invisible character is refused outright.
      if (HIDDEN_IN_COPY.test(text)) {
        ctx.addIssue({
          code: "custom",
          path: ["copy", ...path],
          message: "Copy must not contain an invisible character",
        });
      }

      const claims = unbackedClaims(text, doc.facts);
      if (claims.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["copy", ...path],
          message: `Copy states something the owner's facts do not back: ${claims.map((c) => JSON.stringify(c)).join(", ")}`,
        });
      }
    }
  });

/** Parsed document: defaults applied, every string trimmed and length-checked, hero photo shown. */
export type SiteDocument = z.infer<typeof SiteDocument>;
/** What callers may pass in (optional arrays and flags may be omitted). */
export type SiteDocumentInput = z.input<typeof SiteDocument>;
