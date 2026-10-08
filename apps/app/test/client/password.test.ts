import { PasswordSignupBody } from "@asksite/core";
import { describe, expect, it } from "vitest";
import { NEW_PASSWORD_HINT, passwordProblem } from "../../src/client/lib/password.ts";

// The page checks a new password as the Worker does (10 to 128 code points), before it sends anything.
describe("passwordProblem", () => {
  it("accepts 10 to 128 characters, counted as the Worker counts them, and says what to fix otherwise", () => {
    expect(NEW_PASSWORD_HINT).toBe("At least 10 characters.");
    for (const password of ["x".repeat(9), "\u{1F511}".repeat(9), "", "x".repeat(10), "\u{1F511}".repeat(10), "x".repeat(128), "x".repeat(129)]) {
      const valid = PasswordSignupBody.safeParse({ email: "a@example.com", password }).success;
      expect(passwordProblem(password) === null).toBe(valid);
    }
    expect(passwordProblem("short")).toBe("Use at least 10 characters.");
    expect(passwordProblem("x".repeat(129))).toBe("Use 128 characters or fewer.");
  });
});
