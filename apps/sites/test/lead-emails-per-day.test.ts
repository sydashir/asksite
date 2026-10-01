import { describe, expect, it, vi } from "vitest";
import { leadEmailsPerDay } from "../src/config.ts";

const INVALID = '{"worker":"asksite-sites","event":"config_invalid","variable":"LEAD_EMAILS_PER_DAY"}';

/** Reads the value with console.log captured; returns the cap and the raw log lines. */
function read(value: string | undefined): { cap: number; lines: string[] } {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const cap = leadEmailsPerDay(value);
    return { cap, lines: log.mock.calls.map(([line]) => String(line)) };
  } finally {
    log.mockRestore();
  }
}

// Validated like Plan 4's LOGIN_EMAILS_PER_DAY (A11c): a whole number above 0, in digits only.
describe("LEAD_EMAILS_PER_DAY (A11c)", () => {
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["not a number", "abc"],
    ["zero", "0"],
    ["negative", "-3"],
    ["not whole", "1.5"],
    ["too large to be exact", "9".repeat(400)],
  ])("falls back to 40 when %s, with one config_invalid line naming the variable and never its value", (_case, value) => {
    expect(read(value)).toEqual({ cap: 40, lines: [INVALID] });
  });

  // Number() would read each of these as 7; only digits count, so a hand-edited value with a stray
  // character is noticed in the log instead of silently changing the cap.
  it.each([" 7", "7 ", "+7", "7e0", "0x7"])("reads digits only: %j falls back to 40 with one config_invalid line", (value) => {
    expect(read(value)).toEqual({ cap: 40, lines: [INVALID] });
  });

  it("uses a valid value as it is, and logs nothing", () => {
    expect(read("7")).toEqual({ cap: 7, lines: [] });
    expect(read("40")).toEqual({ cap: 40, lines: [] });
  });
});
