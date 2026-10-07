import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SiteDocument, Facts } from "@asksite/site-schema";
import { EMPTY_EDITS, OwnerEdits, PatchDraftBody, toIssues, type Issue } from "@asksite/core";
import { describe, expect, it } from "vitest";
import { loadFixture } from "../../../../fixtures/index.ts";
import { editorIssueNotice, issuesAt, issuesToShow, issuesUnder, ownerMessage, type OwnerMessage } from "../../src/client/lib/messages.ts";
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
    expect(m.text).toBe("Please remove “guaranteed”: we cannot show guarantees we cannot check. To say “insured”, check “We are insured”.");
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
  const serviceTexts = (service: object): string[] => {
    const parsed = Facts.safeParse({ ...VALID_FACTS, services: [service] });
    return issuesToShow(toIssues(parsed.error!).map((i) => ({ ...i, path: ["facts", ...i.path] }))).map((i) => ownerMessage(i).text);
  };
  const priceTexts = (startingPrice: unknown): string[] => serviceTexts({ name: "Drains", startingPrice });

  it.each([
    [150_000, "Please enter a price of $100,000 or less."],
    [100_001, "Please enter a price of $100,000 or less."],
    [0, "Please enter a price of at least $1."],
    [89.5, "Please enter whole dollars, no cents."],
    ["abc", "Enter a whole number of dollars, like 89, or leave it empty."],
    // DECIDED (web-maker-d3, review I-2): past 2^53 z.int() adds its own safe-integer limit; only $100,000 shows, once.
    [2 ** 53, "Please enter a price of $100,000 or less."],
    [1e20, "Please enter a price of $100,000 or less."],
    // DECIDED (web-maker-d3, ~07:05): below -2^53 z.int() adds its own safe-integer minimum; only $1 shows, once.
    [-(2 ** 53), "Please enter a price of at least $1."],
    [-1e20, "Please enter a price of at least $1."],
  ])("%j", (startingPrice, text) => {
    expect(priceTexts(startingPrice)).toEqual([text]);
  });

  it("keeps each field's own tightest limit, not one limit across fields", () => {
    expect(serviceTexts({ name: "x".repeat(41), startingPrice: 150_000 })).toEqual([
      "Please use 40 characters or fewer.",
      "Please enter a price of $100,000 or less.",
    ]);
  });

  it("takes the limits from the issue, not from fixed numbers", () => {
    const at = ["facts", "services", 2, "startingPrice"];
    expect(ownerMessage(issue(at, "too_big", "Too big: expected number to be <=250000")).text).toBe("Please enter a price of $250,000 or less.");
    expect(ownerMessage(issue(at, "too_small", "Too small: expected number to be >=5")).text).toBe("Please enter a price of at least $5.");
  });
});

// DECIDED (web-maker-d3, ~07:05): a number's too_big or too_small issue gets number wording, never a character count.
describe("number limit messages", () => {
  const photo = (size: object): object => ({ url: "https://media.example/p.jpg", alt: "A new water heater", width: 800, height: 600, ...size });
  const factsTexts = (facts: object): string[][] => {
    const parsed = Facts.safeParse({ ...VALID_FACTS, ...facts });
    const issues = toIssues(parsed.error!).map((i) => ({ ...i, path: ["facts", ...i.path] }));
    return issuesToShow(issues).map((i) => [i.path.join("."), ownerMessage(i).text]);
  };

  it.each([
    [{ yearFounded: 2101 }, "facts.yearFounded", "Please enter a year of 2100 or earlier."],
    [{ yearFounded: 1e20 }, "facts.yearFounded", "Please enter a year of 2100 or earlier."],
    [{ yearFounded: 1849 }, "facts.yearFounded", "Please enter a year of 1850 or later."],
    [{ heroPhoto: photo({ width: 10_001 }) }, "facts.heroPhoto.width", "Please enter a number of 10,000 or less."],
    [{ photos: [photo({ height: 1e20 })] }, "facts.photos.0.height", "Please enter a number of 10,000 or less."],
    [{ heroPhoto: photo({ width: 0 }) }, "facts.heroPhoto.width", "Please enter a number of 1 or more."],
    // Below -2^53 z.int()'s own minimum joins the field's; only the tightest too_small shows (DECIDED ~07:05).
    [{ yearFounded: -1e20 }, "facts.yearFounded", "Please enter a year of 1850 or later."],
    [{ heroPhoto: photo({ width: -1e20 }) }, "facts.heroPhoto.width", "Please enter a number of 1 or more."],
  ])("%j", (facts, path, text) => {
    expect(factsTexts(facts)).toEqual([[path, text]]);
  });

  it("takes the limits from the issue, not from fixed numbers", () => {
    const year = ["facts", "yearFounded"];
    const height = ["facts", "photos", 3, "height"];
    expect(ownerMessage(issue(year, "too_big", "Too big: expected number to be <=2200")).text).toBe("Please enter a year of 2200 or earlier.");
    expect(ownerMessage(issue(year, "too_small", "Too small: expected number to be >=1900")).text).toBe("Please enter a year of 1900 or later.");
    expect(ownerMessage(issue(height, "too_big", "Too big: expected number to be <=12000")).text).toBe("Please enter a number of 12,000 or less.");
    expect(ownerMessage(issue(height, "too_small", "Too small: expected number to be >=5")).text).toBe("Please enter a number of 5 or more.");
  });
});

