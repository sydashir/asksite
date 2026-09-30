import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The approval rule is enforced by bindings (design §0.2): asksite-sites only reads LIVE and MEDIA
// and has no WORK binding. This scan keeps it that way in source too.
const srcDir = resolve(import.meta.dirname, "../src");
const sources = readdirSync(srcDir)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ file: f, text: readFileSync(resolve(srcDir, f), "utf8") }));

describe("asksite-sites source", () => {
  it("has files to scan", () => {
    expect(sources.length).toBeGreaterThan(5);
  });

  it("never writes to or deletes from LIVE or MEDIA", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/\b(LIVE|MEDIA)\s*\.\s*(put|delete|createMultipartUpload|resumeMultipartUpload)\b/);
    }
  });

  it("never mentions the WORK bucket", () => {
    for (const { file, text } of sources) expect(text, file).not.toMatch(/\bWORK\b|asksite-work/);
  });

  it("never logs request headers, IPs or lead fields", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/console\.(log|info|warn|error)\((?!JSON\.stringify\(\{ worker: "asksite-sites")/);
    }
  });
});
