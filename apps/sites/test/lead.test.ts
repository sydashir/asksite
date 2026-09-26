import { describe, expect, it } from "vitest";
import { looksLikeSpam, readLead } from "../src/lead.ts";

const fields = (values: Record<string, string>) => new URLSearchParams(values);

describe("readLead", () => {
  it("accepts the minimum: a name and a phone number", () => {
    expect(readLead(fields({ name: "Al", phone: "5125550199" }))).toEqual({
      ok: true,
      lead: { name: "Al", phone: "5125550199", email: null, service: null, message: null },
    });
  });

  it("trims every field and turns empty optional fields into null", () => {
    const result = readLead(fields({ name: "  Al  ", phone: " +1 (512) 555-0199 ", email: " ", service: "", message: "  " }));
    expect(result).toEqual({ ok: true, lead: { name: "Al", phone: "+1 (512) 555-0199", email: null, service: null, message: null } });
  });

  it.each([
    ["name", { name: "", phone: "5125550199" }],
    ["name", { name: "x".repeat(81), phone: "5125550199" }],
    ["phone", { name: "Al", phone: "" }],
    ["phone", { name: "Al", phone: "555-01" }],
    ["phone", { name: "Al", phone: "call me maybe 5125550199" }],
    ["phone", { name: "Al", phone: "(((((((((((" }],
    ["phone", { name: "Al", phone: "5".repeat(31) }],
    ["email", { name: "Al", phone: "5125550199", email: "not-an-email" }],
    ["email", { name: "Al", phone: "5125550199", email: `${"a".repeat(250)}@b.co` }],
    ["service", { name: "Al", phone: "5125550199", service: "s".repeat(61) }],
    ["message", { name: "Al", phone: "5125550199", message: "m".repeat(2001) }],
  ])("reports %s", (problem, values) => {
    expect(readLead(fields(values))).toEqual({ ok: false, problems: [problem] });
  });

  it("reports every problem at once, in field order", () => {
    expect(readLead(fields({}))).toEqual({ ok: false, problems: ["name", "phone"] });
  });

  it("counts a CRLF line break in the message as one character, as the browser's maxlength does", () => {
    const message = `${"m".repeat(999)}\r\n${"m".repeat(1000)}`;
    const result = readLead(fields({ name: "Al", phone: "5125550199", message }));
    expect(result.ok && result.lead.message?.length).toBe(2000);
  });

  it("removes control and invisible characters, keeping emoji joiners and message newlines", () => {
    const result = readLead(fields({ name: "Ana\u200B \u{1F469}\u200D\u{1F527}\u0000", phone: "512\u202E5550199", message: "a\r\nb\u0007" }));
    expect(result).toEqual({ ok: true, lead: { name: "Ana \u{1F469}\u200D\u{1F527}", phone: "5125550199", email: null, service: null, message: "a\nb" } });
  });

  it("keeps a single-line field on one line", () => {
    const result = readLead(fields({ name: "Al\r\nBcc: x@y.example", phone: "5125550199" }));
    expect(result.ok && result.lead.name).toBe("AlBcc: x@y.example");
  });
});

describe("looksLikeSpam", () => {
  const lead = (message: string | null) => ({ name: "n", phone: "5125550199", email: null, service: null, message });
  it("flags more than three http occurrences, case-insensitively", () => {
    expect(looksLikeSpam(lead("http://a HTTP://b https://c"))).toBe(false);
    expect(looksLikeSpam(lead("http://a HTTP://b https://c Http://d"))).toBe(true);
    expect(looksLikeSpam(lead(null))).toBe(false);
  });
});
