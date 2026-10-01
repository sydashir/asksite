import { describe, expect, it } from "vitest";
import { fieldId, issueTarget } from "../../src/client/lib/values.ts";

describe("issueTarget", () => {
  it("sends every opening-hours issue to the Opening hours group, which the form really has", () => {
    expect(issueTarget(["facts", "hours", 0, "opens"])).toBe("f-facts-hours");
    expect(issueTarget(["facts", "hours", 2, "closes"])).toBe("f-facts-hours");
    expect(issueTarget(["facts", "hours"])).toBe("f-facts-hours");
  });

  it("leaves every other path at its own field", () => {
    expect(issueTarget(["facts", "phone"])).toBe(fieldId(["facts", "phone"]));
    expect(issueTarget(["facts", "services", 1, "name"])).toBe("f-facts-services-1-name");
  });
});
