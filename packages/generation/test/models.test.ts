import { Brief, GOALS, TONES, type GenerationInputSnapshot, type Issue } from "@asksite/core";
import { DAYS, Facts, SOCIAL_HOSTS, SOCIAL_NETWORKS, TRADES } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { CAPS_FILLS, CAPS_REPAIR, CAPS_SNAPSHOT, capsRepair, capsSnapshot } from "../eval/caps.ts";
import { MAX_ATTEMPTS, MAX_OUTPUT_TOKENS } from "../src/generate.ts";
import { MODEL_TEXT_CAPS } from "../src/model-facts.ts";
import { costMicrousd, MAX_INPUT_TOKENS, MODELS, modelSettings, PROMPT_OVERHEAD_TOKENS, worstCaseAttemptMicrousd, worstCaseJobMicrousd } from "../src/models.ts";
import { buildPrompt } from "../src/prompt.ts";
import { templateAnswer } from "../src/template.ts";
import { checkDraft } from "../src/validate.ts";
import { AI_DRAFT_JSON_SCHEMA, toWireSchema } from "../src/wire-schema.ts";
import { BRIEF, FULL_FACTS } from "./support/samples.ts";

const bytes = (s: string) => new TextEncoder().encode(s).length;
const SCHEMA_BYTES = bytes(JSON.stringify(toWireSchema(AI_DRAFT_JSON_SCHEMA)));

/** UTF-8 bytes of one attempt's input: the system prompt, the user prompt and the wire schema. */
const promptBytes = (snapshot: GenerationInputSnapshot, repair: readonly Issue[]): number => {
  const { system, user } = buildPrompt(snapshot, repair);
  return bytes(system) + bytes(user) + SCHEMA_BYTES;
};

/** Both halves pass their real schemas. */
const parses = (snapshot: GenerationInputSnapshot): boolean => Facts.safeParse(snapshot.facts).success && Brief.safeParse(snapshot.brief).success;

/**
 * The on/off builder choices. heroPhoto does not change the prompt today; it is here so a future change is caught.
 * The fields in UNREAD are left out because the prompt does not read them; a test below proves it.
 */
const TOGGLES = ["yearFounded", "licences", "insured", "emergency247", "freeEstimates", "testimonials", "photos", "heroPhoto"] as const;
type Toggle = (typeof TOGGLES)[number];
const PHOTO = { url: "https://media.example.com/a/p.webp", alt: "a", width: 1, height: 1 };

/** CAPS_SNAPSHOT's capped strings with one combination of builder choices. */
function withChoices(trade: Facts["trade"], tone: Brief["tone"], goal: Brief["goal"], on: (toggle: Toggle) => boolean): GenerationInputSnapshot {
  const { yearFounded: _year, heroPhoto: _hero, ...facts } = CAPS_SNAPSHOT.facts;
  return {
    facts: {
      ...facts,
      trade,
      licences: on("licences") ? [{ label: "L", number: "1" }] : [],
      insured: on("insured"),
      emergency247: on("emergency247"),
      freeEstimates: on("freeEstimates"),
      testimonials: on("testimonials") ? [{ quote: "q", name: "n" }] : [],
      photos: on("photos") ? [PHOTO] : [],
      ...(on("yearFounded") ? { yearFounded: 1998 } : {}),
      ...(on("heroPhoto") ? { heroPhoto: PHOTO } : {}),
    },
    brief: { ...CAPS_SNAPSHOT.brief, tone, goal },
  };
}

/**
 * Facts and Brief fields the prompt does not read today, each set to its fullest value (CAPS_SNAPSHOT leaves
 * every one unset, at its default or short). If the prompt starts reading one, the guard test fails. A private
 * fact (design 6.1) must never reach the prompt; any other field must join TOGGLES, so the enumeration covers it.
 */
type SetField = (snapshot: GenerationInputSnapshot) => GenerationInputSnapshot;
const setFacts =
  (patch: (facts: Facts) => Partial<Facts>): SetField =>
  ({ facts, brief }) => ({ facts: { ...facts, ...patch(facts) }, brief });
