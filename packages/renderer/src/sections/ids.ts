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

/** The Home page's services preview and the closing "Get in touch" band: render.ts blocks, not layout sections. */
export const SERVICES_PREVIEW_ID = "services-preview";
export const CLOSING_BAND_ID = "get-in-touch";
