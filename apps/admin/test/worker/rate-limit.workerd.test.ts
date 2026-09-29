import { describe, expect, it } from "vitest";
import { accessToken, useAdminHarness } from "../support/harness.ts";

// ADMIN_RL (design §4.1): 300 requests per 60 s for each admin email. This file has its own local runtime, so a
// budget spent here never holds up another file's tests.
const h = useAdminHarness();

const LIMIT = 300;

/**
 * The local limiter counts in fixed windows aligned to the wall-clock minute (miniflare's ratelimit-object:
 * `epoch = Math.floor(Date.now() / (period * 1e3))`), so a burst that crosses :00 starts a fresh count. Before a
 * burst that must land in one window, this waits until the clock is at least 1 s past and `needMs` before a
 * minute boundary (the same helper as the app's test harness).
 */
async function awayFromMinuteBoundary(needMs: number): Promise<void> {
  const ms = Date.now() % 60_000;
  const wait = ms < 1_000 ? 1_000 - ms : ms > 60_000 - needMs ? 61_000 - ms : 0;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

/** Sends `count` requests, 25 at a time, reads each answer to the end, and returns their statuses in order. */
async function burst(count: number, send: () => Promise<Response>): Promise<number[]> {
  const statuses: number[] = [];
  while (statuses.length < count) {
    const batch = Array.from({ length: Math.min(25, count - statuses.length) }, async () => {
      const res = await send();
      await res.arrayBuffer();
      return res.status;
    });
    statuses.push(...(await Promise.all(batch)));
  }
  return statuses;
}

describe("ADMIN_RL", () => {
  // If ADMIN_RL ran before the gate, these 301 requests would spend the whole budget and the admin's own
  // request would get 429.
  it("never spends an admin's limit on requests a browser marks as from another site", async () => {
    const token = await accessToken();
    await awayFromMinuteBoundary(30_000);
    const refused = await burst(LIMIT + 1, () => h.call("GET", "/api/admin/me", { token, headers: { "Sec-Fetch-Site": "cross-site" } }));
    expect(refused).toEqual(Array.from({ length: LIMIT + 1 }, () => 403));
    const own = await h.call("GET", "/api/admin/me", { token, headers: { "Sec-Fetch-Site": "same-origin" } });
    expect(own.status).toBe(200);
  }, 120_000);
});
