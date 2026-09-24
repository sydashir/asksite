import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toIssues, TTL, utcDay, utcDayStart } from "../src/index.ts";

describe("time", () => {
  it("utcDay and utcDayStart use UTC midnight", () => {
    const now = Date.parse("2026-09-24T23:59:59.999Z");
    expect(utcDay(now)).toBe("2026-09-24");
    expect(utcDayStart(now)).toBe(Date.parse("2026-09-24T00:00:00.000Z"));
    expect(utcDayStart(Date.parse("2026-09-25T00:00:00.000Z"))).toBe(Date.parse("2026-09-25T00:00:00.000Z"));
  });

  it("keeps the agreed token and session lifetimes", () => {
    expect(TTL).toEqual({ inviteMs: 604_800_000, loginTokenMs: 900_000, sessionMs: 2_592_000_000 });
  });
});

describe("toIssues", () => {
  it("flattens zod issues and turns symbol path keys into strings", () => {
    const sym = Symbol("s");
    const schema = z.object({ a: z.array(z.string()) }).superRefine((_, ctx) => {
      ctx.addIssue({ code: "custom", path: [sym], message: "symbolic" });
    });
    const result = schema.safeParse({ a: [1] });
    if (result.success) throw new Error("expected a type issue");
    expect(toIssues(result.error)).toEqual([{ path: ["a", 0], code: "invalid_type", message: "Invalid input: expected string, received number" }]);
    const refined = schema.safeParse({ a: ["x"] });
    if (refined.success) throw new Error("expected a refinement issue");
    expect(toIssues(refined.error)).toEqual([{ path: ["Symbol(s)"], code: "custom", message: "symbolic" }]);
  });
});
