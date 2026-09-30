import { afterEach, describe, expect, it, vi } from "vitest";
import { loginEmailsPerDay } from "../../src/worker/config.ts";

// The same reading as the owner app's (apps/app/test/worker/login-emails-per-day.test.ts): the admin shows the cap the app enforces.
afterEach(() => vi.restoreAllMocks());

describe("loginEmailsPerDay", () => {
  it("reads a whole number above 0, in digits only, and logs nothing", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(loginEmailsPerDay("2")).toBe(2);
    expect(loginEmailsPerDay("40")).toBe(40);
    expect(log).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "abc", "0", "-3", "1.5", " 5", "1e2", "99999999999999999999"])("gives the default 40 and logs config_invalid, never the value, for %j", (value) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(loginEmailsPerDay(value)).toBe(40);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toBe(JSON.stringify({ event: "config_invalid", variable: "LOGIN_EMAILS_PER_DAY" }));
  });
});
