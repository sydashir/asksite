import { describe, expect, it } from "vitest";
import { publishApiError } from "../../src/worker/publish-errors.ts";

describe("publishApiError", () => {
  it("answers each publishing failure the admin can act on with the design's code", () => {
    expect(publishApiError("site_not_found", "change")).toMatchObject({ code: "not_found" });
    expect(publishApiError("version_not_pending", "review")).toMatchObject({ code: "version_not_pending" });
    expect(publishApiError("site_taken_down", "review")).toMatchObject({ code: "site_taken_down" });
    expect(publishApiError("not_live", "restore")).toMatchObject({ code: "conflict" });
  });

  it("tells the admin to press Approve again when the pages were approved but are not live yet (A16)", () => {
    expect(publishApiError("live_copy_failed", "review")).toMatchObject({ code: "internal", message: "Approved, but the new pages are not live yet. Press Approve again." });
  });

  it("words an integrity failure for the action, and never shows its details", () => {
    expect(publishApiError("integrity", "review")?.message).toBe("The stored page does not match what was reviewed. Reload and review it again.");
    expect(publishApiError("integrity", "restore")?.message).toBe("The stored page does not match its record. It was not restored.");
    expect(publishApiError("integrity", "restore")).toMatchObject({ code: "internal", extra: {} });
  });

  // A16-4c (handoff-plan4.md lines 46-69 of asksite-pages, read-only copy: .superpowers/sdd/a16-4c-contract-copy.md).
  describe("A16-4c: one admin action per site at a time", () => {
    it("site_busy with retryAfter is a 409 that says when to try again, and carries Retry-After", () => {
      expect(publishApiError("site_busy", "restore", { retryAfter: 42 })).toMatchObject({
        code: "conflict",
        message: "Another admin action on this site is still running. Try again in a minute.",
        extra: { retryAfter: 42 },
      });
    });

    it("site_busy lease_lost is a 409 with NO Retry-After, and tells the admin to reload", () => {
      const error = publishApiError("site_busy", "restore", { reason: "lease_lost" });
      expect(error).toMatchObject({ code: "conflict", message: "This action ran too long and was stopped before it finished. Reload to see where the site stands now, then try again." });
      expect(error?.extra).toEqual({});
    });

    it("a lost lease on APPROVE says to press Approve again (the approval may have committed), and on a TAKEDOWN says to finish it; both with no Retry-After", () => {
      const approve = publishApiError("site_busy", "approve", { reason: "lease_lost" });
      expect(approve).toMatchObject({ code: "conflict", message: "This approval ran too long and was stopped before it finished. Press Approve again to finish it and tell the owner." });
      expect(approve?.extra).toEqual({});
      const takedown = publishApiError("site_busy", "takedown", { reason: "lease_lost" });
      expect(takedown).toMatchObject({
        code: "conflict",
        message: "This takedown ran too long and was stopped before it finished. Reload; if the site shows as taken down, press Finish the takedown.",
      });
      expect(takedown?.extra).toEqual({});
      // A held site (retryAfter) is the busy text for every action: nothing ran.
      expect(publishApiError("site_busy", "takedown", { retryAfter: 5 })).toMatchObject({ message: "Another admin action on this site is still running. Try again in a minute.", extra: { retryAfter: 5 } });
    });

    // Delete the account (owner data deletion): the same two site_busy failures, in the words of an owner with several sites. The union is untouched (D-B).
    it("Delete the account: a held site is a 409 that says nothing was deleted, with Retry-After", () => {
      expect(publishApiError("site_busy", "delete_owner", { retryAfter: 5 })).toMatchObject({
        code: "conflict",
        message: "Another admin action on one of this owner's sites is still running. Nothing was deleted. Try again in a minute.",
        extra: { retryAfter: 5 },
      });
    });

    it("Delete the account: a lost lease is a 409 that says to press Finish deleting the account, with no Retry-After", () => {
      const error = publishApiError("site_busy", "delete_owner", { reason: "lease_lost" });
      expect(error).toMatchObject({ code: "conflict", message: "The deletion ran too long and stopped before it finished. Press Finish deleting the account." });
      expect(error?.extra).toEqual({});
    });

    it("Delete the account changes no other action's words, and its other codes stay as they were", () => {
      expect(publishApiError("site_busy", "restore", { retryAfter: 5 })?.message).toBe("Another admin action on this site is still running. Try again in a minute.");
      expect(publishApiError("site_busy", "restore", { reason: "lease_lost" })?.message).toBe("This action ran too long and was stopped before it finished. Reload to see where the site stands now, then try again.");
      expect(publishApiError("site_not_found", "delete_owner")).toMatchObject({ code: "not_found" });
      expect(publishApiError("integrity", "delete_owner")).toMatchObject({ code: "internal" });
    });

    it("a taken-down-again restore says so; a site_taken_down without that reason keeps the plain text", () => {
      expect(publishApiError("site_taken_down", "restore", { reason: "taken_down_again" })).toMatchObject({
        code: "site_taken_down",
        message: "This site was taken down again since you opened this page. Reload to see where it stands now.",
      });
      expect(publishApiError("site_taken_down", "restore")?.message).toBe("This site is taken down");
      expect(publishApiError("site_taken_down", "restore", { reason: "something_else" })?.message).toBe("This site is taken down");
    });

    it("Copy the live pages again on a taken-down site is a 409", () => {
      expect(publishApiError("site_taken_down", "copy")).toMatchObject({ code: "conflict", message: "This site is taken down, so there is nothing to copy. Reload to see where it stands now." });
    });

    it("Copy the live pages again on a site that is not live is a 409 with its final period", () => {
      expect(publishApiError("not_live", "copy")).toMatchObject({ code: "conflict", message: "This site is not live, so there is nothing to copy." });
    });

    it("live_copy_failed has its own text for Restore and for Copy the live pages again", () => {
      expect(publishApiError("live_copy_failed", "restore")?.message).toBe("The site is still offline: its pages could not be put back. Press Restore again.");
      expect(publishApiError("live_copy_failed", "copy")?.message).toBe("The pages could not be copied again. Press Copy the live pages again.");
      expect(publishApiError("live_copy_failed", "restore")).toMatchObject({ code: "internal", extra: {} });
    });

    it("an integrity failure while copying says nothing was copied", () => {
      expect(publishApiError("integrity", "copy")?.message).toBe("The stored pages don't match what was approved, so nothing was copied.");
    });
  });

  it("leaves owner-side failures to the caller, which answers 500", () => {
    expect(publishApiError("render_failed", "review")).toBeNull();
    expect(publishApiError("publish_cap_reached", "review")).toBeNull();
  });
});
