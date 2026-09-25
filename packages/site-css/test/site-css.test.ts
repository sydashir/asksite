import { readFileSync } from "node:fs";
import { sha256Hex } from "@asksite/core";
import { describe, expect, it } from "vitest";
import { SITE_CSS, SITE_CSS_SHA256 } from "../src/index.ts";

describe("@asksite/site-css", () => {
  it("is exactly the renderer's compiled stylesheet", () => {
    expect(SITE_CSS).toBe(readFileSync(new URL("../../renderer/styles/site.css", import.meta.url), "utf8"));
    expect(SITE_CSS).toContain("tailwindcss v4.3.3");
  });

  it("carries the SHA-256 that core's sha256Hex computes", async () => {
    expect(SITE_CSS_SHA256).toBe(await sha256Hex(SITE_CSS));
    expect(SITE_CSS_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("can be inlined: render() refuses a stylesheet containing </style", () => {
    expect(SITE_CSS).not.toMatch(/<\/style/i);
  });
});
