import type { SectionId } from "./layout.ts";

// A16 (user decision 2026-10-01): a site has up to 5 pages. The map is fixed: each section lives on exactly one
// page, in the order below, and a page whose sections are all left out (no content, or hidden by the owner)
// is left out too. Home, Services and Contact always exist, because each holds a section that always has
// content and can never be hidden (hero, services, contact). Everything that turns a page into a path, a
// key or a link reads this map, so no caller ever builds a path from its own string.

export const PAGE_IDS = Object.freeze(["home", "services", "about", "gallery", "contact"] as const);
export type PageId = (typeof PAGE_IDS)[number];

interface PageSpec {
  readonly path: `/${string}`;
  readonly label: string;
  readonly sections: readonly SectionId[];
}

const page = <const P extends PageSpec>(spec: P): P => Object.freeze({ ...spec, sections: Object.freeze([...spec.sections]) }) as P;

/** The fixed page map. `sections` is the page's own order; `label` is the page's name in menus and titles. */
export const PAGES = Object.freeze({
  home: page({ path: "/", label: "Home", sections: ["hero", "trust", "testimonials"] }),
  services: page({ path: "/services", label: "Services", sections: ["services", "faq"] }),
  about: page({ path: "/about", label: "About", sections: ["about"] }),
  gallery: page({ path: "/gallery", label: "Gallery", sections: ["gallery"] }),
  contact: page({ path: "/contact", label: "Contact", sections: ["contact", "serviceArea"] }),
} as const satisfies Record<PageId, PageSpec>);
export type PagePath = (typeof PAGES)[PageId]["path"];

/** The page each section lives on. */
export const SECTION_PAGE: Readonly<Record<SectionId, PageId>> = Object.freeze(
  Object.fromEntries(PAGE_IDS.flatMap((id) => PAGES[id].sections.map((section) => [section, id]))) as Record<SectionId, PageId>,
);

/** The pages every site has. */
export const ALWAYS_PAGES = Object.freeze(["home", "services", "contact"] as const satisfies readonly PageId[]);

/** Every "Get a quote" link goes to the form on the Contact page, whose <form> carries this id. */
export const QUOTE_ID = "quote";
export const QUOTE_HREF = `${PAGES.contact.path}#${QUOTE_ID}` as const;

/** True only for the 5 page ids (own keys of PAGES, never an inherited name such as "constructor"). */
export function isPageId(value: unknown): value is PageId {
  return typeof value === "string" && Object.hasOwn(PAGES, value);
}

const PAGE_BY_PATH: Readonly<Record<string, PageId>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, PageId>, Object.fromEntries(PAGE_IDS.map((id) => [PAGES[id].path, id]))),
);

/** The page at exactly this path ("/services"), or null. No trailing slash, case folding or decoding. */
export function pageForPath(path: string): PageId | null {
  return Object.hasOwn(PAGE_BY_PATH, path) ? (PAGE_BY_PATH[path] ?? null) : null;
}
