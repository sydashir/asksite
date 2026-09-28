import {
  Copy,
  DESIGN_IDS,
  Facts,
  Layout,
  FONT_IDS,
  NEEDS_A_FACT,
  NEVER_IN_COPY,
  PALETTE_IDS,
  SECTION_VARIANTS,
  ThemeChoice,
  TRADES,
  unbackedClaims,
  type DesignId,
} from "@asksite/site-schema";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { loadFixture } from "../../../fixtures/index.ts";
import {
  AiAnswer,
  AiDraft,
  DESIGN_FOR_TRADE,
  designForTrade,
  draftFromAnswer,
  EMPTY_EDITS,
  GOALS,
  LOOKS,
  OwnerEdits,
  OwnerEditsBody,
  PAGE_DESIGNS,
  PatchDraftBody,
  SECTION_IDS,
  TONES,
} from "../src/index.ts";

const COLOURS = { palette: "navy-orange", font: "clean" } as const;
const { copy, layout } = loadFixture("plumber-austin");
const answer = AiAnswer.parse({ copy, layout, theme: COLOURS });
const issues = (schema: z.ZodType, input: unknown) => {
  const result = schema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.code}: ${i.message}`);
};

describe("page designs (A12)", () => {
  it("names each design for owners, in the order DESIGN_IDS lists them", () => {
    expect(PAGE_DESIGNS).toEqual([
      { id: "impact", name: "Bold" },
      { id: "refined", name: "Classic" },
      { id: "modern", name: "Modern" },
    ]);
    expect(PAGE_DESIGNS.map((d) => d.id)).toEqual(DESIGN_IDS);
  });

  it("names each colour preset by its colours and keeps the preset ids", () => {
    expect(LOOKS).toEqual([
      { id: "classic", name: "Navy & orange", theme: { palette: "navy-orange", font: "clean" } },
      { id: "bright", name: "Blue & yellow", theme: { palette: "blue-yellow", font: "friendly" } },
      { id: "outdoor", name: "Green & amber", theme: { palette: "green-amber", font: "sturdy" } },
      { id: "bold", name: "Charcoal & red", theme: { palette: "charcoal-red", font: "sturdy" } },
    ]);
  });
});

describe("the starting design follows the trade (user decision 2026-09-26)", () => {
  it("maps every trade, and only trades, to its design", () => {
    expect(DESIGN_FOR_TRADE).toEqual({
      plumbing: "impact",
      hvac: "impact",
      electrical: "impact",
      roofing: "refined",
      landscaping: "refined",
      cleaning: "modern",
    });
    expect(Object.keys(DESIGN_FOR_TRADE).sort()).toEqual([...TRADES].sort());
  });

  it.each(TRADES)("designForTrade(%s) is the trade's design", (trade) => {
    expect(designForTrade(trade)).toBe(DESIGN_FOR_TRADE[trade]);
    expect(DESIGN_IDS).toContain(designForTrade(trade));
  });

  it.each(TRADES)("a %s draft is stored with the trade's design, the model's palette and font, and its copy and layout", (trade) => {
    const draft = draftFromAnswer(answer, trade);
    expect(draft).toEqual({ copy: answer.copy, layout: answer.layout, theme: { ...COLOURS, design: DESIGN_FOR_TRADE[trade] } });
    expect(AiDraft.parse(JSON.parse(JSON.stringify(draft)))).toEqual(draft); // it survives storage (output_json) as it is
  });
});

describe("the model answers without a design; a stored draft has one", () => {
  it("AiAnswer takes palette and font only: a design in the answer is refused", () => {
    expect(issues(AiAnswer, { copy, layout, theme: COLOURS })).toEqual([]);
    expect(issues(AiAnswer, { copy, layout, theme: { ...COLOURS, design: "impact" } })).toEqual([
      'theme: unrecognized_keys: Unrecognized key: "design"',
    ]);
    expectTypeOf<AiAnswer["theme"]>().toEqualTypeOf<{ palette: (typeof PALETTE_IDS)[number]; font: (typeof FONT_IDS)[number] }>();
  });

  it("keeps the design off the wire: the answer's JSON schema is byte for byte the pre-A12 draft's", () => {
    // AiDraft before A12 (main d0e1b12): { copy: Copy, layout: Layout, theme: { palette, font } }.
    const preA12Draft = z.strictObject({ copy: Copy, layout: Layout, theme: z.strictObject({ palette: z.enum(PALETTE_IDS), font: z.enum(FONT_IDS) }) });
    const wire = JSON.stringify(z.toJSONSchema(AiAnswer));
    expect(wire).toBe(JSON.stringify(z.toJSONSchema(preA12Draft)));
    expect(wire).not.toContain("design");
    expect(z.toJSONSchema(AiAnswer.shape.theme)).toMatchObject({ required: ["palette", "font"], additionalProperties: false });
  });

  it("AiDraft (stored data) gives a draft stored without a design the default design, and keeps a named one", () => {
    expect(AiDraft.parse({ copy, layout, theme: COLOURS }).theme).toEqual({ ...COLOURS, design: "impact" });
    expect(AiDraft.parse({ copy, layout, theme: { ...COLOURS, design: "modern" } }).theme.design).toBe("modern");
    expect(issues(AiDraft, { copy, layout, theme: { ...COLOURS, design: "brutalist" } })).toEqual([
      'theme.design: invalid_value: Invalid option: expected one of "impact"|"refined"|"modern"',
    ]);
  });
});

describe("owner edits: a request must name the design; stored edits get the default", () => {
  const theme = { ...COLOURS, design: "refined" } as const;

  it("PatchDraftBody refuses a theme without a design at edits.theme.design", () => {
    expect(issues(PatchDraftBody, { rev: 1, edits: { ...EMPTY_EDITS, theme: COLOURS } })).toEqual([
      'edits.theme.design: invalid_value: Invalid option: expected one of "impact"|"refined"|"modern"',
    ]);
  });

  it("PatchDraftBody accepts a theme with a design, and a null theme", () => {
    expect(PatchDraftBody.parse({ rev: 1, edits: { ...EMPTY_EDITS, theme } }).edits?.theme).toEqual(theme);
    expect(PatchDraftBody.parse({ rev: 1, edits: EMPTY_EDITS }).edits?.theme).toBeNull();
  });

  it("OwnerEdits (stored data) fills the default design, and both refuse an unknown one", () => {
    expect(OwnerEdits.parse({ ...EMPTY_EDITS, theme: COLOURS }).theme).toEqual({ ...COLOURS, design: "impact" });
    for (const schema of [OwnerEdits, OwnerEditsBody]) {
      expect(issues(schema, { ...EMPTY_EDITS, theme: { ...COLOURS, design: "brutalist" } })).toEqual([
        'theme.design: invalid_value: Invalid option: expected one of "impact"|"refined"|"modern"',
      ]);
    }
  });

  it("OwnerEditsBody has exactly OwnerEdits' fields and parses to the same type", () => {
    expect(Object.keys(OwnerEditsBody.shape)).toEqual(Object.keys(OwnerEdits.shape));
    expectTypeOf<z.output<typeof OwnerEditsBody>>().toEqualTypeOf<OwnerEdits>();
    expect(OwnerEditsBody.parse(EMPTY_EDITS)).toEqual(OwnerEdits.parse(EMPTY_EDITS));
  });

  it("every colour preset with every design is a valid ThemeChoice", () => {
    for (const look of LOOKS) {
      for (const design of DESIGN_IDS) expect(ThemeChoice.safeParse({ ...look.theme, design }).success).toBe(true);
    }
  });
});

describe("naming rules (A12 §1)", () => {
  const variants = [...new Set(Object.values(SECTION_VARIANTS).flat())];
  const ids: ReadonlyArray<readonly [kind: string, id: string]> = [
    ...DESIGN_IDS.map((id) => ["design id", id] as const),
    ...LOOKS.map((l) => ["LOOKS id", l.id] as const),
    ...PALETTE_IDS.map((id) => ["palette id", id] as const),
    ...FONT_IDS.map((id) => ["font id", id] as const),
    ...TONES.map((id) => ["tone id", id] as const),
    ...GOALS.map((id) => ["goal id", id] as const),
    ...SECTION_IDS.map((id) => ["section id", id] as const),
    ...variants.map((id) => ["variant id", id] as const),
    ...TRADES.map((id) => ["trade id", id] as const),
    ["word", "layout"],
  ];
  // Owner-facing names, each with the id of the thing it names.
  const names: ReadonlyArray<readonly [kind: string, name: string, ownId: string]> = [
    ...PAGE_DESIGNS.map((d) => ["design name", d.name, d.id] as const),
    ...LOOKS.map((l) => ["LOOKS name", l.name, l.id] as const),
  ];

  it("a design id never equals another id or the word layout", () => {
    const designIds: readonly string[] = DESIGN_IDS;
    expect(ids.filter(([kind, id]) => kind !== "design id" && designIds.includes(id.toLowerCase()))).toEqual([]);
    expect(new Set(DESIGN_IDS).size).toBe(DESIGN_IDS.length);
  });

  it("owner-facing names collide with nothing, except the documented overlap with two LOOKS ids", () => {
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    const collisions = names.flatMap(([kind, name, ownId], i) => [
      ...names.filter(([, other], j) => j !== i && same(name, other)).map(([otherKind, other]) => `${kind} "${name}" = ${otherKind} "${other}"`),
      ...ids.filter(([, id]) => id !== ownId && same(name, id)).map(([idKind, id]) => `${kind} "${name}" = ${idKind} "${id}"`),
    ]);
    // Known and documented (A12 §1): LOOKS ids are internal and never shown, so "Bold" and "Classic" only
    // look alike in code. Any new overlap fails here.
    expect(collisions).toEqual(['design name "Bold" = LOOKS id "bold"', 'design name "Classic" = LOOKS id "classic"']);
  });

  it("design ids and names, and the colour names, state no claim", () => {
    const facts = Facts.parse({
      businessName: "Mop",
      trade: "cleaning",
      phone: "+12085550107",
      email: "hi@example.com",
      location: { city: "Boise", state: "ID" },
      serviceArea: { places: ["Boise"] },
      services: [{ name: "House cleaning" }],
    });
    const words = [...DESIGN_IDS, ...PAGE_DESIGNS.map((d) => d.name), ...LOOKS.map((l) => l.name)];
    const patterns = [...NEVER_IN_COPY, ...NEEDS_A_FACT.map((n) => n.pattern)];
    expect(words.flatMap((word) => patterns.filter((p) => p.test(word)).map((p) => `${word}: ${p}`))).toEqual([]);
    expect(words.flatMap((word) => unbackedClaims(word, facts))).toEqual([]);
    expect(unbackedClaims("Bonded", facts)).toEqual(["Bonded"]); // the check can fail
  });

  it("types a design as a DesignId", () => {
    expectTypeOf(designForTrade).returns.toEqualTypeOf<DesignId>();
    expectTypeOf<(typeof PAGE_DESIGNS)[number]["id"]>().toEqualTypeOf<DesignId>();
  });
});
