import { describe, expect, it } from "vitest";
import { headingLevel, navItems, onPage, onSite, pageLink, quoteLink, sectionLink } from "../src/context.ts";
import { FULL, makeContext, MINIMAL } from "./support/doc.ts";

describe("render context helpers (A16)", () => {
  const home = makeContext(FULL);
  const services = makeContext(FULL, "services");
  const noGallery = makeContext({ ...FULL, hidden: ["gallery", "about"] }, "services");

  it("onPage: the section is on this page; onSite: on any rendered page", () => {
    expect([onPage(home, "hero"), onPage(home, "services"), onPage(services, "services"), onPage(services, "faq")]).toEqual([true, false, true, true]);
    expect([onSite(home, "services"), onSite(home, "gallery"), onSite(noGallery, "gallery"), onSite(noGallery, "about")]).toEqual([true, true, false, false]);
  });

  it("pageLink: the page's path; it throws for a page the site does not render", () => {
    expect(String(pageLink(home, "services"))).toBe("/services");
    expect(String(pageLink(noGallery, "home"))).toBe("/");
    expect(() => pageLink(noGallery, "gallery")).toThrow("not rendered");
    expect(() => pageLink(home, "nope" as never)).toThrow();
  });

  it("sectionLink: #id on this page, /path#id from another page, and a throw when the site does not draw it", () => {
    expect(String(sectionLink(services, "faq"))).toBe("#faq");
    expect(String(sectionLink(home, "faq"))).toBe("/services#faq");
    expect(String(sectionLink(home, "serviceArea"))).toBe("/contact#service-area");
    expect(String(sectionLink(services, "hero"))).toBe("/#top");
    expect(() => sectionLink(noGallery, "gallery")).toThrow("not rendered");
  });

  it("quoteLink: the form on the Contact page", () => {
    expect(String(quoteLink())).toBe("/contact#quote");
  });

  it("navItems: every rendered page in order with its label, and only the current one marked", () => {
    expect(navItems(services).map((n) => [String(n.href), n.label, n.current])).toEqual([
      ["/", "Home", false],
      ["/services", "Services", true],
      ["/about", "About", false],
      ["/gallery", "Gallery", false],
      ["/contact", "Contact", false],
    ]);
    expect(navItems(makeContext(MINIMAL, "contact")).map((n) => [String(n.href), n.current])).toEqual([["/", false], ["/services", false], ["/contact", true]]);
  });

  it("headingLevel: 1 only for the first section of an inner page", () => {
    expect([headingLevel(home, "hero"), headingLevel(home, "testimonials")]).toEqual([2, 2]);
    expect([headingLevel(services, "services"), headingLevel(services, "faq")]).toEqual([1, 2]);
    expect([headingLevel(makeContext(FULL, "contact"), "contact"), headingLevel(makeContext(FULL, "about"), "about")]).toEqual([1, 1]);
    const leading = makeContext({ ...FULL, layout: [FULL.layout[0], ...FULL.layout.slice(1).reverse()] } as typeof FULL, "contact");
    expect([headingLevel(leading, "serviceArea"), headingLevel(leading, "contact")]).toEqual([1, 2]);
  });
});
