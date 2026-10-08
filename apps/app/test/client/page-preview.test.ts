import { describe, expect, it } from "vitest";
import { pageToShow } from "../../src/client/lib/page-preview.ts";

describe("pageToShow: the page the preview shows when the owner's site changes", () => {
  const pages = [{ page: "home" as const }, { page: "services" as const }, { page: "contact" as const }];

  it("keeps the page on screen while the site still has it, and says nothing", () => {
    expect(pageToShow(pages, "services")).toEqual({ page: "services", note: null });
  });

  it("falls back to Home when the page on screen is gone (the owner hid About), and says so", () => {
    expect(pageToShow(pages, "about")).toEqual({ page: "home", note: "The About page is no longer on your site. Showing Home." });
    expect(pageToShow(pages, "gallery").note).toBe("The Gallery page is no longer on your site. Showing Home.");
  });
});
