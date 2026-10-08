import { MailerError } from "@asksite/mailer";
import { describe, expect, it } from "vitest";
import { failedAttempt, keyNumberOf, leadKey } from "../src/lead-attempt.ts";

// C1 RULING 3 (2026-10-08): a lead email's idempotency key changes only after Resend answered 429 or 5xx (the email
// was not sent, and Resend may keep that answer under the key for 24 hours); with no answer the email may have gone
// out, so the key stays. The key's number travels in email_error ('<code>:<n>') and in the claim ('retrying:<ms>:<n>').
const ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const answered = (code: "rate_limited" | "rejected" | "unavailable", status: number, reason?: string) =>
  new MailerError(code, `Resend returned ${status}`, { status, ...(reason === undefined ? {} : { reason }) });

describe("leadKey", () => {
  it("is the form's own key for the first, and numbered after that", () => {
    expect(leadKey(ID, 1)).toBe(`lead:${ID}`);
    expect(leadKey(ID, 2)).toBe(`lead:${ID}:2`);
    expect(leadKey(ID, 17)).toBe(`lead:${ID}:17`);
  });
});

describe("keyNumberOf", () => {
  it.each([
    [null, 1],
    ["unavailable", 1],
    ["rate_limited", 1],
    ["unavailable:2", 2],
    ["rate_limited:13", 13],
    ["retrying:1759924800000", 1],
    ["retrying:1759924800000:4", 4],
  ] as const)("reads %s as key number %i", (stored, n) => {
    expect(keyNumberOf(stored)).toBe(n);
  });
});

describe("failedAttempt", () => {
  it("takes a new key after a 429 or a 5xx: Resend answered, and did not send", () => {
    expect(failedAttempt(answered("rate_limited", 429), 1)).toBe("rate_limited:2");
    expect(failedAttempt(answered("unavailable", 500), 1)).toBe("unavailable:2");
    expect(failedAttempt(answered("unavailable", 503), 4)).toBe("unavailable:5");
  });

  it("keeps the key when the email may have gone out: no answer, an answer with no id, or a request still in progress", () => {
    expect(failedAttempt(new MailerError("unavailable", "Resend could not be reached"), 1)).toBe("unavailable");
    expect(failedAttempt(new MailerError("unavailable", "Resend could not be reached"), 3)).toBe("unavailable:3");
    expect(failedAttempt(answered("unavailable", 200), 1)).toBe("unavailable");
    expect(failedAttempt(answered("rejected", 409, "concurrent_idempotent_requests"), 1)).toBe("unavailable");
    expect(failedAttempt(answered("rejected", 409, "concurrent_idempotent_requests"), 2)).toBe("unavailable:2");
  });

  it("stores a final code for a refusal, a broken setup or an unknown error, which are never retried", () => {
    expect(failedAttempt(answered("rejected", 409, "invalid_idempotent_request"), 2)).toBe("rejected");
    expect(failedAttempt(answered("rejected", 409), 1)).toBe("rejected");
    expect(failedAttempt(answered("rejected", 422, "validation_error"), 1)).toBe("rejected");
    expect(failedAttempt(new MailerError("misconfigured", "RESEND_API_KEY and MAIL_FROM must be set"), 1)).toBe("misconfigured");
    expect(failedAttempt(new Error("boom"), 2)).toBe("internal");
  });
});
