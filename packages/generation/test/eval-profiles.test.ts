import { TRADES } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { EVAL_PROFILES } from "../eval/profiles.ts";

describe("EVAL_PROFILES", () => {
  it("has 20 made-up businesses: 6 trap, 4 edge, 10 ordinary, covering all six trades", () => {
    expect(EVAL_PROFILES).toHaveLength(20);
    expect(EVAL_PROFILES.filter((p) => p.kind === "trap")).toHaveLength(6);
    expect(EVAL_PROFILES.filter((p) => p.kind === "edge")).toHaveLength(4);
    expect(EVAL_PROFILES.filter((p) => p.kind === "ordinary")).toHaveLength(10);
    expect(new Set(EVAL_PROFILES.map((p) => p.snapshot.facts.trade))).toEqual(new Set(TRADES));
    expect(new Set(EVAL_PROFILES.map((p) => p.id)).size).toBe(20);
  });

  it("gives trap profiles no licence, insurance or emergency facts, and notes that tempt the model to state claims", () => {
    for (const { snapshot } of EVAL_PROFILES.filter((p) => p.kind === "trap")) {
      const { facts, brief } = snapshot;
      expect([facts.licences.length, facts.insured, facts.emergency247]).toEqual([0, false, false]);
      expect(`${brief.notes ?? ""} ${brief.differentiator ?? ""}`).toMatch(/24\/7|years|since|free|best|cheapest|certified|bonded|warranty|established|day or night/i);
    }
  });

  it("has two traps that give free estimates but ask for free service calls, inspections or repairs (only a human can catch those)", () => {
    const free = EVAL_PROFILES.filter((p) => p.kind === "trap" && p.snapshot.facts.freeEstimates);
    expect(free.map((p) => p.id)).toEqual(["trap-hvac", "trap-roof"]);
    for (const { snapshot } of free) expect(snapshot.brief.notes).toMatch(/free (service calls|inspections|repairs)/i);
  });

  it("has service names a model cannot retype byte for byte, and one that holds a claim word the facts do not back", () => {
    const names = EVAL_PROFILES.flatMap((p) => p.snapshot.facts.services.map((s) => s.name));
    expect(names.some((n) => n.includes(" "))).toBe(true);
    expect(names.some((n) => n.includes("’"))).toBe(true);
    expect(names.some((n) => n !== n.normalize("NFC"))).toBe(true);
    expect(EVAL_PROFILES.some((p) => !p.snapshot.facts.emergency247 && p.snapshot.facts.services.some((s) => /emergency/i.test(s.name)))).toBe(true);
  });

  it("covers the edge cases: 12 services, 40-character names, one service, a Spanish name", () => {
    const edge = EVAL_PROFILES.filter((p) => p.kind === "edge").map((p) => p.snapshot.facts);
    expect(edge.some((f) => f.services.length === 12)).toBe(true);
    expect(edge.some((f) => f.services.some((s) => s.name.length === 40) && f.businessName.length > 40)).toBe(true);
    expect(edge.some((f) => f.services.length === 1)).toBe(true);
    expect(edge.some((f) => /García/.test(f.businessName))).toBe(true);
  });

  it("uses fictional contact details only", () => {
    for (const { snapshot } of EVAL_PROFILES) {
      expect(snapshot.facts.phone).toMatch(/^\+151255501\d\d$/);
      expect(snapshot.facts.email).toMatch(/\.example\.com$/);
    }
  });
});
