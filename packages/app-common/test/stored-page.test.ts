import { versionKey, versionPageKey } from "@asksite/core";
import { PAGE_IDS } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { storedPageKey } from "../src/stored-page.ts";

const SITE = "11111111-1111-4111-8111-111111111111";
const VERSION = "22222222-2222-4222-8222-222222222222";
const SHA = "a".repeat(64);
const listed = (...pages: string[]) => JSON.stringify(pages.map((page) => ({ page, sha256: SHA })));
const row = (pages_json: string) => ({ id: VERSION, site_id: SITE, pages_json });

describe("storedPageKey: the WORK key of one page of a stored version, or null", () => {
  it("gives the key versionPageKey builds for a page the version lists (Home at the old key)", () => {
    const pages = row(listed("home", "services", "about", "contact"));
    expect(storedPageKey(pages, "home")).toBe(versionKey(SITE, VERSION));
    for (const page of ["services", "about", "contact"] as const) expect(storedPageKey(pages, page)).toBe(versionPageKey(SITE, VERSION, page));
  });

  it("gives null for a page the version does not list", () => {
    expect(storedPageKey(row(listed("home", "services", "contact")), "gallery")).toBeNull();
  });

  it("gives null for every id that is not one of the five pages", () => {
    const pages = row(listed("home", "services", "about", "contact"));
    for (const id of ["nope", "Home", "HOME", "home.html", "__proto__", "constructor", "toString", "../home", "..%2Fhome", "home/../about", "home\0", " home", ""]) {
      expect([id, storedPageKey(pages, id)]).toEqual([id, null]);
    }
  });

  it("gives null for every page of a row from before A16 ('[]'), and of a row whose list is damaged", () => {
    for (const json of ["[]", "", "not json", "null", "{}", listed("services"), listed("home", "home"), listed("home", "about", "services"), JSON.stringify([{ page: "home" }])]) {
      for (const page of PAGE_IDS) expect([json, page, storedPageKey(row(json), page)]).toEqual([json, page, null]);
    }
  });
});
