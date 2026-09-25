import { describe, expect, it, vi } from "vitest";
import { inBackground, runToEnd, type WaitUntil } from "../src/background.ts";
import * as appCommon from "../src/index.ts";

/** An ExecutionContext stand-in that keeps what waitUntil was given. */
function context(): WaitUntil & { kept: Array<Promise<unknown>> } {
  const kept: Array<Promise<unknown>> = [];
  return { kept, waitUntil: (promise) => void kept.push(promise) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Whether `promise` has settled once pending callbacks have run. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  return done;
}

/** Runs `run` with console.log captured and returns the JSON log lines it wrote. */
async function logLines(run: () => Promise<unknown>): Promise<Array<Record<string, unknown>>> {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await run();
    return log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
  } finally {
    log.mockRestore();
  }
}

describe("runToEnd", () => {
  it("keeps the work alive with waitUntil until it settles, and answers with the work's value", async () => {
    const ctx = context();
    const work = deferred<string>();
    const answer = runToEnd(ctx, work.promise);
    expect(ctx.kept).toHaveLength(1);
    expect(await settled(ctx.kept[0]!)).toBe(false);
    work.resolve("done");
    expect(await answer).toBe("done");
    expect(await settled(ctx.kept[0]!)).toBe(true);
  });

  it("gives a failure to the caller only: the promise waitUntil keeps never rejects, so it is not reported twice", async () => {
    const ctx = context();
    const work = deferred<string>();
    const answer = runToEnd(ctx, work.promise);
    const failure = new Error("batch failed");
    work.reject(failure);
    await expect(answer).rejects.toBe(failure);
    await expect(ctx.kept[0]).resolves.toBeUndefined();
  });
});

describe("inBackground", () => {
  it("keeps the work alive with waitUntil and logs nothing when it succeeds", async () => {
    const ctx = context();
    const lines = await logLines(async () => {
      inBackground(ctx, "login_link_failed", Promise.resolve("sent"));
      expect(ctx.kept).toHaveLength(1);
      await ctx.kept[0];
    });
    expect(lines).toEqual([]);
  });

  it("logs a failure as one line with the event and the error's class name, never its message", async () => {
    const ctx = context();
    const lines = await logLines(async () => {
      inBackground(ctx, "login_link_failed", Promise.reject(new TypeError("owner@private.example not found")));
      await expect(ctx.kept[0]).resolves.toBeUndefined();
    });
    expect(lines).toEqual([{ event: "login_link_failed", error: "TypeError" }]);
    expect(JSON.stringify(lines)).not.toContain("private.example");
  });

  it("names a thrown non-Error unknown", async () => {
    const ctx = context();
    const lines = await logLines(async () => {
      inBackground(ctx, "cleanup_failed", Promise.reject("a string"));
      await ctx.kept[0];
    });
    expect(lines).toEqual([{ event: "cleanup_failed", error: "unknown" }]);
  });
});

describe("app-common exports", () => {
  it("exports runToEnd, inBackground and noteLog", () => {
    expect([typeof appCommon.runToEnd, typeof appCommon.inBackground, typeof appCommon.noteLog]).toEqual(["function", "function", "function"]);
  });
});
