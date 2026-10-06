import { DAYS, DESIGN_IDS, Facts, FONT_IDS, HIDEABLE_SECTIONS, PALETTE_IDS, SOCIAL_NETWORKS, Theme, TRADES } from "@asksite/site-schema";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  AcceptInviteBody,
  ApproveBody,
  AUDIT_ACTIONS,
  Brief,
  canonicalJson,
  CreateInviteBody,
  DeleteOwnerBody,
  EMPTY_EDITS,
  ERROR_STATUS,
  GOALS,
  LIMITS,
  LOOKS,
  LoginBody,
  newId,
  newToken,
  OwnerEdits,
  PatchDraftBody,
  REDACTED_REASON,
  SECTION_IDS,
  SettingsBody,
  TakedownBody,
  TONES,
  type AdminSettings,
  type ErrorBody,
  type LeadView,
  type SiteRow,
  type VersionSummary,
} from "../src/index.ts";

// For the largest-value tests below. A lone surrogate is the character that costs the most once
// JSON-encoded: a 6-byte "\ud800" escape that zod counts as one character. The only other 6-byte
// escapes are control characters, which Brief and Facts text reject.
const lone = "\uD800";
const longest = (values: readonly string[]): string => values.reduce((a, b) => (b.length > a.length ? b : a));
const jsonBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** The fields `schema` allows that `value` leaves out, looking inside every object and list item. */
function unfilled(schema: z.core.$ZodType, value: unknown, path = ""): string[] {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault || schema instanceof z.ZodNullable) return unfilled(schema.unwrap(), value, path);
  if (schema instanceof z.ZodArray) return (value as unknown[]).flatMap((item, i) => unfilled(schema.element, item, `${path}[${i}]`));
  if (!(schema instanceof z.ZodObject)) return [];
  const object = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>; // null leaves every field out
  return Object.entries(schema.shape).flatMap(([key, field]) =>
    key in object ? unfilled(field, object[key], `${path}.${key}`) : [`${path}.${key}`],
  );
}

describe("Brief", () => {
  it("fills defaults", () => {
    expect(Brief.parse({ tone: "friendly", goal: "call" })).toEqual({ tone: "friendly", goal: "call", comments: {}, reviewsAreReal: false });
  });

  it("keeps newlines in notes but rejects other control and invisible characters", () => {
    expect(Brief.safeParse({ tone: "friendly", goal: "call", notes: "Line one\nLine two" }).success).toBe(true);
    expect(Brief.safeParse({ tone: "friendly", goal: "call", notes: "a\u0007b" }).success).toBe(false);
    expect(Brief.safeParse({ tone: "friendly", goal: "call", notes: "a\u202Eb" }).success).toBe(false);
    expect(Brief.safeParse({ tone: "friendly", goal: "call", notes: "family \u{1F468}\u200D\u{1F469}" }).success).toBe(true);
  });

  it("caps comments at 20 and keys them by question id", () => {
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`q${i}`, "x"]));
    expect(Brief.safeParse({ tone: "friendly", goal: "call", comments: many }).success).toBe(false);
    expect(Brief.safeParse({ tone: "friendly", goal: "call", comments: { "Bad-Key": "x" } }).success).toBe(false);
    expect(Brief.safeParse({ tone: "friendly", goal: "call", comments: { services: "We do not do gas lines" } }).success).toBe(true);
  });

  it("rejects unknown keys", () => {
    expect(Brief.safeParse({ tone: "friendly", goal: "call", extra: 1 }).success).toBe(false);
  });

  it("tells the owner how many comments they can add (A9)", () => {
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`q${i}`, "x"]));
    const result = Brief.safeParse({ tone: "friendly", goal: "call", comments: many });
    expect(result.success ? [] : result.error.issues.map((i) => ({ path: i.path, code: i.code, message: i.message }))).toEqual([
      { path: ["comments"], code: "custom", message: "You can add at most 20 comments." },
    ]);
  });
});

