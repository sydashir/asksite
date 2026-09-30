import { describe, expect, it } from "vitest";
import { mailFailure } from "../../src/worker/mail-failure.ts";

describe("mailFailure", () => {
  it("names a failed send by the mailer's code (design §7.6 MailerError)", () => {
    for (const code of ["rate_limited", "rejected", "unavailable", "misconfigured"]) {
      expect(mailFailure(Object.assign(new Error("Resend refused someone@example.com"), { name: "MailerError", code }))).toBe(code);
    }
  });

  it("names any other failure by its class only, never by its message or an unknown code", () => {
    expect(mailFailure(new TypeError("someone@example.com"))).toBe("TypeError");
    expect(mailFailure(Object.assign(new Error("boom"), { code: "someone@example.com" }))).toBe("Error");
    expect(mailFailure(Object.assign(new Error("boom"), { code: 429 }))).toBe("Error");
    expect(mailFailure("someone@example.com")).toBe("unknown");
    expect(mailFailure(null)).toBe("unknown");
  });
});
