import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DESIGN_IDS } from "@asksite/site-schema";
import { afterAll, describe, expect, it } from "vitest";
import { renderFixture } from "../fixtures/index.ts";
import { renderFixturesToDir } from "./render-fixture.ts";

// Every folder this test creates is removed afterwards, so runs leave nothing in the temp folder.
const made: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "asksite-render-"));
  made.push(dir);
  return pathToFileURL(`${dir}/`);
};
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe("renderFixturesToDir", () => {
  it("writes every page of the fixture in every design, each a complete page with its design's real stylesheet inlined", () => {
    const files = renderFixturesToDir(["cleaning-minimal"], tempDir());
    const pages = ["home", "services", "contact"]; // no photos and no about text: three pages
    expect(files).toHaveLength(DESIGN_IDS.length * pages.length);
    DESIGN_IDS.forEach((design, d) => {
      pages.forEach((page, p) => {
        const file = files[d * pages.length + p] ?? "";
        const html = readFileSync(file, "utf8");
        expect(file).toMatch(new RegExp(`/${design}/cleaning-minimal/${page}\\.html$`));
        expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
        expect(html).toContain(`<body data-design="${design}"`);
        expect(html).toContain("tailwindcss v4.3.3");
      });
    });
  });

  it("renders every fixture in every design when no names are given", () => {
    const pages = (["plumber-austin", "hvac-phoenix", "roofing-extreme", "cleaning-minimal", "electrical-xss", "it-country", "law-denver", "other-worldwide"] as const).map((name) => renderFixture(name).length);
    expect(pages).toEqual([5, 4, 5, 3, 5, 4, 4, 5]);
    expect(renderFixturesToDir([], tempDir())).toHaveLength(35 * DESIGN_IDS.length);
  });

  it("rejects an unknown fixture name", () => {
    expect(() => renderFixturesToDir(["nope"], tempDir())).toThrow("Unknown fixture: nope");
  });
});
