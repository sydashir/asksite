// The test Worker's clock seam. Only test/support/test-worker.ts uses it, and clock-seam.test.ts proves that no
// production file can reach it or that file. No Cloudflare types, so the Node test program tests it (clock.test.ts).

/**
 * The runtime's own Date.now, saved once when this module loads (moderator ruling, 2026-09-30). A request puts this
 * back when it ends, never the clock it found on arrival: while an earlier pinned request still runs, that is the
 * earlier request's pin, and putting it back would leave the clock frozen for every later request.
 */
const nativeNow = Date.now;

/**
 * An injected clock for Date.now() only (new Date() keeps the real time): while the Worker handles a request
 * that carries `X-Test-Now: <ms>`, Date.now() answers that value, so a test can send two requests in the same
 * millisecond. Overlapping pinned requests share the one clock (the later pin wins, and the first to end puts the
 * runtime's own back for both), so tests send pinned requests one at a time. `enabled` is the test hooks' own
 * rule: local development, on a *.localhost host.
 */
export async function withClock(request: Request, enabled: boolean, handle: () => Promise<Response>): Promise<Response> {
  const pinned = request.headers.get("X-Test-Now");
  if (pinned === null || !enabled) return handle();
  const at = Number(pinned);
  if (!Number.isSafeInteger(at)) return new Response("X-Test-Now must be a whole number of milliseconds", { status: 400 });
  Date.now = () => at;
  try {
    return await handle();
  } finally {
    Date.now = nativeNow;
  }
}
