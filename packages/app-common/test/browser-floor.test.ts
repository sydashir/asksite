import { describe, expect, it } from "vitest";
import { BROWSER_FLOOR, BROWSER_FLOOR_BUILD_TARGET } from "../src/index.ts";

// P4-7 (moderator, 2026-09-25): the owner client's browser floor is iOS/Safari 16.4.
describe("browser floor", () => {
  it("names the floor in MDN browser-compat-data browser keys", () => {
    expect(BROWSER_FLOOR).toEqual({ safari: "16.4", safari_ios: "16.4" });
  });

  it("gives the Vite build the targets of the same floor", () => {
    expect(BROWSER_FLOOR_BUILD_TARGET).toEqual(["safari16.4", "ios16.4"]);
  });
});
