import { describe, expect, it } from "vitest";
import { BROWSER_FLOOR, BROWSER_FLOOR_BUILD_TARGET } from "../src/index.ts";

// The owner client's browser floor (P4-7 and the moderator, 2026-10-06): the highest of Vite's target, Intl.Segmenter, P4-7 and Tailwind v4.
describe("browser floor", () => {
  it("names the floor in MDN browser-compat-data browser keys", () => {
    expect(BROWSER_FLOOR).toEqual({ chrome: "111", edge: "111", firefox: "128", safari: "16.4", safari_ios: "16.4" });
  });

  it("gives the Vite build the targets of the same floor", () => {
    expect(BROWSER_FLOOR_BUILD_TARGET).toEqual(["chrome111", "edge111", "firefox128", "safari16.4", "ios16.4"]);
  });
});