/** `count` items, repeating `items` in turn. */
const repeatTo = <T>(items: readonly T[], count: number): T[] => Array.from({ length: count }, (_, i) => items[i % items.length]!);
const URL_AT_CAP = `https://media.example.com/${"u".repeat(2048 - 26)}`;
const PHOTO_AT_CAPS = { url: URL_AT_CAP, alt: "a".repeat(125), width: 10_000, height: 10_000, caption: "c".repeat(80) };
const UNREAD: Array<[string, SetField]> = [
  ["hours", ({ facts, brief }) => ({ facts: { ...facts, hours: DAYS.map((day) => ({ days: [day], opens: "00:00", closes: "23:59" })) }, brief })],
  ["socialLinks", ({ facts, brief }) => ({ facts: { ...facts, socialLinks: SOCIAL_NETWORKS.map((network) => ({ network, url: `https://${SOCIAL_HOSTS[network][0]!}/a` })) }, brief })],
  ["serviceArea.note", ({ facts, brief }) => ({ facts: { ...facts, serviceArea: { ...facts.serviceArea, note: "n".repeat(80) } }, brief })],
  ["location.streetAddress", ({ facts, brief }) => ({ facts: { ...facts, location: { ...facts.location, streetAddress: "s".repeat(80) } }, brief })],
  ["location.postalCode", ({ facts, brief }) => ({ facts: { ...facts, location: { ...facts.location, postalCode: "78701" } }, brief })],
  ["reviewsAreReal", ({ facts, brief }) => ({ facts, brief: { ...brief, reviewsAreReal: true } })],
  ["phone", setFacts(() => ({ phone: "+19999999999" }))],
  ["email", setFacts(() => ({ email: `${"e".repeat(242)}@example.com` }))],
  ["services[].startingPrice", setFacts(({ services }) => ({ services: services.map((s) => ({ ...s, startingPrice: 100_000 })) }))],
  ["licences[].label", setFacts(({ licences }) => ({ licences: licences.map((l) => ({ ...l, label: "l".repeat(40) })) }))],
  ["licences[].number", setFacts(({ licences }) => ({ licences: licences.map((l) => ({ ...l, number: "n".repeat(30) })) }))],
  ["5 licences", setFacts(({ licences }) => ({ licences: repeatTo(licences, 5) }))],
  ["testimonials[].quote", setFacts(({ testimonials }) => ({ testimonials: testimonials.map((t) => ({ ...t, quote: "q".repeat(320) })) }))],
  ["testimonials[].name", setFacts(({ testimonials }) => ({ testimonials: testimonials.map((t) => ({ ...t, name: "n".repeat(40) })) }))],
  ["testimonials[].location", setFacts(({ testimonials }) => ({ testimonials: testimonials.map((t) => ({ ...t, location: "l".repeat(40) })) }))],
  ["12 testimonials", setFacts(({ testimonials }) => ({ testimonials: repeatTo(testimonials, 12) }))],
  ["photos[].url", setFacts(({ photos }) => ({ photos: photos.map((p) => ({ ...p, url: URL_AT_CAP })) }))],
  ["photos[].alt", setFacts(({ photos }) => ({ photos: photos.map((p) => ({ ...p, alt: PHOTO_AT_CAPS.alt })) }))],
  ["photos[].caption", setFacts(({ photos }) => ({ photos: photos.map((p) => ({ ...p, caption: PHOTO_AT_CAPS.caption })) }))],
  ["photos[].width and height", setFacts(({ photos }) => ({ photos: photos.map((p) => ({ ...p, width: 10_000, height: 10_000 })) }))],
  ["12 photos", setFacts(({ photos }) => ({ photos: repeatTo(photos, 12) }))],
  ["heroPhoto, every field at its cap (its presence is not read either; see TOGGLES)", setFacts(() => ({ heroPhoto: PHOTO_AT_CAPS }))],
];

/** Copies the capped strings of one field group from `from` into `into`; every other field keeps `into`'s. */
type Take = (into: GenerationInputSnapshot, from: GenerationInputSnapshot) => GenerationInputSnapshot;
const FIELD_GROUPS: ReadonlyArray<readonly [string, Take]> = [
  ["businessName", (into, from) => ({ ...into, facts: { ...into.facts, businessName: from.facts.businessName } })],
  ["city", (into, from) => ({ ...into, facts: { ...into.facts, location: { ...into.facts.location, city: from.facts.location.city } } })],
  ["service-area places", (into, from) => ({ ...into, facts: { ...into.facts, serviceArea: { ...into.facts.serviceArea, places: from.facts.serviceArea.places } } })],
  ["service names", (into, from) => ({ ...into, facts: { ...into.facts, services: from.facts.services } })],
  ["differentiator", (into, from) => ({ ...into, brief: { ...into.brief, differentiator: from.brief.differentiator ?? "" } })],
  ["notes", (into, from) => ({ ...into, brief: { ...into.brief, notes: from.brief.notes ?? "" } })],
  ["comments", (into, from) => ({ ...into, brief: { ...into.brief, comments: from.brief.comments } })],
];

