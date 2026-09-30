import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DESIGN_IDS } from "@asksite/site-schema";
import { afterAll, describe, expect, it } from "vitest";
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
  it("writes the fixture in every design, each a complete page with its design's real stylesheet inlined", () => {
    const files = renderFixturesToDir(["cleaning-minimal"], tempDir());
    expect(files).toHaveLength(DESIGN_IDS.length);
    DESIGN_IDS.forEach((design, i) => {
      const html = readFileSync(files[i] ?? "", "utf8");
      expect(files[i]).toMatch(new RegExp(`/${design}/cleaning-minimal\\.html$`));
      expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
      expect(html).toContain(`<body data-design="${design}"`);
      expect(html).toContain("tailwindcss v4.3.3");
    });
  });

  it("renders every fixture in every design when no names are given", () => {
    expect(renderFixturesToDir([], tempDir())).toHaveLength(5 * DESIGN_IDS.length);
  });

  it("rejects an unknown fixture name", () => {
    expect(() => renderFixturesToDir(["nope"], tempDir())).toThrow("Unknown fixture: nope");
  });
});
