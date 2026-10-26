import { describe, expect, it, vi } from "vitest";
import { orderEmailsPerDay } from "../src/config.ts";

const INVALID = '{"worker":"asksite-sites","event":"config_invalid","variable":"ORDER_EMAILS_PER_DAY"}';

function read(value: string | undefined): { cap: number; lines: string[] } {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const cap = orderEmailsPerDay(value);
    return { cap, lines: log.mock.calls.map(([line]) => String(line)) };
  } finally {
    log.mockRestore();
  }
}

// The shop's order-email budget (pages lane proposal 1.8), validated as LEAD_EMAILS_PER_DAY is: digits only, above 0.
describe("ORDER_EMAILS_PER_DAY", () => {
  it.each([["missing", undefined], ["empty", ""], ["zero", "0"], ["not whole", "1.5"], ["padded", " 7"], ["too large to be exact", "9".repeat(400)]])(
    "falls back to 20 when %s, with one config_invalid line naming the variable and never its value",
    (_case, value) => {
      expect(read(value)).toEqual({ cap: 20, lines: [INVALID] });
    },
  );

  it("uses a valid value as it is, and logs nothing", () => {
    expect(read("7")).toEqual({ cap: 7, lines: [] });
    expect(read("20")).toEqual({ cap: 20, lines: [] });
  });
});
