import { describe, expect, it } from "vitest";
import { siteBusy } from "../src/pages.ts";

// A15 minor 6: the daily limits start again at 00:00 UTC, which is the afternoon or evening of the same
// day in the US, so the page never says "tomorrow" and Retry-After counts the seconds to 00:00 UTC.
describe("the site-busy page (a daily limit refused the form)", () => {
  it.each([
    ["2026-09-28T23:00:00.000Z", "3600"],
    ["2026-09-28T00:00:00.000Z", "86400"],
    ["2026-09-28T17:30:15.500Z", String(6 * 3600 + 29 * 60 + 45)],
    ["2026-09-28T23:59:59.001Z", "1"],
  ])("at %s asks the visitor to retry after %s seconds (the next 00:00 UTC)", (at, seconds) => {
    expect(siteBusy("asksite.example", Date.parse(at)).headers.get("retry-after")).toBe(seconds);
  });

  it("points the visitor to the phone number and never promises a time it cannot keep", async () => {
    const response = siteBusy("asksite.example", Date.parse("2026-09-28T12:00:00.000Z"));
    expect(response.status).toBe(429);
    const body = await response.text();
    expect(body).toContain("<h1>Please call instead</h1>");
    expect(body).toContain("<p>This form cannot take more messages for now. The business's phone number is on the website.</p>");
    expect(body).not.toMatch(/tomorrow|today|tonight/i);
  });
});
