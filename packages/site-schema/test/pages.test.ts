import { describe, expect, it } from "vitest";
import {
  ALWAYS_PAGES,
  HIDEABLE_SECTIONS,
  isPageId,
  PAGE_IDS,
  pageForPath,
  PAGES,
  QUOTE_HREF,
  QUOTE_ID,
  SECTION_PAGE,
  SECTION_VARIANTS,
  type SectionId,
} from "../src/index.ts";

// A16: a site has up to 5 pages. The page map is fixed; a page with no visible section is left out.
const SECTION_IDS = Object.keys(SECTION_VARIANTS) as SectionId[];

describe("the page map (A16)", () => {
  it("lists the 5 pages in order, each at its own path", () => {
    expect(PAGE_IDS).toEqual(["home", "services", "about", "gallery", "contact"]);
    expect(Object.keys(PAGES)).toEqual([...PAGE_IDS]);
    expect(PAGE_IDS.map((id) => PAGES[id].path)).toEqual(["/", "/services", "/about", "/gallery", "/contact"]);
    expect(PAGE_IDS.map((id) => PAGES[id].label)).toEqual(["Home", "Services", "About", "Gallery", "Contact"]);
  });

  it("puts every section on exactly one page, in the user's order", () => {
    expect(PAGES.home.sections).toEqual(["hero", "trust", "testimonials"]);
    expect(PAGES.services.sections).toEqual(["services", "faq"]);
    expect(PAGES.about.sections).toEqual(["about"]);
    expect(PAGES.gallery.sections).toEqual(["gallery"]);
    expect(PAGES.contact.sections).toEqual(["contact", "serviceArea"]);
    const placed = PAGE_IDS.flatMap((id) => PAGES[id].sections);
    expect([...placed].sort()).toEqual([...SECTION_IDS].sort());
    for (const id of SECTION_IDS) expect(PAGES[SECTION_PAGE[id]].sections).toContain(id);
  });

  it("always has Home, Services and Contact: each holds a section the owner can never hide", () => {
    expect(ALWAYS_PAGES).toEqual(["home", "services", "contact"]);
    const hideable: readonly string[] = HIDEABLE_SECTIONS;
    for (const id of ALWAYS_PAGES) expect(PAGES[id].sections.some((s) => !hideable.includes(s))).toBe(true);
    for (const id of PAGE_IDS.filter((p) => !(ALWAYS_PAGES as readonly string[]).includes(p))) {
      expect(PAGES[id].sections.every((s) => hideable.includes(s))).toBe(true);
    }
  });

  it("links every quote button to the form on the Contact page", () => {
    expect(QUOTE_ID).toBe("quote");
    expect(QUOTE_HREF).toBe("/contact#quote");
  });

  it("cannot be changed at run time", () => {
    expect(Object.isFrozen(PAGES)).toBe(true);
    for (const id of PAGE_IDS) {
      expect(Object.isFrozen(PAGES[id])).toBe(true);
      expect(Object.isFrozen(PAGES[id].sections)).toBe(true);
    }
    expect(Object.isFrozen(SECTION_PAGE)).toBe(true);
    expect(Object.isFrozen(PAGE_IDS)).toBe(true);
    expect(Object.isFrozen(ALWAYS_PAGES)).toBe(true);
  });
});

// The only way a request path or a stored value becomes a page: exact own keys, nothing inherited.
describe("pageForPath and isPageId", () => {
  it("maps each exact path to its page", () => {
    for (const id of PAGE_IDS) expect(pageForPath(PAGES[id].path)).toBe(id);
  });

  it.each(["", "/services/", "/Services", "//services", "/index.html", "/home", "services", "/contact#quote", "/services?x=1", "/__proto__", "/constructor", "/toString", "__proto__", "/hasOwnProperty"])(
    "finds no page for %j",
    (path) => {
      expect(pageForPath(path)).toBeNull();
    },
  );

  it("accepts only the 5 page ids", () => {
    for (const id of PAGE_IDS) expect(isPageId(id)).toBe(true);
    for (const value of ["", "Home", "HOME", "index", "__proto__", "constructor", "toString", "hasOwnProperty", "home ", 0, null, undefined, {}, ["home"]]) {
      expect(isPageId(value)).toBe(false);
    }
  });
});
