import { z } from "zod";

// Closed set of sections and variants. Header and footer are always rendered and are not listed here.
export const SECTION_VARIANTS = {
  hero: ["centered", "photo"],
  trust: ["band", "light"],
  services: ["cards", "compact"],
  testimonials: ["grid", "masonry"],
  gallery: ["grid"],
  about: ["plain"],
  serviceArea: ["split"],
  faq: ["accordion", "open"],
  contact: ["card"],
} as const;

export type SectionId = keyof typeof SECTION_VARIANTS;
export type VariantOf<Id extends SectionId> = (typeof SECTION_VARIANTS)[Id][number];

const section = <Id extends SectionId>(id: Id) =>
  z.strictObject({ id: z.literal(id), variant: z.enum(SECTION_VARIANTS[id]) });

export const LayoutSection = z.discriminatedUnion("id", [
  section("hero"),
  section("trust"),
  section("services"),
  section("testimonials"),
  section("gallery"),
  section("about"),
  section("serviceArea"),
  section("faq"),
  section("contact"),
]);

export const Layout = z
  .array(LayoutSection)
  .min(1)
  .max(Object.keys(SECTION_VARIANTS).length)
  .refine((sections) => sections[0]?.id === "hero", { error: "The first section must be the hero" })
  .refine((sections) => new Set(sections.map((s) => s.id)).size === sections.length, {
    error: "Each section may appear only once",
  });

export type LayoutSection = z.infer<typeof LayoutSection>;
export type Layout = z.infer<typeof Layout>;

/**
 * Amendment A6. Sections the OWNER may hide from the page. Hero, services and contact are not
 * here: every page must say what the business does and how to reach it.
 */
export const HIDEABLE_SECTIONS = ["trust", "testimonials", "gallery", "about", "serviceArea", "faq"] as const;
export type HideableSectionId = (typeof HIDEABLE_SECTIONS)[number];
/** Sections the OWNER chose to hide. Never produced by the AI. */
export const OwnerHidden = z
  .array(z.enum(HIDEABLE_SECTIONS))
  .max(HIDEABLE_SECTIONS.length)
  .refine((ids) => new Set(ids).size === ids.length, { error: "A section can be hidden only once" });
