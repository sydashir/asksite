import { afterEach, describe, expect, it, vi } from "vitest";
import { loginEmailsPerDay as appLoginEmailsPerDay } from "../../../app/src/worker/config.ts";
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

// The admin keeps its own copy of the reader (moderator ruling, 2026-09-30; sharing it is on the backlog), so this pins
// it to the owner app's definition, read from apps/app in this repo: same cap for every value, same log line.
describe("loginEmailsPerDay equals the owner app's", () => {
  it.each([undefined, "", "2", "40", "41", "100", "0", "-3", "1.5", " 5", "1e2", "abc", "99999999999999999999", "9007199254740991"])("gives the app's answer and the app's log for %j", (value) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const app = appLoginEmailsPerDay(value);
    const appLog = log.mock.calls.map((call) => String(call[0]));
    log.mockClear();
    expect(loginEmailsPerDay(value)).toBe(app);
    expect(log.mock.calls.map((call) => String(call[0]))).toEqual(appLog);
  });

  it("has the app's default, 40", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(appLoginEmailsPerDay(undefined)).toBe(40);
    expect(loginEmailsPerDay(undefined)).toBe(40);
  });
});