describe("LIMITS.briefJsonMaxBytes", () => {
  // The largest valid Brief: every field at its cap, in the character that costs the most (lone).
  const key = (i: number) => `q${String(i).padStart(2, "0")}${"x".repeat(37)}`; // 40 characters, the most a key may have
  const largest = {
    tone: longest(TONES),
    goal: longest(GOALS),
    differentiator: lone.repeat(140),
    notes: lone.repeat(2000),
    comments: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [key(i), lone.repeat(500)])),
    reviewsAreReal: false, // longer than true
  };

  it("fills every field Brief allows", () => {
    expect(unfilled(Brief, largest)).toEqual([]);
  });

  it("holds the largest valid Brief once JSON-encoded, rounded up to a whole KiB", () => {
    const bytes = jsonBytes(Brief.parse(largest));
    expect(bytes).toBe(73_865);
    expect(bytes).toBeLessThanOrEqual(LIMITS.briefJsonMaxBytes);
    expect(LIMITS.briefJsonMaxBytes).toBe(Math.ceil(bytes / 1024) * 1024);
  });

  it.each([
    ["the differentiator", { differentiator: lone.repeat(141) }],
    ["the notes", { notes: lone.repeat(2001) }],
    ["a comment", { comments: { ...largest.comments, [key(0)]: lone.repeat(501) } }],
    ["the comment count", { comments: { ...largest.comments, [key(20)]: lone } }],
    ["a comment key", { comments: { [`q${"x".repeat(40)}`]: lone } }],
  ])("is measured at the caps: one more in %s is refused", (_, change) => {
    expect(Brief.safeParse({ ...largest, ...change }).success).toBe(false);
  });
});

