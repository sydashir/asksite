import { describe, expect, it } from "vitest";
import { saveAnnouncement, WORDING_DROPPED, WRITING_DROPPED } from "../../src/client/lib/save-message.ts";

// STRICT (customer data): the notice reaches the screen in every busy or settled state, and "All changes saved." is never said over it.
describe("saveAnnouncement", () => {
  it.each(["saved", "saving", "pending"] as const)("says the wording notice while %s", (status) => {
    expect(saveAnnouncement({ status, rev: 2, wordingDropped: true })).toBe(WORDING_DROPPED);
  });

  it("says exactly why a change made while new wording is written was not saved", () => {
    expect(WRITING_DROPPED).toBe("New wording is being written. Your last change was not saved. Make it again when the new wording is ready.");
    expect(saveAnnouncement({ status: "saved", rev: 2, wordingDropped: true, droppedWhileWriting: true })).toBe(WRITING_DROPPED);
  });

  it("says all saved only without the notice", () => {
    expect(saveAnnouncement({ status: "saved", rev: 2 })).toBe("All changes saved.");
  });

  it("puts a failed save's own warning first", () => {
    expect(saveAnnouncement({ status: "error", rev: 2, message: "No.", wordingDropped: true })).toBe("Your changes are not saved yet. No.");
  });
});
