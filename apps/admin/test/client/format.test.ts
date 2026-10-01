import { describe, expect, it } from "vitest";
import { dollars, restoredText, takedownResult, worstCaseText } from "../../src/client/lib/format.ts";

describe("admin messages", () => {
  it("shows micro-dollars as dollars and cents", () => {
    expect(dollars(0)).toBe("$0.00");
    expect(dollars(10_652_160)).toBe("$10.65");
  });

  it("says the worst case is unknown when the model has no recorded price", () => {
    expect(worstCaseText(8 * 1_331_520)).toBe("$10.65");
    expect(worstCaseText(null)).toBe("Unknown: no price is recorded for this model (check MODEL_PROVIDER and MODEL_ID)");
  });

  it("says after a restore how many of the page's photos were deleted", () => {
    expect(restoredText(0)).toBe("Site restored.");
    expect(restoredText(1)).toBe("Site restored. 1 photo on it was deleted when it was taken down and will not show. Ask the owner to upload new photos and publish again.");
    expect(restoredText(3)).toContain("3 photos on it were deleted");
  });
});

// Honesty rules: the notice line appears only when the owner was NOT emailed (false), never for null; the clean-up line
// never claims the business name is hidden.
describe("takedownResult", () => {
  const BASE = "Site taken down. It stops being served within about a minute.";
  const CLEANUP = "Clean-up did not finish. The business name and phone may still show at its address until you finish it.";
  const NOT_EMAILED = "Owner not emailed — contact them.";

  it("a clean takedown is a success, whether the owner was emailed (true) or no notice was due (null)", () => {
    expect(takedownResult({ noticeSent: true }, null)).toEqual({ tone: "success", text: BASE, cleanupFailed: false, ownerNotEmailed: false });
    expect(takedownResult({ noticeSent: null }, null)).toEqual({ tone: "success", text: BASE, cleanupFailed: false, ownerNotEmailed: false });
  });

  it("an owner who was not emailed is a warning that says to contact them", () => {
    expect(takedownResult({ noticeSent: false }, null)).toEqual({ tone: "warning", text: `${BASE} ${NOT_EMAILED}`, cleanupFailed: false, ownerNotEmailed: true });
  });

  it("a failed clean-up is a warning with the clean-up text, and never says nothing is shown", () => {
    const result = takedownResult({ noticeSent: true, cleanupFailed: true }, null);
    expect(result).toEqual({ tone: "warning", text: `${BASE} ${CLEANUP}`, cleanupFailed: true, ownerNotEmailed: false });
    expect(result.text).not.toContain("nothing from it is shown");
  });

  it("a finished clean-up says so and keeps the earlier 'Owner not emailed' line", () => {
    const first = takedownResult({ noticeSent: false, cleanupFailed: true }, null);
    expect(takedownResult({ noticeSent: null }, first)).toEqual({ tone: "warning", text: `${NOT_EMAILED} Clean-up finished.`, cleanupFailed: false, ownerNotEmailed: true });
    const plain = takedownResult({ noticeSent: true, cleanupFailed: true }, null);
    expect(takedownResult({ noticeSent: null }, plain)).toEqual({ tone: "success", text: "Clean-up finished.", cleanupFailed: false, ownerNotEmailed: false });
  });

  it("a finish that fails again shows the clean-up text with the button, keeping the earlier owner line", () => {
    const first = takedownResult({ noticeSent: false, cleanupFailed: true }, null);
    expect(takedownResult({ noticeSent: null, cleanupFailed: true }, first)).toEqual({ tone: "warning", text: `${NOT_EMAILED} ${CLEANUP}`, cleanupFailed: true, ownerNotEmailed: true });
  });
});