describe("LIMITS.factsJsonMaxBytes", () => {
  // The largest valid Facts: every list at its longest and every field at its cap, in the costliest
  // characters. Facts text and URLs both accept a lone surrogate. A URL must start "https://" (A9) and
  // name a host that holds no lone surrogate, so the costliest URL is "https://", one 3-byte host
  // character ("ａ", read as "a"), a backslash (read as "/", 2 bytes once JSON-encoded), then lone
  // surrogates. A social link's host must be its network's. Trying every code point the URL parser
  // reads as ASCII, the largest link is google's with g.page spelled "ｇ．㎩ｇｅ" (㎩ reads "pa"): the
  // fewest host characters leave the most room for lone surrogates. The looser test below needs no search.
  const url = (host: string) => `https://${host}\\${lone.repeat(2048 - "https://".length - host.length - 1)}`;
  const photo = { url: url("ａ"), alt: lone.repeat(125), width: 10_000, height: 10_000, caption: lone.repeat(80) };
  const link = { network: "google", url: url("ｇ．㎩ｇｅ") };
  const largest = {
    businessName: lone.repeat(60),
    trade: longest(TRADES),
    phone: "+12125550142",
    email: `${"a".repeat(249)}@b.co`, // 254 characters; zod's email pattern allows only ASCII, and never " or \
    location: { streetAddress: lone.repeat(80), city: lone.repeat(40), state: "TX", postalCode: "78701" },
    serviceArea: { places: Array.from({ length: 30 }, () => lone.repeat(40)), note: lone.repeat(80) },
    hours: DAYS.map((day) => ({ days: [day], opens: "00:00", closes: "23:59" })), // one day each: the most entries
    services: Array.from({ length: 12 }, () => ({ name: lone.repeat(40), startingPrice: 100_000 })),
    licences: Array.from({ length: 5 }, () => ({ label: lone.repeat(40), number: lone.repeat(30) })),
    insured: false, // longer than true
    yearFounded: 2100,
    emergency247: false,
    freeEstimates: false,
    testimonials: Array.from({ length: 12 }, () => ({ quote: lone.repeat(320), name: lone.repeat(40), location: lone.repeat(40) })),
    heroPhoto: photo,
    photos: Array.from({ length: 12 }, () => photo),
    socialLinks: Array.from({ length: 7 }, () => link),
  };

  it("fills every field Facts allows", () => {
    expect(unfilled(Facts, largest)).toEqual([]);
  });

  it("holds the largest valid Facts once JSON-encoded, rounded up to a whole KiB", () => {
    const bytes = jsonBytes(Facts.parse(largest));
    expect(bytes).toBe(306_352);
    expect(bytes).toBeLessThanOrEqual(LIMITS.factsJsonMaxBytes);
    expect(LIMITS.factsJsonMaxBytes).toBe(Math.ceil(bytes / 1024) * 1024);
  });

  it("would still hold it if every URL character after https: cost 6 bytes and every link named the longest network", () => {
    const anyUrl = `https:${lone.repeat(2048 - "https:".length)}`; // not a valid URL: a bound that needs no URL-parsing rule
    const looser = {
      ...largest,
      heroPhoto: { ...photo, url: anyUrl },
      photos: largest.photos.map(() => ({ ...photo, url: anyUrl })),
      socialLinks: largest.socialLinks.map(() => ({ network: longest(SOCIAL_NETWORKS), url: anyUrl })),
    };
    expect(jsonBytes(looser)).toBeLessThanOrEqual(LIMITS.factsJsonMaxBytes);
  });

  it.each([
    ["the business name", { businessName: lone.repeat(61) }],
    ["the phone number", { phone: `${largest.phone}0` }],
    ["the email", { email: `a${largest.email}` }],
    ["the street address", { location: { ...largest.location, streetAddress: lone.repeat(81) } }],
    ["the city", { location: { ...largest.location, city: lone.repeat(41) } }],
    ["the state", { location: { ...largest.location, state: "TXX" } }],
    ["the ZIP code", { location: { ...largest.location, postalCode: "787011" } }],
    ["the place count", { serviceArea: { ...largest.serviceArea, places: [...largest.serviceArea.places, lone] } }],
    ["a place", { serviceArea: { ...largest.serviceArea, places: [lone.repeat(41)] } }],
    ["the service-area note", { serviceArea: { ...largest.serviceArea, note: lone.repeat(81) } }],
    ["the opening-hours count", { hours: [...largest.hours, { days: [DAYS[0]], opens: "00:00", closes: "23:59" }] }],
    ["an opening time", { hours: [{ days: [DAYS[0]], opens: "00:000", closes: "23:59" }] }],
    ["the service count", { services: [...largest.services, { name: lone }] }],
    ["a service name", { services: [{ name: lone.repeat(41) }] }],
    ["a starting price", { services: [{ name: lone, startingPrice: 100_001 }] }],
    ["the licence count", { licences: [...largest.licences, { label: lone, number: lone }] }],
    ["a licence label", { licences: [{ label: lone.repeat(41), number: lone }] }],
    ["a licence number", { licences: [{ label: lone, number: lone.repeat(31) }] }],
    ["the founding year", { yearFounded: 2101 }],
    ["the testimonial count", { testimonials: [...largest.testimonials, { quote: lone, name: lone }] }],
    ["a quote", { testimonials: [{ quote: lone.repeat(321), name: lone }] }],
    ["a reviewer's name", { testimonials: [{ quote: lone, name: lone.repeat(41) }] }],
    ["a reviewer's location", { testimonials: [{ quote: lone, name: lone, location: lone.repeat(41) }] }],
    ["a photo URL", { heroPhoto: { ...photo, url: `${photo.url}x` } }],
    ["a photo's alt text", { heroPhoto: { ...photo, alt: lone.repeat(126) } }],
    ["a photo's width", { heroPhoto: { ...photo, width: 10_001 } }],
    ["a photo's height", { heroPhoto: { ...photo, height: 10_001 } }],
    ["a photo's caption", { heroPhoto: { ...photo, caption: lone.repeat(81) } }],
    ["the photo count", { photos: [...largest.photos, photo] }],
    ["the social-link count", { socialLinks: [...largest.socialLinks, link] }],
    ["a social-link URL", { socialLinks: [{ ...link, url: `${link.url}x` }] }],
  ])("is measured at the caps: one more in %s is refused", (_, change) => {
    expect(Facts.safeParse({ ...largest, ...change }).success).toBe(false);
  });
});

describe("OwnerEdits caps (A8c)", () => {
  it("allows a baseGenerationId as long as the longest id newId() makes, and no longer", () => {
    const id = newId();
    expect(id).toHaveLength(36);
    expect(OwnerEdits.safeParse({ ...EMPTY_EDITS, baseGenerationId: id }).success).toBe(true);
    expect(OwnerEdits.safeParse({ ...EMPTY_EDITS, baseGenerationId: `${id}0` }).success).toBe(false);
  });

  it("allows as many service descriptions as Facts allows services, and no more", () => {
    const facts = { businessName: "Mop", trade: "cleaning", phone: "+12085550107", email: "hi@example.com", location: { city: "Boise", state: "ID" }, serviceArea: { places: ["Boise"] } };
    const names = (n: number) => Array.from({ length: n }, (_, i) => `Service ${i}`);
    let most = 0;
    while (most < 1000 && Facts.safeParse({ ...facts, services: names(most + 1).map((name) => ({ name })) }).success) most += 1;
    expect(most).toBeGreaterThan(0);
    const withDescriptions = (n: number) => ({ ...EMPTY_EDITS, copy: { serviceDescriptions: Object.fromEntries(names(n).map((name) => [name, "Text."])) } });
    expect(OwnerEdits.safeParse(withDescriptions(most)).success).toBe(true);
    expect(OwnerEdits.safeParse(withDescriptions(most + 1)).error?.issues.map((i) => `${i.path.join(".")}:${i.code}`)).toEqual(["copy.serviceDescriptions:too_big"]);
  });
});

