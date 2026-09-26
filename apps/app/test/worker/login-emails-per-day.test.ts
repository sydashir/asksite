import { describe, expect, it, vi } from "vitest";
import { loginEmailsPerDay } from "../../src/worker/config.ts";

/** Reads the value with console.log captured; returns the cap and the raw log lines. */
function read(value: string | undefined): { cap: number; lines: string[] } {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const cap = loginEmailsPerDay(value);
    return { cap, lines: log.mock.calls.map(([line]) => String(line)) };
  } finally {
    log.mockRestore();
  }
}

describe("LOGIN_EMAILS_PER_DAY (A11)", () => {
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["not a number", "abc"],
    ["zero", "0"],
    ["negative", "-3"],
    ["not whole", "1.5"],
    ["too large to be exact", "9".repeat(400)],
  ])("falls back to 40 when %s, with one config_invalid line naming the variable and never its value", (_case, value) => {
    const { cap, lines } = read(value);
    expect(cap).toBe(40);
    expect(lines).toEqual(['{"event":"config_invalid","variable":"LOGIN_EMAILS_PER_DAY"}']);
  });

  it("uses a valid value as it is, and logs nothing", () => {
    expect(read("7")).toEqual({ cap: 7, lines: [] });
    expect(read("40")).toEqual({ cap: 40, lines: [] });
  });
});