describe("MAX_INPUT_TOKENS", () => {
  it.each(CAPS_FILLS)("covers the largest prompt the builder can make with every capped input filled with %j (a token is at least one UTF-8 byte)", (fill) => {
    expect(promptBytes(capsSnapshot(fill), capsRepair(fill)) + PROMPT_OVERHEAD_TOKENS).toBeLessThanOrEqual(MAX_INPUT_TOKENS);
  });

  it("covers CAPS_SNAPSHOT, the largest prompt: owner text in euro signs, service names (never cut) in U+1F600, repair lines in euro signs", () => {
    expect(promptBytes(CAPS_SNAPSHOT, CAPS_REPAIR) + PROMPT_OVERHEAD_TOKENS).toBeLessThanOrEqual(MAX_INPUT_TOKENS);
  });

  it("is sized by CAPS_SNAPSHOT and CAPS_REPAIR: no fill makes a larger prompt, in every field, in any one field group or in the repair lines", () => {
    // The fields are separate JSON strings, so the largest prompt takes the costliest fill of each field group on its own.
    const worst = promptBytes(CAPS_SNAPSHOT, CAPS_REPAIR);
    const larger: string[] = [];
    for (const fill of CAPS_FILLS) {
      const from = capsSnapshot(fill);
      const sizes: Array<readonly [string, number]> = [
        ["every field and the repair lines", promptBytes(from, capsRepair(fill))],
        ...FIELD_GROUPS.map(([group, take]) => [group, promptBytes(take(CAPS_SNAPSHOT, from), CAPS_REPAIR)] as const),
        ["the repair lines", promptBytes(CAPS_SNAPSHOT, capsRepair(fill))],
      ];
      for (const [where, size] of sizes) if (size > worst) larger.push(`${where} in ${JSON.stringify(fill)}: ${size} > ${worst}`);
    }
    expect(larger).toEqual([]);
  });

  it(
    "no builder choice makes a larger prompt than CAPS_SNAPSHOT (every trade, tone and goal, each on/off choice)",
    () => {
      let largest = { bytes: 0, choice: "" };
      for (const trade of TRADES)
        for (const tone of TONES)
          for (const goal of GOALS)
            for (let mask = 0; mask < 2 ** TOGGLES.length; mask++) {
              const on = (toggle: Toggle): boolean => (mask & (1 << TOGGLES.indexOf(toggle))) !== 0;
              const size = promptBytes(withChoices(trade, tone, goal, on), CAPS_REPAIR);
              if (size > largest.bytes) largest = { bytes: size, choice: JSON.stringify({ trade, tone, goal, on: TOGGLES.filter((toggle) => on(toggle)) }) };
            }
      expect(largest.bytes, largest.choice).toBeLessThanOrEqual(promptBytes(CAPS_SNAPSHOT, CAPS_REPAIR));
    },
    60_000,
  );

  it.each(UNREAD)("does not read %s, so TOGGLES can leave it out: setting it leaves the prompt byte for byte the same", (_field, set) => {
    const on = set(CAPS_SNAPSHOT);
    expect(parses(on)).toBe(true);
    expect(on).not.toEqual(CAPS_SNAPSHOT);
    expect(buildPrompt(on, CAPS_REPAIR)).toEqual(buildPrompt(CAPS_SNAPSHOT, CAPS_REPAIR));
  });

  it("does not read those fields together either: setting them all leaves the prompt byte for byte the same", () => {
    const on = UNREAD.reduce((snapshot, [, set]) => set(snapshot), CAPS_SNAPSHOT);
    expect(parses(on)).toBe(true);
    expect(buildPrompt(on, CAPS_REPAIR)).toEqual(buildPrompt(CAPS_SNAPSHOT, CAPS_REPAIR));
  });
});