describe("LIMITS.editsJsonMaxBytes", () => {
  // The largest valid OwnerEdits: every wording field at 2,000 characters, the most EditText allows,
  // in the costliest character (EditText accepts any character; lone costs 6 bytes, the most any
  // UTF-16 unit can: see the scan below). Each service-description key is 40 characters of a
  // different lone surrogate, so the keys differ. Ids are ASCII, so the longest id of each list.
  const text = lone.repeat(2000);
  const key = (i: number) => String.fromCharCode(0xd800 + i).repeat(40);
  const largest = {
    baseGenerationId: lone.repeat(36),
    copy: {
      heroHeadline: text,
      heroSubheadline: text,
      ctaText: text,
      about: text, // longer than null
      sectionIntros: { services: text, gallery: text, faq: text, contact: text },
      serviceDescriptions: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [key(i), text])),
      faq: Array.from({ length: 8 }, () => ({ question: text, answer: text })),
    },
    order: [...SECTION_IDS], // every order lists the same ids, so every order is the same size
    hidden: [...HIDEABLE_SECTIONS],
    theme: { palette: longest(PALETTE_IDS), font: longest(FONT_IDS), design: longest(DESIGN_IDS) },
  };

  it("fills every field OwnerEdits allows", () => {
    expect(unfilled(OwnerEdits, largest)).toEqual([]);
  });

  it("uses the costliest character: no UTF-16 unit costs more than lone once JSON-encoded", () => {
    const costs = Array.from({ length: 0x10000 }, (_, unit) => jsonBytes(String.fromCharCode(unit)) - 2);
    expect(Math.max(...costs)).toBe(jsonBytes(lone) - 2);
    expect(jsonBytes("\u{1F600}") - 2).toBeLessThan(2 * (jsonBytes(lone) - 2)); // a surrogate pair costs less than two lone ones
  });

  it("holds the largest valid OwnerEdits once JSON-encoded, rounded up to a whole KiB (never below 64 KiB)", () => {
    const bytes = jsonBytes(OwnerEdits.parse(largest));
    expect(bytes).toBe(435_829); // 435,810 before A12, plus ,"design":"refined" (19 bytes)
    expect(bytes).toBeLessThanOrEqual(LIMITS.editsJsonMaxBytes);
    expect(LIMITS.editsJsonMaxBytes).toBe(Math.max(65_536, Math.ceil(bytes / 1024) * 1024));
  });

  it("would still hold it if the hidden list could name any six sections", () => {
    const sixLongest = [...SECTION_IDS].sort((a, b) => b.length - a.length).slice(0, HIDEABLE_SECTIONS.length);
    expect(jsonBytes({ ...OwnerEdits.parse(largest), hidden: sixLongest })).toBeLessThanOrEqual(LIMITS.editsJsonMaxBytes);
  });

  const copy = largest.copy;
  it.each([
    ["the baseGenerationId", { baseGenerationId: lone.repeat(37) }],
    ["the headline", { copy: { ...copy, heroHeadline: lone.repeat(2001) } }],
    ["the line under the headline", { copy: { ...copy, heroSubheadline: lone.repeat(2001) } }],
    ["the button text", { copy: { ...copy, ctaText: lone.repeat(2001) } }],
    ["the about text", { copy: { ...copy, about: lone.repeat(2001) } }],
    ...(["services", "gallery", "faq", "contact"] as const).map((intro) => [
      `the ${intro} introduction`,
      { copy: { ...copy, sectionIntros: { ...copy.sectionIntros, [intro]: lone.repeat(2001) } } },
    ]),
    ["a service description", { copy: { ...copy, serviceDescriptions: { ...copy.serviceDescriptions, [key(0)]: lone.repeat(2001) } } }],
    ["a service-description key", { copy: { ...copy, serviceDescriptions: { [lone.repeat(41)]: text } } }],
    ["the service-description count", { copy: { ...copy, serviceDescriptions: { ...copy.serviceDescriptions, [key(12)]: text } } }],
    ["a question", { copy: { ...copy, faq: [{ question: lone.repeat(2001), answer: text }] } }],
    ["an answer", { copy: { ...copy, faq: [{ question: text, answer: lone.repeat(2001) }] } }],
    ["the question count", { copy: { ...copy, faq: [...copy.faq, { question: text, answer: text }] } }],
    ["the section order", { order: [...SECTION_IDS, "faq"] }],
    ["the hidden list", { hidden: [...HIDEABLE_SECTIONS, "faq"] }],
    ["the look", { theme: { ...largest.theme, palette: `${largest.theme.palette}x` } }],
    ["the design", { theme: { ...largest.theme, design: `${largest.theme.design}x` } }],
    ["an unknown wording field", { copy: { ...copy, motto: text } }],
    ["an unknown top-level field", { note: text }],
  ] as Array<[string, object]>)("is measured at the caps: one more in %s is refused", (_, change) => {
    expect(OwnerEdits.safeParse({ ...largest, ...change }).success).toBe(false);
  });
});