describe("opening time messages", () => {
  const timeIssues = (hours: unknown): string[][] => {
    const parsed = Facts.safeParse({ ...VALID_FACTS, hours: [hours] });
    const issues = toIssues(parsed.error!).map((i) => ({ ...i, path: ["facts", ...i.path] }));
    return issuesToShow(issues).map((i) => [i.path.join("."), i.code, ownerMessage(i).text]);
  };

  it("asks for a time when one is empty, malformed or missing", () => {
    expect(timeIssues({ days: ["Monday"], opens: "", closes: "17:00" })).toEqual([["facts.hours.0.opens", "invalid_format", "Please enter a time."]]);
    expect(timeIssues({ days: ["Monday"], opens: "08:00", closes: "25:00" })).toEqual([["facts.hours.0.closes", "invalid_format", "Please enter a time."]]);
    expect(timeIssues({ days: ["Monday"], closes: "17:00" })).toEqual([["facts.hours.0.opens", "invalid_type", "Please enter a time."]]);
  });

  it("says the order is wrong only for two valid times in the wrong order, never also for an empty time", () => {
    expect(timeIssues({ days: ["Monday"], opens: "18:00", closes: "08:00" })).toEqual([["facts.hours.0.closes", "custom", "Closing time must be after opening time."]]);
    expect(timeIssues({ days: ["Monday"], opens: "08:00", closes: "" })).toEqual([["facts.hours.0.closes", "invalid_format", "Please enter a time."]]);
  });
});

