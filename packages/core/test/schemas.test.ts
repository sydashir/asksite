import { PALETTE_IDS, Theme } from "@asksite/site-schema";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AcceptInviteBody,
  ApproveBody,
  AUDIT_ACTIONS,
  Brief,
  canonicalJson,
  EMPTY_EDITS,
  ERROR_STATUS,
  LIMITS,
  LOOKS,
  newToken,
  PatchDraftBody,
  SettingsBody,
  TakedownBody,
  type AdminSettings,
  type ErrorBody,
  type LeadView,
  type SiteRow,
  type VersionSummary,
} from "../src/index.ts";

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
});

describe("LIMITS.briefJsonMaxBytes", () => {
  // The largest valid Brief: every field at its cap, in the character that costs the most once
  // JSON-encoded. A lone surrogate becomes a 6-byte "\ud800" escape and zod counts it as one
  // character; the only other 6-byte escapes are control characters, which Brief rejects.
  const lone = "\uD800";
  const key = (i: number) => `q${String(i).padStart(2, "0")}${"x".repeat(37)}`; // 40 characters, the most a key may have
  const largest = {
    tone: "professional", // the longest tone, goal and boolean
    goal: "quote",
    differentiator: lone.repeat(140),
    notes: lone.repeat(2000),
    comments: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [key(i), lone.repeat(500)])),
    reviewsAreReal: false,
  };

  it("holds the largest valid Brief once JSON-encoded, rounded up to a whole KiB", () => {
    const bytes = new TextEncoder().encode(JSON.stringify(Brief.parse(largest))).byteLength;
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

describe("request bodies", () => {
  it("accepts a real token and rejects anything else", () => {
    expect(AcceptInviteBody.safeParse({ token: newToken() }).success).toBe(true);
    expect(AcceptInviteBody.safeParse({ token: "short" }).success).toBe(false);
  });

  it("PatchDraftBody needs at least one part", () => {
    expect(PatchDraftBody.safeParse({ rev: 1 }).success).toBe(false);
    expect(PatchDraftBody.safeParse({ rev: 1, facts: {} }).success).toBe(true);
  });

  it("ApproveBody needs a lower-case sha256 and defaults indexable to true", () => {
    expect(ApproveBody.parse({ htmlSha256: "a".repeat(64) })).toEqual({ htmlSha256: "a".repeat(64), indexable: true });
    expect(ApproveBody.safeParse({ htmlSha256: "A".repeat(64) }).success).toBe(false);
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
  });

  it("every look is a valid Plan 1 theme, and the four looks use four palettes", () => {
    for (const look of LOOKS) expect(Theme.safeParse(look.theme).success).toBe(true);
    expect(new Set(LOOKS.map((l) => l.theme.palette)).size).toBe(PALETTE_IDS.length);
  });

  it("keeps the agreed limits and lifetimes", () => {
    expect(LIMITS.leadsPerSitePerDay).toBe(50);
    expect(LIMITS.leadRetentionDays).toBe(180);
    expect(LIMITS.publishRequestsPerSitePerDay).toBe(20);
    expect(AUDIT_ACTIONS).toContain("site.taken_down");
  });
});

describe("row and view types", () => {
  it("describe the tables and API responses (checked by pnpm typecheck)", () => {
    const site: SiteRow = {
      id: "s", owner_id: "o", slug: null, facts_json: "{}", brief_json: "{}", edits_json: canonicalJson(EMPTY_EDITS), rev: 1,
      live_version_id: null, pending_version_id: null, indexable: 1, taken_down_at: null, takedown_reason: null, created_at: 1, updated_at: 1,
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