describe("the whole prompt (design 6.1)", () => {
  /** FULL_FACTS with every value the model must never see made distinctive, so no other prompt text can hold it by chance. */
  const PRIVATE_FACTS = Facts.parse({
    ...FULL_FACTS,
    phone: "+17135550187",
    email: "zq-owner-mailbox@private-mail.example",
    location: { ...FULL_FACTS.location, streetAddress: "4417 Zqhollow Lane", postalCode: "73301" },
    serviceArea: { ...FULL_FACTS.serviceArea, note: "Zq note: past the old mill road" },
    hours: [{ days: ["Monday"], opens: "06:47", closes: "19:13" }],
    services: [
      { name: "Drain cleaning", startingPrice: 4321 },
      { name: "Leak repair", startingPrice: 8765 },
    ],
    licences: [{ label: "Zq plumbing board", number: "ZQ-LIC-90417" }],
    yearFounded: 1873,
    testimonials: [{ quote: "Zq quote: best pipe work on the block", name: "Zqelda Marsh", location: "Zqville, TX" }],
    heroPhoto: { url: "https://media.example.com/zq/hero-5512.webp", alt: "Zq hero alt text", width: 1600, height: 900, caption: "Zq hero caption" },
    photos: [{ url: "https://media.example.com/zq/photo-6623.webp", alt: "Zq photo alt text", width: 1200, height: 900, caption: "Zq photo caption" }],
    socialLinks: [{ network: "facebook", url: "https://www.facebook.com/zq-private-page" }],
  });
  const { phone, email, location, serviceArea, hours, services, licences, testimonials, heroPhoto, photos, socialLinks } = PRIVATE_FACTS;
  const PRIVATE: Array<[string, string]> = [
    ["phone", phone],
    ["phone digits", phone.slice(2)],
    ["phone as the page shows it", "(713) 555-0187"],
    ["email", email],
    ["street", location.streetAddress!],
    ["ZIP", location.postalCode!],
    ["ZIP given as a service-area place", serviceArea.places.find((place) => /\d/.test(place))!],
    ["area note", serviceArea.note!],
    ["opening time", hours[0]!.opens],
    ["closing time", hours[0]!.closes],
    ...services.map((s): [string, string] => ["starting price", String(s.startingPrice)]),
    ["licence label", licences[0]!.label],
    ["licence number", licences[0]!.number],
    ["founding year", String(PRIVATE_FACTS.yearFounded)],
    ["review quote", testimonials[0]!.quote],
    ["reviewer name", testimonials[0]!.name],
    ["reviewer location", testimonials[0]!.location!],
    ["hero photo URL", heroPhoto!.url],
    ["hero photo alt text", heroPhoto!.alt],
    ["hero photo caption", heroPhoto!.caption!],
    ["photo URL", photos[0]!.url],
    ["photo alt text", photos[0]!.alt],
    ["photo caption", photos[0]!.caption!],
    ["social URL", socialLinks[0]!.url],
  ];

  /** Real validator issues: the model's answer swapped the service descriptions and left out the owner-fact sections. */
  const REPAIR = ((): Issue[] => {
    const answer = templateAnswer(PRIVATE_FACTS, BRIEF);
    const check = checkDraft(PRIVATE_FACTS, { ...answer, copy: { ...answer.copy, serviceDescriptions: [...answer.copy.serviceDescriptions].reverse() }, layout: answer.layout.slice(0, 1) });
    if (check.ok) throw new Error("REPAIR needs an answer the validator rejects");
    return check.issues;
  })();

  it.each<[string, Issue[]]>([
    ["first attempt", []],
    ["with repair lines", REPAIR],
  ])("never holds a private owner fact, in the system or the user prompt (%s)", (_attempt, repair) => {
    const { system, user } = buildPrompt({ facts: PRIVATE_FACTS, brief: BRIEF }, repair);
    expect(user).toContain(JSON.stringify(PRIVATE_FACTS.businessName));
    expect(user.includes("Your previous answer was rejected")).toBe(repair.length > 0);
    expect(PRIVATE.filter(([, value]) => `${system}\n${user}`.includes(value))).toEqual([]);
  });
});

