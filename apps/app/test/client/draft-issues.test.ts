import { describe, expect, it } from "vitest";
import { answerIssues, issuesForStep, stepOf } from "../../src/client/lib/draft-issues.ts";
import { ownerMessage } from "../../src/client/lib/messages.ts";
import { VALID_BRIEF, VALID_FACTS } from "../support/facts.ts";

describe("answerIssues", () => {
  it("is empty for a finished questionnaire with a web address", () => {
    expect(answerIssues({ facts: VALID_FACTS, brief: VALID_BRIEF }, { slug: "joes" }, [])).toEqual([]);
  });

  it("asks for the web address and the review attestation", () => {
    const facts = { ...VALID_FACTS, testimonials: [{ quote: "Great", name: "Ana" }] };
    const issues = answerIssues({ facts, brief: VALID_BRIEF }, { slug: null }, []);
    expect(issues.map((i) => i.code)).toEqual(["attestation_required", "slug_missing"]);
    expect(answerIssues({ facts, brief: { ...VALID_BRIEF, reviewsAreReal: true } }, { slug: "x" }, [])).toEqual([]);
  });

  it("assigns every issue of an empty draft to a step", () => {
    const issues = answerIssues({ facts: {}, brief: {} }, { slug: null }, []);
    expect(issues.every((i) => stepOf(i) !== null)).toBe(true);
    expect(issuesForStep(issues, "business").map((i) => i.path.join("."))).toEqual([
      "facts.businessName", "facts.trade", "facts.phone", "facts.email", "facts.location",
    ]);
    expect(issuesForStep(issues, "words").map((i) => i.path.join("."))).toEqual(["brief.tone", "brief.goal"]);
  });

  it("sends a problem in a step's own comment box to that step, not to the last one", () => {
    const brief = { ...VALID_BRIEF, comments: { business: "Call me​back", words: "x".repeat(501) } };
    const issues = answerIssues({ facts: VALID_FACTS, brief }, { slug: "joes" }, []);
    expect(issues.map((i) => [i.path.join("."), stepOf(i)])).toEqual([
      ["brief.comments.business", "business"],
      ["brief.comments.words", "words"],
    ]);
  });
});

// PROPOSED AMENDMENT (approved by web-maker-99, task-12-extra.md): exactly one message per time field, and the
// order message only for two valid times in the wrong order.
describe("answerIssues on opening hours", () => {
  it.each([
    ["", "17:00", [["facts.hours.0.opens", "Please enter a time."]]],
    ["08:00", "", [["facts.hours.0.closes", "Please enter a time."]]],
    ["", "", [["facts.hours.0.opens", "Please enter a time."], ["facts.hours.0.closes", "Please enter a time."]]],
    ["abc", "08:00", [["facts.hours.0.opens", "Please enter a time."]]],
    ["9:00", "17:00", [["facts.hours.0.opens", "Please enter a time."]]],
    ["08:00", "25:00", [["facts.hours.0.closes", "Please enter a time."]]],
    ["18:00", "08:00", [["facts.hours.0.closes", "Closing time must be after opening time."]]],
    ["08:00", "17:00", []],
  ])("opens %j, closes %j", (opens, closes, expected) => {
    const facts = { ...VALID_FACTS, hours: [{ days: ["Monday"], opens, closes }] };
    const issues = answerIssues({ facts, brief: VALID_BRIEF }, { slug: "joes" }, []);
    expect(issues.map((i) => [i.path.join("."), ownerMessage(i).text])).toEqual(expected);
  });

  it("keeps the order check of another entry whose times are valid", () => {
    const hours = [
      { days: ["Monday"], opens: "08:00", closes: "" },
      { days: ["Tuesday"], opens: "18:00", closes: "08:00" },
    ];
    const issues = answerIssues({ facts: { ...VALID_FACTS, hours }, brief: VALID_BRIEF }, { slug: "joes" }, []);
    expect(issues.map((i) => [i.path.join("."), ownerMessage(i).text])).toEqual([
      ["facts.hours.0.closes", "Please enter a time."],
      ["facts.hours.1.closes", "Closing time must be after opening time."],
    ]);
  });
});