// DECIDED (web-maker-d3, review I-1): one list-level helper for every issue list that is shown or counted,
// including the server's lists (the publish page) and the editor's preview list, not only answerIssues.
describe("issuesToShow on a real SiteDocument list", () => {
  const fixture = loadFixture("plumber-austin");
  const documentIssues = (facts: object): Issue[] => {
    const parsed = SiteDocument.safeParse({ ...fixture, facts: { ...fixture.facts, ...facts } });
    return toIssues(parsed.error!);
  };
  const closes = ["facts", "hours", 0, "closes"];

  it("gives exactly one issue, and one message, for an empty closing time", () => {
    const issues = documentIssues({ hours: [{ days: ["Monday"], opens: "08:00", closes: "" }] });
    expect(issuesAt(issues, closes).map((i) => i.code)).toEqual(["invalid_format", "custom"]);
    const shown = issuesToShow(issues);
    expect(shown.map((i) => [i.path.join("."), ownerMessage(i).text])).toEqual([["facts.hours.0.closes", "Please enter a time."]]);
  });

  it("gives exactly one issue, the $100,000 one, for a price past the safe-integer range (review I-2)", () => {
    const [first, ...rest] = fixture.facts.services;
    const issues = documentIssues({ services: [{ ...first, startingPrice: 2 ** 53 }, ...rest] });
    const price = ["facts", "services", 0, "startingPrice"];
    expect(issuesAt(issues, price).map((i) => i.code)).toEqual(["too_big", "too_big"]);
    expect(issuesToShow(issues).map((i) => [i.path.join("."), ownerMessage(i).text])).toEqual([
      ["facts.services.0.startingPrice", "Please enter a price of $100,000 or less."],
    ]);
  });

  it("gives exactly one issue, the $1 one, for a price below the safe-integer range (DECIDED ~07:05)", () => {
    const [first, ...rest] = fixture.facts.services;
    const issues = documentIssues({ services: [{ ...first, startingPrice: -1e20 }, ...rest] });
    const price = ["facts", "services", 0, "startingPrice"];
    expect(issuesAt(issues, price).map((i) => i.code)).toEqual(["too_small", "too_small"]);
    expect(issuesToShow(issues).map((i) => [i.path.join("."), ownerMessage(i).text])).toEqual([
      ["facts.services.0.startingPrice", "Please enter a price of at least $1."],
    ]);
  });

  it("keeps the tightest limit of each kind at a field, and every limit it cannot read", () => {
    const at = ["facts", "services", 0, "startingPrice"];
    const least5 = issue(at, "too_small", "Too small: expected number to be >=5");
    const above0 = issue(at, "too_small", "Too small: expected number to be >0");
    const most80 = issue(at, "too_big", "Too big: expected number to be <=80");
    const list = [issue(at, "too_small", "Too small: expected number to be >=-3"), least5, above0, most80, issue(at, "too_big", "Too big: expected number to be <=90")];
    expect(issuesToShow(list)).toEqual([least5, above0, most80]);
  });

  it("keeps the order check for two valid times in the wrong order", () => {
    const issues = documentIssues({ hours: [{ days: ["Monday"], opens: "18:00", closes: "08:00" }] });
    expect(issuesToShow(issues).map((i) => [i.path.join("."), ownerMessage(i).text])).toEqual([
      ["facts.hours.0.closes", "Closing time must be after opening time."],
    ]);
  });

  it("leaves a valid document's list and other issues alone", () => {
    expect(SiteDocument.safeParse(fixture).success).toBe(true);
    const other = [issue(["facts", "phone"], "invalid_format", "m"), issue(["copy", "heroHeadline"], "too_big", "Too big: expected string to have <=80 characters")];
    expect(issuesToShow(other)).toEqual(other);
  });

  it("drops only what it knows is false: not a too_small next to a too_big, not a custom issue at an opening time", () => {
    const name = ["facts", "businessName"];
    const opens = ["facts", "hours", 0, "opens"];
    const other = [
      issue(name, "too_small", "Too small: expected string to have >=2 characters"),
      issue(name, "too_big", "Too big: expected string to have <=80 characters"),
      issue(opens, "invalid_format", "Time must be HH:MM (24-hour)"),
      issue(opens, "custom", "m"),
    ];
    expect(issuesToShow(other)).toEqual(other);
  });
});

// DECIDED (web-maker-d3, 2026-09-30; A12): every issue at or below `theme` or `edits.theme` gets one message, in US
// spelling (us-spelling.md), with no questionnaire fix: the editor's goToIssue sends it to the Look tab (Task 17).
describe("theme messages (A12)", () => {
  const THEME_MESSAGE: OwnerMessage = { text: "Choose your page design and colors again." };
  const shown = (issues: Issue[]): Array<[string, string, OwnerMessage]> => issues.map((i) => [i.path.join("."), i.code, ownerMessage(i)]);
  const saved = (theme: unknown): Issue[] => toIssues(PatchDraftBody.safeParse({ rev: 1, edits: { ...EMPTY_EDITS, theme } }).error!);
  const stored = (theme: unknown): Issue[] => toIssues(OwnerEdits.safeParse({ ...EMPTY_EDITS, theme }).error!);

  it.each([
    ["a saved theme without a design", () => saved({ palette: "navy-orange", font: "clean" }), "edits.theme.design", "invalid_value"],
    ["a saved theme with an unknown palette", () => saved({ palette: "pink", font: "clean", design: "impact" }), "edits.theme.palette", "invalid_value"],
    ["a saved theme that is not an object", () => saved("x"), "edits.theme", "invalid_type"],
    ["a stored theme with an unknown palette", () => stored({ palette: "pink", font: "clean" }), "theme.palette", "invalid_value"],
    ["a stored theme that is not an object", () => stored("x"), "theme", "invalid_type"],
  ])("%s", (_, issues, path, code) => {
    expect(shown(issues())).toStrictEqual([[path, code, THEME_MESSAGE]]);
  });

  it("keeps every other path's own message, under edits too", () => {
    expect(ownerMessage(issue(["edits", "copy", "heroHeadline"], "too_big", "Too big: expected string to have <=80 characters")).text).toBe("Please use 80 characters or fewer.");
    expect(ownerMessage(issue(["edits", "order"], "invalid_value", "m")).text).toBe("Please choose one.");
    expect(ownerMessage(issue(["facts", "trade"], "invalid_value", "m")).text).toBe("Choose the kind of work you do.");
  });
});

