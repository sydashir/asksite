import { describe, expect, it } from "vitest";
import { withClock } from "../support/clock.ts";

// The test Worker's clock seam puts back the runtime's own Date.now, saved once when its module loads, never the
// clock a request found on arrival: with two overlapping pinned requests, the second one finds the first one's pin
// (moderator ruling, 2026-09-30).

/** A handler that answers only when the test lets it. */
function heldHandler() {
  let release = () => {};
  const answered = new Promise<Response>((resolve) => {
    release = () => resolve(new Response("ok"));
  });
  return { handle: () => answered, release: () => release() };
}

const pinned = (at: number) => new Request("https://admin.localhost:8788/api/admin/me", { headers: { "X-Test-Now": String(at) } });

describe("withClock", () => {
  it("pins Date.now while a request with X-Test-Now is handled, then puts the runtime's own back", async () => {
    const native = Date.now;
    let seen = 0;
    await withClock(pinned(1_000), true, async () => {
      seen = Date.now();
      return new Response("ok");
    });
    expect(seen).toBe(1_000);
    expect(Date.now).toBe(native);
  });

  it("leaves the runtime's own Date.now in place after two overlapping pinned requests, whichever ends last", async () => {
    const native = Date.now;
    try {
      const first = heldHandler();
      const second = heldHandler();
      const firstDone = withClock(pinned(1_000), true, first.handle);
      const secondDone = withClock(pinned(2_000), true, second.handle);
      first.release();
      await firstDone;
      second.release();
      await secondDone;
      expect(Date.now).toBe(native);
    } finally {
      Date.now = native;
    }
  });

  it("does not pin the clock when the hooks are off, and refuses a pin that is not a whole number", async () => {
    let seen = 0;
    await withClock(pinned(1_000), false, async () => {
      seen = Date.now();
      return new Response("ok");
    });
    expect(seen).not.toBe(1_000);
    const refused = await withClock(new Request("https://admin.localhost:8788/", { headers: { "X-Test-Now": "soon" } }), true, async () => new Response("ok"));
    expect(refused.status).toBe(400);
  });
});
