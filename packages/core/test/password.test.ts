import { describe, expect, it } from "vitest";
import { DUMMY_PASSWORD_HASH, hashPassword, PasswordLoginBody, PasswordSignupBody, passwordKeys, PBKDF2_ITERATIONS, SetPasswordBody } from "../src/index.ts";

// Made-up test passwords only.
const PASSWORD = "correct horse battery";

const same = (a: Uint8Array, b: Uint8Array): boolean => a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);

describe("password hashing", () => {
  // Production workerd refuses more than 100,000 PBKDF2 iterations (limit-enforcer.h), and local workerd has no limit, so only this pin catches a higher count.
  it("uses 100,000 PBKDF2 iterations, never more than production Workers allow", () => {
    expect(PBKDF2_ITERATIONS).toBe(100_000);
    expect(PBKDF2_ITERATIONS).toBeLessThanOrEqual(100_000);
  });

  it("stores a versioned hash with a 16-byte salt and a 32-byte key, never the password, and a new salt every time", async () => {
    const stored = await hashPassword(PASSWORD);
    const [scheme, iterations, salt, key, ...rest] = stored.split("$");
    expect({ scheme, iterations, rest }).toEqual({ scheme: "pbkdf2-sha256", iterations: "100000", rest: [] });
    expect(atob(salt ?? "")).toHaveLength(16);
    expect(atob(key ?? "")).toHaveLength(32);
    expect(stored).not.toContain(PASSWORD);
    expect(await hashPassword(PASSWORD)).not.toBe(stored);
  });

  it("derives the stored key from the right password only", async () => {
    const stored = await hashPassword(PASSWORD);
    const right = await passwordKeys(PASSWORD, stored);
    expect(right.valid).toBe(true);
    expect(same(right.derived, right.expected)).toBe(true);
    const wrong = await passwordKeys("correct horse battery!", stored);
    expect(same(wrong.derived, wrong.expected)).toBe(false);
    // The same characters composed differently (é as one code point, or e plus an accent) are the same password.
    const accented = await hashPassword("caf\u00e9 au lait 1");
    const decomposed = await passwordKeys("cafe\u0301 au lait 1", accented);
    expect(same(decomposed.derived, decomposed.expected)).toBe(true);
  });

  it("checks a value that is not a stored hash, and the dummy, as the dummy, and marks them not valid", async () => {
    for (const stored of [DUMMY_PASSWORD_HASH, "", PASSWORD, "pbkdf2-sha256$200000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="]) {
      const keys = await passwordKeys(PASSWORD, stored);
      expect(keys.valid).toBe(false);
      expect(keys.expected).toEqual(new Uint8Array(32));
    }
  });
});

describe("password bodies", () => {
  it("need 10 to 128 characters for a new password, keep it untrimmed, and accept any typed one up to 128", () => {
    expect(PasswordSignupBody.safeParse({ email: "a@example.com", password: "x".repeat(9) }).success).toBe(false);
    expect(PasswordSignupBody.safeParse({ email: "a@example.com", password: "x".repeat(129) }).success).toBe(false);
    expect(PasswordSignupBody.parse({ email: " a@example.com ", password: " ten chars " })).toEqual({ email: "a@example.com", password: " ten chars " });
    expect(PasswordLoginBody.safeParse({ email: "a@example.com", password: "short" }).success).toBe(true);
    expect(PasswordLoginBody.safeParse({ email: "a@example.com", password: "" }).success).toBe(false);
    expect(SetPasswordBody.safeParse({ newPassword: "x".repeat(10) }).success).toBe(true);
    expect(SetPasswordBody.safeParse({ currentPassword: "old", newPassword: "x".repeat(128) }).success).toBe(true);
  });
});
