import type { SectionId } from "@asksite/site-schema";

/** Element id of each section, used for in-page links and aria-labelledby. */
export const DOM_ID: Record<SectionId, string> = {
  hero: "top",
  trust: "credentials",
  services: "services",
  testimonials: "reviews",
  gallery: "our-work",
  about: "about",
  serviceArea: "service-area",
  faq: "faq",
  contact: "contact",
};

/** Header navigation label; sections without one are not linked from the menu. */
export const NAV_LABEL: Partial<Record<SectionId, string>> = {
  services: "Services",
  testimonials: "Reviews",
  gallery: "Our work",
  about: "About",
  serviceArea: "Service area",
  faq: "FAQ",
  contact: "Contact",
};
