import { SiteDocument, Facts } from "@asksite/site-schema";
import { EMPTY_EDITS, OwnerEdits, toIssues, type Issue } from "@asksite/core";
import { describe, expect, it } from "vitest";
import { issuesAt, issuesUnder, ownerMessage } from "../../src/client/lib/messages.ts";
import { VALID_FACTS } from "../support/facts.ts";

const issue = (path: Issue["path"], code: string, message: string): Issue => ({ path, code, message });

describe("ownerMessage", () => {
  it("explains an unbacked claim and links to the fact that allows it", () => {
    expect(ownerMessage(issue(["copy", "heroHeadline"], "custom", 'Copy states something the owner\'s facts do not back: "Licensed"'))).toEqual({
      text: "To say “licensed”, add your license.",
      fix: { step: "trust", field: ["facts", "licences"], label: "Add a license" },
    });
    expect(ownerMessage(issue(["copy", "ctaText"], "custom", 'Copy states something the owner\'s facts do not back: "free"')).fix?.field).toEqual(["facts", "freeEstimates"]);
    expect(ownerMessage(issue(["copy", "about"], "custom", 'Copy states something the owner\'s facts do not back: "since"')).fix?.field).toEqual(["facts", "yearFounded"]);
    expect(ownerMessage(issue(["copy", "about"], "custom", 'Copy states something the owner\'s facts do not back: "bonded"'))).toEqual({
      text: "Please remove “bonded”: some states do not allow advertising the bond.",
    });
  });

  it("combines several claims in one field", () => {
    const m = ownerMessage(issue(["copy", "about"], "custom", 'Copy states something the owner\'s facts do not back: "guaranteed", "insured"'));
    expect(m.text).toBe("Please remove “guaranteed”: we cannot show guarantees we cannot check. To say “insured”, tick “We are insured”.");
    expect(m.fix?.field).toEqual(["facts", "insured"]);
  });

  it("names both facts that allow the full-week phrase: opening hours on all 7 days, or 24/7 service (A8c)", () => {
    for (const word of ["seven days a week", "Seven-day-a-week", "seven days/week"]) {
      expect(ownerMessage(issue(["copy", "about"], "custom", `Copy states something the owner's facts do not back: "${word}"`))).toEqual({
        text: `To say “${word}”, set opening hours for all 7 days, or turn on 24/7 emergency service.`,
        fix: { step: "area", field: ["facts", "hours"], label: "Set your hours" },
      });
    }
  });

  it("explains the no-numbers rule, script rule and hidden characters", () => {
    expect(ownerMessage(issue(["copy", "heroHeadline"], "custom", "Copy must not contain numbers, currency symbols, @ or links; facts come from the owner")).text).toMatch(/^Numbers, prices/);
    expect(ownerMessage(issue(["copy", "about"], "custom", "AI copy must use Latin script only; other scripts can spell out numbers and prices")).text).toBe("Please use English letters here.");
    expect(ownerMessage(issue(["copy", "about"], "custom", "Copy must not contain an invisible character")).text).toMatch(/hidden characters/);
  });

  it("turns zod length messages into limits", () => {
    expect(ownerMessage(issue(["copy", "heroHeadline"], "too_big", "Too big: expected string to have <=80 characters")).text).toBe("Please use 80 characters or fewer.");
    expect(ownerMessage(issue(["facts", "services"], "too_big", "Too big: expected array to have <=12 items")).text).toBe("You can add up to 12.");
    expect(ownerMessage(issue(["copy", "serviceDescriptions", 0, "description"], "too_small", "Too small: expected string to have >=1 characters")).text).toBe("Please fill this in.");
  });

  it("counts described services, not characters, when there are too many descriptions (A8c-2)", () => {
    const thirteen = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`Service ${i + 1}`, "Done well."]));
    const parsed = OwnerEdits.safeParse({ ...EMPTY_EDITS, copy: { serviceDescriptions: thirteen } });
    expect(toIssues(parsed.error!).map((i) => ownerMessage(i).text)).toEqual(["You can describe at most 12 services."]);
  });

  it("covers every issue a bad questionnaire produces with a specific message", () => {
    const parsed = Facts.safeParse({
      businessName: "J", trade: "x", phone: "512", email: "no", location: { city: "", state: "tx", postalCode: "1" },
      serviceArea: { places: [] }, services: [{ name: "", startingPrice: "abc" }],
      hours: [{ days: ["Monday"], opens: "18:00", closes: "08:00" }],
      socialLinks: [{ network: "facebook", url: "https://evil.example/x" }], yearFounded: "ten",
    });
    const issues = toIssues(parsed.error!).map((i) => ({ ...i, path: ["facts", ...i.path] }));
    const texts = issues.map((i) => ownerMessage(i).text);
    expect(texts).not.toContain("Please check this answer.");
    expect(texts).toContain("Enter a 10-digit US phone number, like (512) 555-0142.");
    expect(texts).toContain("Closing time must be after opening time.");
    expect(texts).toContain("Enter a whole number of dollars, like 89, or leave it empty.");
    expect(texts).toContain("Enter the number of whole years you have been in business, like 12.");
  });

  it("maps server codes: attestation, slug and photo references", () => {
    expect(ownerMessage(issue(["brief", "reviewsAreReal"], "attestation_required", "x")).fix?.step).toBe("trust");
    expect(ownerMessage(issue(["slug"], "slug_missing", "x")).fix?.step).toBe("address");
    expect(ownerMessage(issue(["facts", "heroPhoto", "url"], "photo_ref", "x")).text).toBe("Choose this photo again from your uploads.");
  });

  it("gives a message for every issue SiteDocument reports on bad copy", () => {
    const doc = SiteDocument.safeParse({
      facts: { businessName: "Joe", trade: "plumbing", phone: "+15125550142", email: "a@b.co", location: { city: "Austin", state: "TX" }, serviceArea: { places: ["Austin"] }, services: [{ name: "Drains" }] },
      copy: { heroHeadline: "Licensed since 1998 @ joes.com", heroSubheadline: "x".repeat(161), ctaText: "Call", serviceDescriptions: [{ service: "Drains", description: "" }] },
      layout: [{ id: "hero", variant: "centered" }, { id: "services", variant: "cards" }, { id: "serviceArea", variant: "split" }, { id: "contact", variant: "card" }],
      theme: { palette: "navy-orange", font: "clean" },
    });
    for (const i of toIssues(doc.error!)) expect(ownerMessage(i).text).not.toBe("Please check this answer.");
  });
});