// DECIDED (web-maker-d3): US usage in owner text. The owner checks a box; British "tick" must not come back.
describe("US wording", () => {
  const TICK = /\b(un)?tick(ed|ing|s)?\b/i;

  it("asks the owner to check a box, not to tick it", () => {
    expect(ownerMessage(issue(["brief", "reviewsAreReal"], "attestation_required", "x")).text).toBe("Check the box to confirm these reviews are from real customers.");
    expect(ownerMessage(issue(["copy", "about"], "custom", 'Copy states something the owner\'s facts do not back: "insured"')).text).toBe("To say “insured”, check “We are insured”.");
  });

  it("no client source file says “tick”, so a new one fails here", () => {
    const root = new URL("../../src/client/", import.meta.url).pathname;
    const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((name) => /\.tsx?$/.test(name));
    expect(files).toContain("lib/messages.ts");
    expect(files).toContain("App.tsx");
    expect(files.filter((name) => TICK.test(readFileSync(join(root, name), "utf8")))).toEqual([]);
  });

  it("the check itself catches the word and nothing else", () => {
    for (const text of ["Tick the box", "tick “We are insured”", "Leave it unticked", "ticked"]) expect(TICK.test(text)).toBe(true);
    for (const text of ["ticket", "sticker", "Check the box"]) expect(TICK.test(text)).toBe(false);
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

// Handoff 1b (DECIDED web-maker-d5, 2026-10-07): the Worker words an AI-claim issue for the owner (the claim words of that field,
// from aiClaims); the app shows that line as it is. The model-repair message is never shown or parsed.
describe("AI-claim issues (handoff 1b)", () => {
  const LINE = "“free” isn't backed by your answers. Edit this wording or update your answers.";

  it("shows the server's line as it is, with no fix button: the owner edits the wording or changes an answer", () => {
    expect(ownerMessage(issue(["copy", "heroSubheadline"], "ai_claim", LINE))).toEqual({ text: LINE });
    expect(ownerMessage(issue(["copy", "faq", 0, "answer"], "ai_claim", "“after-hours”, “free” isn't backed by your answers. Edit this wording or update your answers."))).toEqual({
      text: "“after-hours”, “free” isn't backed by your answers. Edit this wording or update your answers.",
    });
  });

  it("never reads an AI-claim issue as a SiteDocument claim, whatever its message says", () => {
    const repairText = 'Copy states something the owner\'s facts do not back: "free"';
    expect(ownerMessage(issue(["copy", "about"], "ai_claim", repairText))).toEqual({ text: repairText });
  });
});

// DECIDED (web-maker-d5, 2026-10-07, Q1 option (c)): the editor's one issue notice. Issues that stop the preview keep today's
// sentence, counting only them; AI-claim issues (the preview still updates) say what they block.
describe("editorIssueNotice", () => {
  it("blocking only: today's sentence with the blocking count", () => {
    expect(editorIssueNotice(1, 0)).toBe("Fix 1 issue to update the preview.");
    expect(editorIssueNotice(3, 0)).toBe("Fix 3 issues to update the preview.");
  });

  it("AI-claim issues only: they block publishing, not the preview", () => {
    expect(editorIssueNotice(0, 1)).toBe("Fix 1 issue before you publish.");
    expect(editorIssueNotice(0, 2)).toBe("Fix 2 issues before you publish.");
  });

  it("mixed: the blocking sentence with the blocking count only", () => {
    expect(editorIssueNotice(1, 2)).toBe("Fix 1 issue to update the preview.");
    expect(editorIssueNotice(2, 1)).toBe("Fix 2 issues to update the preview.");
  });

  it("none: no notice", () => {
    expect(editorIssueNotice(0, 0)).toBeNull();
  });
});