describe("request bodies", () => {
  it("accepts a real token and rejects anything else", () => {
    expect(AcceptInviteBody.safeParse({ token: newToken() }).success).toBe(true);
    expect(AcceptInviteBody.safeParse({ token: "short" }).success).toBe(false);
  });

  it.each([
    ["LoginBody", LoginBody],
    ["CreateInviteBody", CreateInviteBody],
  ] as const)("%s trims the email before checking it (A9)", (_, Body) => {
    expect(Body.parse({ email: " \t owner@example.com \n" })).toEqual({ email: "owner@example.com" });
    expect(Body.parse({ email: ` ${"a".repeat(242)}@example.com ` }).email).toHaveLength(254); // the cap counts the trimmed email
    expect(Body.safeParse({ email: `${"a".repeat(243)}@example.com` }).success).toBe(false); // 255 characters
    expect(Body.safeParse({ email: "   " }).success).toBe(false);
    expect(Body.safeParse({ email: "owner at example.com" }).success).toBe(false);
    expect(Body.safeParse({ email: 42 }).success).toBe(false);
  });

  it("LoginBody and CreateInviteBody keep their types (A9)", () => {
    expectTypeOf<z.input<typeof LoginBody>>().toEqualTypeOf<{ email: string }>();
    expectTypeOf<z.output<typeof LoginBody>>().toEqualTypeOf<{ email: string }>();
    expectTypeOf<z.input<typeof CreateInviteBody>>().toEqualTypeOf<{ email: string }>();
    expectTypeOf<z.output<typeof CreateInviteBody>>().toEqualTypeOf<{ email: string }>();
  });

  it("PatchDraftBody needs at least one part", () => {
    expect(PatchDraftBody.safeParse({ rev: 1 }).success).toBe(false);
    expect(PatchDraftBody.safeParse({ rev: 1, facts: {} }).success).toBe(true);
  });

  it("ApproveBody needs a lower-case sha256 and defaults indexable to true", () => {
    expect(ApproveBody.parse({ htmlSha256: "a".repeat(64) })).toEqual({ htmlSha256: "a".repeat(64), indexable: true });
    expect(ApproveBody.safeParse({ htmlSha256: "A".repeat(64) }).success).toBe(false);
  });

  it("DeleteOwnerBody trims the typed email and refuses a missing, empty, too long or extra field", () => {
    expect(DeleteOwnerBody.parse({ confirmEmail: "  Joe@Example.com " })).toEqual({ confirmEmail: "Joe@Example.com" });
    expect(DeleteOwnerBody.parse({ confirmEmail: "x".repeat(254) }).confirmEmail).toHaveLength(254);
    expect(DeleteOwnerBody.safeParse({}).success).toBe(false);
    expect(DeleteOwnerBody.safeParse({ confirmEmail: "" }).success).toBe(false);
    expect(DeleteOwnerBody.safeParse({ confirmEmail: "   " }).success).toBe(false);
    expect(DeleteOwnerBody.safeParse({ confirmEmail: "x".repeat(255) }).success).toBe(false);
    expect(DeleteOwnerBody.safeParse({ confirmEmail: "a@b.co", extra: 1 }).success).toBe(false);
    expect(DeleteOwnerBody.safeParse({ confirmEmail: 5 }).success).toBe(false);
  });

  it("REDACTED_REASON is the text account deletion writes over the admin reasons", () => {
    expect(REDACTED_REASON).toBe("[deleted with the account]");
  });

  it("TakedownBody and SettingsBody apply their caps", () => {
    expect(TakedownBody.parse({ reason: " phishing " })).toEqual({ reason: "phishing", purgeMedia: false });
    expect(TakedownBody.safeParse({ reason: "" }).success).toBe(false);
    expect(SettingsBody.safeParse({ dailyModelLimit: 1001 }).success).toBe(false);
  });
});