describe("eval/caps.ts", () => {
  const { facts, brief } = CAPS_SNAPSHOT;
  /** Length as Facts and Brief count it: in code points (Zod 4 string length). */
  const size = (text: string): number => [...text].length;
  /** One code point longer: one more of its last character. */
  const grow = (text: string): string => text + ([...text].at(-1) ?? "");
  const withFacts = (patch: Partial<Facts>): GenerationInputSnapshot => ({ facts: { ...facts, ...patch }, brief });
  const withBrief = (patch: Partial<Brief>): GenerationInputSnapshot => ({ facts, brief: { ...brief, ...patch } });
  const changeAt = <T>(items: readonly T[], index: number, change: (item: T) => T): T[] => items.map((item, i) => (i === index ? change(item) : item));
  const shortest = (texts: readonly string[]): number => Math.min(...texts.map(size));
  const { places } = facts.serviceArea;
  const { services } = facts;
  const comments = Object.entries(brief.comments);

  // [capped input, its size in CAPS_SNAPSHOT, snapshots with one input (or one item of it) one unit or one item over]
  const CAPPED: Array<[string, number, GenerationInputSnapshot[]]> = [
    ["businessName", size(facts.businessName), [withFacts({ businessName: grow(facts.businessName) })]],
    ["city", size(facts.location.city), [withFacts({ location: { ...facts.location, city: grow(facts.location.city) } })]],
    ["each service-area place", shortest(places), places.map((_, i) => withFacts({ serviceArea: { ...facts.serviceArea, places: changeAt(places, i, grow) } }))],
    ["the number of places", places.length, [withFacts({ serviceArea: { ...facts.serviceArea, places: [...places, ...places.slice(0, 1)] } })]],
    ["each service name", shortest(services.map((s) => s.name)), services.map((_, i) => withFacts({ services: changeAt(services, i, (s) => ({ ...s, name: grow(s.name) })) }))],
    ["the number of services", services.length, [withFacts({ services: [...services, ...services.slice(0, 1)] })]],
    ["differentiator", size(brief.differentiator ?? ""), [withBrief({ differentiator: grow(brief.differentiator ?? "") })]],
    ["notes", size(brief.notes ?? ""), [withBrief({ notes: grow(brief.notes ?? "") })]],
    ["each comment", shortest(comments.map(([, text]) => text)), comments.map(([key, text]) => withBrief({ comments: { ...brief.comments, [key]: grow(text) } }))],
    ["the number of comments", comments.length, [withBrief({ comments: { ...brief.comments, z: "" } })]],
    ["each comment key", shortest(comments.map(([key]) => key)), comments.map((_, i) => withBrief({ comments: Object.fromEntries(changeAt(comments, i, ([key, text]) => [`${key}x`, text])) }))],
  ];

  it.each(CAPPED)("holds %s exactly at its schema's cap (%i): CAPS_SNAPSHOT passes Facts and Brief, one more fails", (_input, _cap, overCap) => {
    expect(parses(CAPS_SNAPSHOT)).toBe(true);
    expect(overCap.map((snapshot) => parses(snapshot))).toEqual(overCap.map(() => false));
  });

  it("holds MODEL_TEXT_CAPS, where the prompt cuts the model's view of owner text, at the sizes pinned above", () => {
    expect(MODEL_TEXT_CAPS).toEqual({
      businessName: size(facts.businessName),
      city: size(facts.location.city),
      place: shortest(places),
      differentiator: size(brief.differentiator ?? ""),
      notes: size(brief.notes ?? ""),
      comment: shortest(comments.map(([, text]) => text)),
    });
  });

  /** The decoded path and message of each repair line, `- "<path>": "<message>"` (two JSON strings). */
  const repairParts = (issues: readonly Issue[]): Array<[string, string]> =>
    buildPrompt(CAPS_SNAPSHOT, issues)
      .user.split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => {
        const parts = /^- ("(?:[^"\\]|\\.)*"): ("(?:[^"\\]|\\.)*")$/.exec(line);
        if (parts === null) throw new Error(`Not a repair line: ${line}`);
        return [JSON.parse(parts[1]!) as string, JSON.parse(parts[2]!) as string];
      });

  it("holds every CAPS_REPAIR issue at the repair caps: a 70-unit path keeps 60, a 250-unit message keeps 200, 25 issues keep 20", () => {
    const kept = repairParts(Array.from({ length: 25 }, () => ({ path: ["p".repeat(70)], code: "custom", message: "m".repeat(250) })));
    const sizes = kept.map(([path, message]) => [path.length, message.length]);
    expect(sizes).toEqual(Array.from({ length: 20 }, () => [60, 200]));
    expect(CAPS_REPAIR.map((issue) => [issue.path.join(".").length, issue.message.length])).toEqual(sizes);
  });
});

