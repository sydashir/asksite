import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoSaver, mayReplaceDraft, type DraftPatch, type SaveResult, type SaverState } from "../../src/client/lib/autosave.ts";

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

  it("after a failed save, what was typed meanwhile wins over the failed value for the same key", async () => {
    let release!: (r: SaveResult) => void;
    let calls = 0;
    const { saver, sent } = setup((rev) => (++calls === 1 ? new Promise<SaveResult>((r) => (release = r)) : { ok: true, rev: rev + 1, issues: NO_ISSUES }));
    saver.change({ facts: { businessName: "Old name" } });
    await vi.advanceTimersByTimeAsync(800);
    expect(sent).toHaveLength(1);
    saver.change({ facts: { businessName: "Newer name" } });
    release({ ok: false, conflict: false, message: "offline" });
    await vi.advanceTimersByTimeAsync(0);
    expect(await saver.flush()).toBe(true);
    expect(sent.at(-1)).toEqual({ rev: 1, patch: { facts: { businessName: "Newer name" } } });
  });

  it("a send that rejects is an error: the patch stays, flush says false, and the next change sends it again", async () => {
    let calls = 0;
    const { saver, sent, states } = setup((rev) => {
      if (++calls === 1) throw new Error("socket closed");
      return { ok: true, rev: rev + 1, issues: NO_ISSUES };
    });
    saver.change({ facts: { a: 1 } });
    await vi.advanceTimersByTimeAsync(800);
    expect(states.at(-1)).toEqual({ status: "error", rev: 1, message: "Something went wrong. Please try again." });
    saver.change({ brief: { b: 2 } });
    await vi.advanceTimersByTimeAsync(800);
    expect(sent.at(-1)).toEqual({ rev: 1, patch: { facts: { a: 1 }, brief: { b: 2 } } });
    expect(states.at(-1)).toMatchObject({ status: "saved", rev: 2 });
  });

  it("flush after a rejected send resolves false, and true once a retry saves", async () => {
    let fail = true;
    const { saver } = setup((rev) => {
      if (fail) throw new Error("socket closed");
      return { ok: true, rev: rev + 1, issues: NO_ISSUES };
    });
    saver.change({ facts: { a: 1 } });
    expect(await saver.flush()).toBe(false);
    fail = false;
    expect(await saver.flush()).toBe(true);
  });

  it("flush with nothing pending resolves true", async () => {
    const { saver, sent } = setup();
    expect(await saver.flush()).toBe(true);
    expect(sent).toEqual([]);
  });

  it("dispose drops the timer: a change made before it is never sent", async () => {
    const { saver, sent } = setup();
    saver.change({ facts: { a: 1 } });
    saver.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toEqual([]);
  });
});

// STRICT (customer data): a reload never replaces the draft after a failed save.
describe("mayReplaceDraft", () => {
  it("replaces only after a full save or a conflict, never after a failed save", () => {
    expect(mayReplaceDraft(true, "saved")).toBe(true);
    expect(mayReplaceDraft(false, "conflict")).toBe(true);
    expect(mayReplaceDraft(false, "error")).toBe(false);
    expect(mayReplaceDraft(false, "pending")).toBe(false);
  });
});