// PROPOSED AMENDMENT (approved by web-maker-99, task-12-extra.md): the price and time messages.
describe("starting price messages", () => {
  const priceTexts = (startingPrice: unknown): string[] => {
    const parsed = Facts.safeParse({ ...VALID_FACTS, services: [{ name: "Drains", startingPrice }] });
    return toIssues(parsed.error!).map((i) => ownerMessage({ ...i, path: ["facts", ...i.path] }).text);
  };

  it.each([
    [150_000, "Please enter a price of $100,000 or less."],
    [100_001, "Please enter a price of $100,000 or less."],
    [0, "Please enter a price of at least $1."],
    [89.5, "Please enter whole dollars, no cents."],
    ["abc", "Enter a whole number of dollars, like 89, or leave it empty."],
  ])("%j", (startingPrice, text) => {
    expect(priceTexts(startingPrice)).toEqual([text]);
  });

  it("takes the limits from the issue, not from fixed numbers", () => {
    const at = ["facts", "services", 2, "startingPrice"];
    expect(ownerMessage(issue(at, "too_big", "Too big: expected number to be <=250000")).text).toBe("Please enter a price of $250,000 or less.");
    expect(ownerMessage(issue(at, "too_small", "Too small: expected number to be >=5")).text).toBe("Please enter a price of at least $5.");
  });
});

describe("opening time messages", () => {
  const timeIssues = (hours: unknown): string[][] => {
    const parsed = Facts.safeParse({ ...VALID_FACTS, hours: [hours] });
    return toIssues(parsed.error!).map((i) => [i.path.join("."), i.code, ownerMessage({ ...i, path: ["facts", ...i.path] }).text]);
  };

  it("asks for a time when one is empty, malformed or missing", () => {
    expect(timeIssues({ days: ["Monday"], opens: "", closes: "17:00" })).toEqual([["hours.0.opens", "invalid_format", "Please enter a time."]]);
    expect(timeIssues({ days: ["Monday"], opens: "08:00", closes: "25:00" })).toEqual([["hours.0.closes", "invalid_format", "Please enter a time."]]);
    expect(timeIssues({ days: ["Monday"], closes: "17:00" })).toEqual([["hours.0.opens", "invalid_type", "Please enter a time."]]);
  });

  it("keeps the order message for the order check, which the schema also runs on an empty time (answerIssues drops it then)", () => {
    expect(timeIssues({ days: ["Monday"], opens: "18:00", closes: "08:00" })).toEqual([["hours.0.closes", "custom", "Closing time must be after opening time."]]);
    expect(timeIssues({ days: ["Monday"], opens: "08:00", closes: "" })).toEqual([
      ["hours.0.closes", "invalid_format", "Please enter a time."],
      ["hours.0.closes", "custom", "Closing time must be after opening time."],
    ]);
  });
});

describe("issue filters", () => {
  const issues = [issue(["facts", "services", 0, "name"], "too_small", "m"), issue(["facts", "services"], "too_big", "m"), issue(["facts", "phone"], "invalid_format", "m")];
  it("finds issues at a field or under a list", () => {
    expect(issuesAt(issues, ["facts", "services"])).toHaveLength(1);
    expect(issuesUnder(issues, ["facts", "services"])).toHaveLength(2);
    expect(issuesAt(issues, ["facts", "services", 0, "name"])).toHaveLength(1);
  });
});
