import { describe, expect, it } from "vitest";
import { dollars, jobCostText, jobLineText, restoredText, revokeNotice, spentTodayText, takedownResult, when, worstCaseText } from "../../src/client/lib/format.ts";

describe("admin messages", () => {
  it("shows micro-dollars as dollars and cents", () => {
    expect(dollars(0)).toBe("$0.00");
    expect(dollars(10_652_160)).toBe("$10.65");
  });

  it("says the worst case is unknown when the model has no recorded price", () => {
    expect(worstCaseText(8 * 1_331_520)).toBe("$10.66");
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
  const CLEANUP = "Clean-up did not finish. The site is offline; old page files stay in storage until you finish it.";
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

describe("revokeNotice: the Invites screen's words after a revoke", () => {
  it("says the invite was revoked only when the revoke worked", () => {
    expect(revokeNotice({ ok: true }, "a@example.com")).toEqual({ tone: "success", text: "Invite for a@example.com revoked." });
  });

  it("shows the server's message as an error, never 'revoked', when the invite was already used", () => {
    const used = { ok: false as const, error: { code: "conflict", message: "This invite was already used, so it can't be revoked." } };
    const notice = revokeNotice(used, "a@example.com");
    expect(notice).toEqual({ tone: "error", text: "This invite was already used, so it can't be revoked." });
    expect(notice.text).not.toContain("Invite for a@example.com revoked.");
  });
});

// STRICT (money and honesty): what the admin may say a job cost. A job that sent no call gave its model slot back (model_slot 0 at finish),
// so only then is "$0.00" true. A model_slot 1 row that finished with cost 0 (our own code threw after a call; a row the sweeper ended)
// may have been billed: its cost is unknown, never "$0.00". The label is decided by status, model_slot and cost, never by attempts.
describe("jobCostText (one AI writing job's cost line)", () => {
  const job = (status: "queued" | "running" | "succeeded" | "failed", modelSlot: 0 | 1, costMicrousd: number, attempts = 0) => ({ status, modelSlot, costMicrousd, attempts });

  it("shows no cost for a job that has not finished (queued or running)", () => {
    expect(jobCostText(job("queued", 0, 0))).toBeNull();
    expect(jobCostText(job("running", 1, 0))).toBeNull();
    expect(jobCostText(job("running", 1, 250_000, 1))).toBeNull();
  });

  it("says $0.00 for a finished job that gave its model slot back (no call was sent)", () => {
    expect(jobCostText(job("failed", 0, 0))).toBe("$0.00");
    expect(jobCostText(job("succeeded", 0, 0))).toBe("$0.00");
  });

  it("says Up to $X for a finished job that kept its model slot and recorded a cost", () => {
    expect(jobCostText(job("succeeded", 1, 336_000, 1))).toBe("Up to $0.34");
    expect(jobCostText(job("failed", 1, 1_331_520, 3))).toBe("Up to $1.34");
  });

  it("says Cost unknown for a finished job that kept its model slot and recorded no cost: our own code threw after a call (status failed, internal, attempts 0)", () => {
    expect(jobCostText(job("failed", 1, 0, 0))).toBe("Cost unknown");
  });

  it("says Cost unknown for a row the sweeper ended with no cost (failed internal, or succeeded with the starter wording after a provider error)", () => {
    expect(jobCostText(job("failed", 1, 0, 1))).toBe("Cost unknown");
    expect(jobCostText(job("succeeded", 1, 0, 0))).toBe("Cost unknown");
  });

  it("does not use attempts: a model_slot 1 row with attempts 0 is unknown, a model_slot 0 row with attempts 2 is $0.00", () => {
    expect(jobCostText(job("failed", 1, 0, 0))).toBe("Cost unknown");
    expect(jobCostText(job("failed", 0, 0, 2))).toBe("$0.00");
  });
});

describe("spentTodayText (the Settings page's Spent today)", () => {
  it("says $0.00 when no job took a model slot today", () => {
    expect(spentTodayText(0, 0, 0)).toBe("$0.00");
  });

  it("says Up to $X when every model-slot job finished with a recorded cost", () => {
    expect(spentTodayText(700, 2, 0)).toBe("Up to $0.01");
    expect(spentTodayText(10_652_160, 8, 0)).toBe("Up to $10.66");
  });

  it("names the one job whose cost is unknown", () => {
    expect(spentTodayText(336_000, 2, 1)).toBe("Up to $0.34, not counting 1 job whose cost is unknown");
  });

  it("counts the jobs whose cost is unknown, when there are several", () => {
    expect(spentTodayText(336_000, 4, 3)).toBe("Up to $0.34, not counting 3 jobs whose cost is unknown");
    expect(spentTodayText(0, 2, 2)).toBe("Up to $0.00, not counting 2 jobs whose cost is unknown");
  });
});

// STRICT (money and honesty): an "Up to $X" figure is an upper bound, so it rounds UP to the cent (1 cent = 10,000 micro-dollars) and never
// shows less than the recorded bound. Only an exact 0 shows "$0.00".
describe("Up to figures round up to the cent", () => {
  const BOUNDARIES: Array<[number, string]> = [
    [0, "$0.00"],
    [1, "$0.01"],
    [700, "$0.01"],
    [4_999, "$0.01"],
    [5_000, "$0.01"],
    [10_000, "$0.01"],
    [10_001, "$0.02"],
    [1_331_520, "$1.34"],
  ];

  it.each(BOUNDARIES)("spentTodayText with unknown jobs shows %i micro-dollars as %s", (microusd, dollarsText) => {
    expect(spentTodayText(microusd, 2, 1)).toBe(`Up to ${dollarsText}, not counting 1 job whose cost is unknown`);
  });

  it.each(BOUNDARIES.filter(([microusd]) => microusd > 0))("jobCostText shows a recorded cost of %i micro-dollars as Up to %s", (microusd, dollarsText) => {
    expect(jobCostText({ status: "succeeded", modelSlot: 1, costMicrousd: microusd })).toBe(`Up to ${dollarsText}`);
  });

  it.each(BOUNDARIES)("worstCaseText (Most it can cost per day) shows %i micro-dollars as %s", (microusd, dollarsText) => {
    expect(worstCaseText(microusd)).toBe(dollarsText);
  });

  it("keeps an exact 0 at $0.00 in Spent today, and keeps the plain dollars format for the other figures", () => {
    expect(spentTodayText(0, 1, 1)).toBe("Up to $0.00, not counting 1 job whose cost is unknown");
    expect(dollars(1_331_520)).toBe("$1.33");
  });
});

// The job line may not state "no model" or "0 attempts" as facts when its cost is unknown: those rows (swept, or DraftRejected) keep provider null
// or attempts 0 although a paid call may have been made.
describe("jobLineText (one AI writing job's line on the site page)", () => {
  const AT = Date.UTC(2026, 9, 7, 12, 0);
  const row = (over: Partial<Parameters<typeof jobLineText>[0]>) => ({
    createdAt: AT, kind: "regenerate", status: "succeeded" as const, usedFallback: false, provider: "anthropic" as string | null, model: "claude-opus-5-5" as string | null, modelSlot: 1 as 0 | 1, costMicrousd: 336_000, attempts: 1, ...over,
  });
  const head = `${when(AT)}: regenerate`;

  it("states provider, model, the capped cost and attempts for a job whose cost is known", () => {
    expect(jobLineText(row({}))).toBe(`${head}, succeeded · anthropic claude-opus-5-5 · Up to $0.34 · 1 attempts`);
  });

  it("says only Cost unknown, with no model and no attempts, when the cost is unknown (a swept row: no provider, 0 attempts)", () => {
    expect(jobLineText(row({ status: "failed", provider: null, model: null, costMicrousd: 0, attempts: 0 }))).toBe(`${head}, failed · Cost unknown`);
  });

  it("says only Cost unknown for a rejected draft that stored the configured model and 0 attempts", () => {
    expect(jobLineText(row({ status: "failed", costMicrousd: 0, attempts: 0 }))).toBe(`${head}, failed · Cost unknown`);
  });

  it("keeps the starter-wording note and states $0.00 with its attempts for a job that sent no call", () => {
    expect(jobLineText(row({ usedFallback: true, modelSlot: 0, costMicrousd: 0, attempts: 0, provider: null, model: null }))).toBe(`${head}, succeeded (starter wording) · no model  · $0.00 · 0 attempts`);
  });

  it("shows no cost yet for a running job, and keeps its provider and attempts", () => {
    expect(jobLineText(row({ status: "running", costMicrousd: 0, attempts: 0, provider: null, model: null }))).toBe(`${head}, running · no model  · 0 attempts`);
  });
});
