import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoSaver, type DraftPatch, type SaveResult, type SaverState } from "../../src/client/lib/autosave.ts";

const NO_ISSUES = { facts: [], brief: [], photos: [], document: [] };

function setup(respond: (rev: number, patch: DraftPatch) => SaveResult | Promise<SaveResult> = (rev) => ({ ok: true, rev: rev + 1, issues: NO_ISSUES })) {
  const sent: Array<{ rev: number; patch: DraftPatch }> = [];
  const states: SaverState[] = [];
  const saver = new AutoSaver(1, async (rev, patch) => {
    sent.push({ rev, patch });
    return respond(rev, patch);
  }, (s) => states.push(s));
  return { saver, sent, states };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("AutoSaver", () => {
  it("saves once, 800 ms after the last change, with the newest values", async () => {
    const { saver, sent } = setup();
    saver.change({ facts: { businessName: "J" } });
    await vi.advanceTimersByTimeAsync(500);
    saver.change({ facts: { businessName: "Joe" }, brief: { tone: "friendly" } });
    await vi.advanceTimersByTimeAsync(799);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual([{ rev: 1, patch: { facts: { businessName: "Joe" }, brief: { tone: "friendly" } } }]);
    expect(saver.currentRev).toBe(2);
  });

  it("sends one request at a time and follows up with what changed meanwhile, using the new rev", async () => {
    let release!: (r: SaveResult) => void;
    const { saver, sent } = setup((rev) => (rev === 1 ? new Promise<SaveResult>((r) => (release = r)) : { ok: true, rev: rev + 1, issues: NO_ISSUES }));
    saver.change({ facts: { a: 1 } });
    await vi.advanceTimersByTimeAsync(800);
    saver.change({ facts: { a: 2 } });
    await vi.advanceTimersByTimeAsync(800);
    expect(sent).toHaveLength(1);
    release({ ok: true, rev: 2, issues: NO_ISSUES });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([{ rev: 1, patch: { facts: { a: 1 } } }, { rev: 2, patch: { facts: { a: 2 } } }]);
  });

  it("stops on a conflict, keeps the unsaved values and reports it", async () => {
    const { saver, sent, states } = setup(() => ({ ok: false, conflict: true, message: "changed elsewhere" }));
    saver.change({ brief: { tone: "friendly" } });
    await vi.advanceTimersByTimeAsync(800);
    expect(states.at(-1)).toMatchObject({ status: "conflict" });
    saver.change({ brief: { tone: "professional" } });
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toHaveLength(1);
    expect(await saver.flush()).toBe(false);
  });

  it("flush saves immediately and reports whether everything is saved", async () => {
    const { saver, sent } = setup();
    saver.change({ facts: { a: 1 } });
    expect(await saver.flush()).toBe(true);
    expect(sent).toHaveLength(1);
    expect(await saver.flush()).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("after an error, the next change retries with everything unsaved", async () => {
    let fail = true;
    const { saver, sent, states } = setup((rev) => (fail ? { ok: false, conflict: false, message: "offline" } : { ok: true, rev: rev + 1, issues: NO_ISSUES }));
    saver.change({ facts: { a: 1 } });
    await vi.advanceTimersByTimeAsync(800);
    expect(states.at(-1)).toMatchObject({ status: "error", message: "offline" });
    fail = false;
    saver.change({ brief: { b: 2 } });
    await vi.advanceTimersByTimeAsync(800);
    expect(sent.at(-1)).toEqual({ rev: 1, patch: { facts: { a: 1 }, brief: { b: 2 } } });
    expect(states.at(-1)).toMatchObject({ status: "saved", rev: 2 });
  });
});
