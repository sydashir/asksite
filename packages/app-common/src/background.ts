import { logLine } from "./http.ts";

// Work that outlives the answer or must not stop halfway. The Workers runtime may cancel a request's
// unfinished work once the client disconnects or the answer is sent, unless it was passed to
// ctx.waitUntil (developers.cloudflare.com/workers/runtime-apis/context/#waituntil).

/** The part of the Workers ExecutionContext used here (this package has no binding types). */
export interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Work that must never stop halfway, such as a spent token and the batch that uses it. The caller awaits
 * it for its answer, and waitUntil keeps it running to the end should the client disconnect first. A
 * failure reaches the caller only: the promise waitUntil keeps never rejects, so it is not reported twice.
 */
export function runToEnd<T>(ctx: WaitUntil, work: Promise<T>): Promise<T> {
  ctx.waitUntil(work.then(
    () => undefined,
    () => undefined,
  ));
  return work;
}

/** Fire-and-forget work, kept alive with waitUntil. A failure is one log line: the event and the error's class name, never its message. */
export function inBackground(ctx: WaitUntil, event: string, work: Promise<unknown>): void {
  ctx.waitUntil(work.then(
    () => undefined,
    (err: unknown) => logLine({ event, error: err instanceof Error ? err.name : "unknown" }),
  ));
}
