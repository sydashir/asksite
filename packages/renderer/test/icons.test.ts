import { describe, expect, it } from "vitest";
import { icon } from "../src/icons.ts";

describe("icon", () => {
  it("renders a decorative, hidden inline SVG", () => {
    expect(String(icon("check", "h-5 w-5 text-primary"))).toBe(
      '<svg class="h-5 w-5 text-primary" viewBox="0 0 24 24" aria-hidden="true">' +
        '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m5 12l5 5L20 7"/></svg>',
    );
  });
});