describe("MODELS", () => {
  it("records a source page and a check date for every price", () => {
    for (const [key, { price }] of Object.entries(MODELS)) {
      expect(key).toMatch(/^(anthropic|openai-compatible|fake):/);
      expect(price.source === "none" || price.source.startsWith("https://")).toBe(true);
      expect(price.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("finds settings by provider and model id", () => {
    expect(modelSettings("anthropic", "claude-opus-5-5")?.price.inputMicrousdPerToken).toBe(4);
    expect(modelSettings("anthropic", "gpt-oss")).toBeUndefined();
    expect(modelSettings("anthropic", "constructor")).toBeUndefined();
  });

  it("never gives a model extra fields that would replace one the OpenAI-compatible adapter sets", () => {
    for (const { extraBody } of Object.values(MODELS))
      for (const key of Object.keys(extraBody ?? {}))
        expect(["model", "messages", "max_tokens", "max_completion_tokens", "n", "response_format", "stream"]).not.toContain(key);
  });
});

describe("costMicrousd", () => {
  it("charges input and output at the listed prices, rounded up to a whole micro-dollar", () => {
    expect(costMicrousd("anthropic", "claude-opus-5-5", { inputTokens: 5_000, outputTokens: 2_000 })).toBe(60_000);
    expect(costMicrousd("openai-compatible", "@cf/openai/gpt-oss-120b", { inputTokens: 3, outputTokens: 1 })).toBe(2);
  });

  it("reports 0 for a model without a recorded price (limits are counts, not money)", () => {
    expect(costMicrousd("anthropic", "claude-unknown", { inputTokens: 5_000, outputTokens: 2_000 })).toBe(0);
  });
});

describe("worstCaseJobMicrousd", () => {
  it("is MAX_ATTEMPTS attempts at the input and output caps", () => {
    expect(MAX_ATTEMPTS * (MAX_INPUT_TOKENS * 4 + MAX_OUTPUT_TOKENS * 20)).toBe(1_331_520);
    expect(worstCaseJobMicrousd("anthropic", "claude-opus-5-5")).toBe(1_331_520);
    expect(worstCaseJobMicrousd("anthropic", "claude-sonnet-5")).toBe(665_760);
    expect(worstCaseJobMicrousd("fake", "fake-template")).toBe(0);
  });

  it("is null, never a made-up ceiling and never an exception, for a model whose price is not recorded", () => {
    expect(worstCaseJobMicrousd("anthropic", "claude-unknown")).toBeNull();
    expect(worstCaseJobMicrousd("anthropic", "constructor")).toBeNull();
  });
});

// Items 3 and 5 (G1).
describe("worstCaseAttemptMicrousd (item 5)", () => {
  it("is the largest prompt and the full output cap at the model's price, a third of the job's worst case, and null when unpriced", () => {
    expect(worstCaseAttemptMicrousd("anthropic", "claude-opus-5-5")).toBe(70_000 * 4 + 8_192 * 20);
    expect(worstCaseAttemptMicrousd("anthropic", "claude-opus-5-5")! * 3).toBe(worstCaseJobMicrousd("anthropic", "claude-opus-5-5"));
    expect(worstCaseAttemptMicrousd("anthropic", "claude-fable-5-1")).toBeNull();
    expect(worstCaseAttemptMicrousd("anthropic", "toString")).toBeNull();
  });
});

describe("the configured model is priced (item 3)", () => {
  it.each([
    ["anthropic", "claude-opus-5-5", true],
    ["anthropic", "claude-sonnet-5", true],
    ["anthropic", "claude-haiku-4-5", true],
    ["anthropic", "claude-fable-5-1", false],
    ["anthropic", "claude-opus-5-5-20261001", false],
    ["anthropic", "", false],
  ])("%s:%s priced = %s", (provider, model, priced) => {
    expect(modelSettings(provider, model) !== undefined).toBe(priced);
  });
});
