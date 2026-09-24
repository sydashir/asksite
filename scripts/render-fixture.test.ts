import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
  it("writes a complete page with the real stylesheet inlined", () => {
    const [file] = renderFixturesToDir(["cleaning-minimal"], tempDir());
    const html = readFileSync(file ?? "", "utf8");
    expect(file).toMatch(/cleaning-minimal\.html$/);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("tailwindcss v4.3.3");
  });

  it("renders every fixture when no names are given", () => {
    expect(renderFixturesToDir([], tempDir())).toHaveLength(5);
  });

  it("rejects an unknown fixture name", () => {
    expect(() => renderFixturesToDir(["nope"], tempDir())).toThrow("Unknown fixture: nope");
  });
});