// STRICT (customer data): a save that applied everything but the owner's wording change (wordingDropped) must be told to the owner,
// however many saves follow it, and must stop one leaving action (flush says "dropped") so the owner sees it before going.
describe("AutoSaver wording notice", () => {
  const droppedFirst = (): ((rev: number) => SaveResult) => {
    let calls = 0;
    return (rev) => ({ ok: true, rev: rev + 1, issues: NO_ISSUES, ...(++calls === 1 ? { wordingDropped: true as const } : {}) });
  };

  it("survives a later save in the same run: no state after the drop is without it, and the last one is 'saved'", async () => {
    let release!: (r: SaveResult) => void;
    let calls = 0;
    const { saver, states } = setup((rev) => (++calls === 1 ? new Promise<SaveResult>((r) => (release = r)) : { ok: true, rev: rev + 1, issues: NO_ISSUES }));
    saver.change({ edits: {} as never });
    await vi.advanceTimersByTimeAsync(800);
    saver.change({ facts: { typed: "meanwhile" } });
    release({ ok: true, rev: 2, issues: NO_ISSUES, wordingDropped: true });
    await vi.advanceTimersByTimeAsync(800);
    const afterDrop = states.slice(states.findIndex((s) => s.wordingDropped === true));
    expect(afterDrop.length).toBeGreaterThanOrEqual(2);
    expect(afterDrop.every((s) => s.wordingDropped === true)).toBe(true);
    expect(states.at(-1)).toMatchObject({ status: "saved", wordingDropped: true });
  });

  it("flush answers 'dropped' once; the next attempt proceeds and clears the notice", async () => {
    const { saver, states } = setup(droppedFirst());
    saver.change({ facts: { a: 1 } });
    expect(await saver.flush()).toBe("dropped");
    expect(states.at(-1)?.wordingDropped).toBe(true);
    expect(await saver.flush()).toBe(true);
    expect(states.at(-1)?.wordingDropped).toBeUndefined();
    expect(await saver.flush()).toBe(true);
  });

  it("dismissing the notice clears it, and the next flush proceeds at once", async () => {
    const { saver, states } = setup(droppedFirst());
    saver.change({ facts: { a: 1 } });
    await saver.flush();
    saver.acknowledgeDrop();
    expect(states.at(-1)?.wordingDropped).toBeUndefined();
    expect(await saver.flush()).toBe(true);
  });

  it("saveNow (Try again) neither stops nor clears the notice", async () => {
    const { saver, states } = setup(droppedFirst());
    saver.change({ facts: { a: 1 } });
    expect(await saver.saveNow()).toBe(true);
    expect(states.at(-1)?.wordingDropped).toBe(true);
    expect(await saver.flush()).toBe("dropped");
  });

  it("a failed save answers false, not 'dropped', and keeps the stop for later", async () => {
    let fail = false;
    const ok = droppedFirst();
    const { saver } = setup((rev, patch) => (fail ? { ok: false, conflict: false, message: "offline" } : ok(rev)));
    saver.change({ facts: { a: 1 } });
    await saver.saveNow();
    fail = true;
    saver.change({ facts: { a: 2 } });
    expect(await saver.flush()).toBe(false);
    fail = false;
    expect(await saver.flush()).toBe("dropped");
  });

  // R1: a double click runs two flushes over one save. Both are "already in flight" when the drop is found, so both stop; the second
  // never reads the first's stop as "the owner has seen it".
  it("two flushes over one in-flight save that drops the wording both answer 'dropped', and the next attempt goes on", async () => {
    let release!: (r: SaveResult) => void;
    const { saver } = setup(() => new Promise<SaveResult>((r) => (release = r)));
    saver.change({ facts: { a: 1 } });
    const first = saver.flush();
    const second = saver.flush();
    await Promise.resolve();
    release({ ok: true, rev: 2, issues: NO_ISSUES, wordingDropped: true });
    expect([await first, await second]).toEqual(["dropped", "dropped"]);
    expect(await saver.flush()).toBe(true);
  });

  // STRICT (customer data), the drop epoch: a drop the owner has seen lets the second attempt go on, but a NEW drop found by that very
  // flush is unseen, so that flush answers "dropped" too (edit-binding-guard-brief.md R1 and G2).
  it("a second attempt whose own save finds a NEW drop answers 'dropped'; only then does the next attempt go on", async () => {
    let calls = 0;
    const { saver, states } = setup((rev) => ({ ok: true, rev: rev + 1, issues: NO_ISSUES, ...(++calls <= 2 ? { wordingDropped: true as const } : {}) }));
    saver.change({ facts: { a: 1 } });
    expect(await saver.flush()).toBe("dropped");
    saver.change({ facts: { a: 2 } });
    expect(await saver.flush()).toBe("dropped");
    expect(states.at(-1)?.wordingDropped).toBe(true);
    expect(await saver.flush()).toBe(true);
    expect(states.at(-1)?.wordingDropped).toBeUndefined();
  });

  // STRICT (customer data), the drop epoch on the OTHER drop path: a second attempt whose own save is REFUSED while new wording is being
  // written (generation_in_progress, SaveResult.refused) has found a NEW drop too, so it answers "dropped"; only the next attempt goes on.
  it("a second attempt whose own save is refused while new wording is written (a NEW drop) answers 'dropped'; only then does the next attempt go on", async () => {
    let calls = 0;
    const { saver, states } = setup((rev) => (++calls === 1 ? { ok: true, rev: rev + 1, issues: NO_ISSUES, wordingDropped: true } : { ok: false, conflict: false, message: "New wording is being written.", refused: true }));
    saver.change({ facts: { a: 1 } });
    expect(await saver.flush()).toBe("dropped");
    saver.change({ facts: { a: 2 } });
    expect(await saver.flush()).toBe("dropped");
    expect(states.at(-1)?.wordingDropped).toBe(true);
    expect(states.at(-1)?.droppedWhileWriting).toBe(true);
    expect(await saver.flush()).toBe(true);
    expect(states.at(-1)?.wordingDropped).toBeUndefined();
  });
});