describe("constants", () => {
  it("maps error codes to HTTP statuses", () => {
    expect(ERROR_STATUS.site_taken_down).toBe(423);
    expect(ERROR_STATUS.email_failed).toBe(502);
    expect(ERROR_STATUS.rate_limited).toBe(429);
    // A draft PATCH whose copy or order edits carry a stale baseGenerationId (Plan 4's wording guard).
    expect(ERROR_STATUS.wording_changed).toBe(409);
  });

  it("every look is a valid Plan 1 theme, and the four looks use four palettes", () => {
    for (const look of LOOKS) expect(Theme.safeParse(look.theme).success).toBe(true);
    expect(new Set(LOOKS.map((l) => l.theme.palette)).size).toBe(PALETTE_IDS.length);
  });

  it("keeps the agreed limits and lifetimes", () => {
    expect(LIMITS.generationsPerSitePerDay).toBe(5);
    expect(LIMITS.generationsPerOwnerTotal).toBe(20);
    expect(LIMITS.generationsPerOwnerPerDay).toBe(5); // regenerations only; first builds neither count nor are refused (Decision 30)
    expect(LIMITS.leadsPerSitePerDay).toBe(50);
    expect(LIMITS.leadRetentionDays).toBe(180);
    expect(LIMITS.spamLeadRetentionDays).toBe(30); // spam = 1 rows only; owners never see them
    expect(LIMITS.generationInputRetentionDays).toBe(30); // finished generations only; output_json and costs stay
    expect(LIMITS.publishRequestsPerSitePerDay).toBe(20);
    expect(AUDIT_ACTIONS).toContain("site.taken_down");
  });

  it("lists the audit actions append-only: A14 adds admin.login_link_sent (the admin 'Send sign-in link', A11b) last", () => {
    // audit_log.action has no SQL CHECK (0001_init.sql), so stored rows keep their meaning when an action is added.
    expect(AUDIT_ACTIONS).toEqual([
      "invite.created", "invite.revoked", "invite.accepted", "auth.login",
      "generation.requested", "version.requested", "version.withdrawn", "version.approved", "version.rejected",
      "site.taken_down", "site.restored", "site.indexable_changed", "owner.disabled", "owner.enabled",
      "settings.updated", "admin.login_link_sent",
      "owner.deletion_started", "owner.deleted", // account deletion, appended last (the 16 before are unchanged)
    ]);
  });
});

describe("row and view types", () => {
  it("describe the tables and API responses (checked by pnpm typecheck)", () => {
    const site: SiteRow = {
      id: "s", owner_id: "o", slug: null, facts_json: "{}", brief_json: "{}", edits_json: canonicalJson(EMPTY_EDITS), rev: 1,
      live_version_id: null, pending_version_id: null, indexable: 1, taken_down_at: null, takedown_reason: null, admin_lock: null, admin_lock_until: null, created_at: 1, updated_at: 1,
    };
    const version: VersionSummary = { id: "v", number: 1, status: "pending", requestedAt: 1, reviewedAt: null, reviewNote: null };
    const lead: LeadView = { id: "l", createdAt: 1, name: "n", phone: "p", email: null, service: null, message: null, emailStatus: "sent" };
    const body: ErrorBody = { error: { code: "conflict", message: "Changed elsewhere", currentRev: 2 } };
    expect([site.indexable, version.status, lead.emailStatus, ERROR_STATUS[body.error.code]]).toEqual([1, "pending", "sent", 409]);
  });

  it("allow an unknown worst-case daily cost: null when the model has no recorded price (M3)", () => {
    const settings: AdminSettings = {
      generationEnabled: false, envGenerationEnabled: false, dailyModelLimit: 8, modelCallsToday: 0, spentTodayMicrousd: 0, worstCaseDailyMicrousd: null,
    };
    expectTypeOf<AdminSettings["worstCaseDailyMicrousd"]>().toEqualTypeOf<number | null>();
    expect(settings.worstCaseDailyMicrousd).toBeNull();
  });
});
