import { describe, expect, it } from "vitest";
import { fieldId, issueTarget } from "../../src/client/lib/values.ts";

describe("issueTarget", () => {
  const hours = [
    { days: ["Tuesday", "Wednesday"], opens: "08:00", closes: "17:00" },
    { days: [], opens: "09:00", closes: "12:00" },
  ];

  it("sends an opening or closing time error to that entry's first day field, which the form really has", () => {
    expect(issueTarget(["facts", "hours", 0, "opens"], { hours })).toBe("hours-Tuesday-opens");
    expect(issueTarget(["facts", "hours", 0, "closes"], { hours })).toBe("hours-Tuesday-closes");
  });

  it("sends every other opening-hours issue, and an entry with no days, to the Opening hours group", () => {
    expect(issueTarget(["facts", "hours"], { hours })).toBe("f-facts-hours");
    expect(issueTarget(["facts", "hours", 0, "days"], { hours })).toBe("f-facts-hours");
    expect(issueTarget(["facts", "hours", 1, "opens"], { hours })).toBe("f-facts-hours");
  });

  it("leaves every other path at its own field", () => {
    expect(issueTarget(["facts", "phone"], {})).toBe(fieldId(["facts", "phone"]));
    expect(issueTarget(["facts", "services", 1, "name"], {})).toBe("f-facts-services-1-name");
  });
});
