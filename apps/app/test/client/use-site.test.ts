import type { SiteView } from "@asksite/core";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSite, type SiteState } from "../../src/client/hooks/use-site.ts";

// STRICT (customer data): these drive the real hook. No screen reaches reload with a failed save today, so only a hook-level
// test can fail if the guard's wiring is removed; an unreadable answer must be a failure the caller can see, never a throw.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VIEW = { rev: 1, facts: {}, brief: {}, edits: {}, ai: null, issues: { facts: [], brief: [], photos: [], document: [] } } as unknown as SiteView;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Mounts the hook with a fake fetch; the first GET is the load, `later` answers every request after it. */
async function mount(later: (method: string, init: RequestInit) => Response | Promise<Response>, first: SiteView = VIEW) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (_path: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    calls.push(method);
    return calls.filter((c) => c === "GET").length === 1 && method === "GET" ? json(first) : later(method, init);
  });
  // React reads window.event to rank updates, and the active element when it commits.
  vi.stubGlobal("window", { event: undefined, document: { activeElement: null }, HTMLIFrameElement: class {} });
  let site!: SiteState;
  const Probe = () => {
    site = useSite("s1");
    return null;
  };
  // A container React can mount into without a DOM: the probe renders nothing.
  const doc = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
  const container = { nodeType: 1, nodeName: "DIV", tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml", ownerDocument: doc, addEventListener() {}, removeEventListener() {} } as unknown as Element;
  const root = createRoot(container);
  await act(async () => root.render(createElement(Probe)));
  return { calls, site: () => site, unmount: () => act(async () => root.unmount()) };
}

describe("useSite.reload", () => {
  it("keeps the draft and fetches nothing when the save before it failed", async () => {
    const { calls, site, unmount } = await mount(() => json({ error: { code: "internal", message: "no" } }, 500));
    act(() => site().update(() => ({ facts: { typed: "unsaved" } })));
    let reloaded: SiteView | null | undefined;
    await act(async () => {
      reloaded = await site().reload();
    });

    expect(site().saver.status).toBe("error");
    expect(reloaded).toBeNull();
    expect(calls.filter((c) => c === "GET")).toHaveLength(1);
    expect(site().draft?.facts).toEqual({ typed: "unsaved" });
    await unmount();
  });
});

describe("useSite.refreshAi", () => {
  it.each([
    ["is not JSON", () => new Response("<html>not json</html>", { status: 200 })],
    ["is JSON but not a site", () => json({ ok: true })],
  ])("answers false, after one more try, when the answer %s; it never throws", async (_name, answer) => {
    const { calls, site, unmount } = await mount(answer);
    vi.useFakeTimers();
    let refreshed: boolean | undefined;
    await act(async () => {
      const pending = site().refreshAi();
      await vi.advanceTimersByTimeAsync(5_000);
      refreshed = await pending;
    });
    expect(refreshed).toBe(false);
    expect(calls.filter((c) => c === "GET")).toHaveLength(3); // the load, the try, the one retry
    await unmount();
  });
});

// Handoff 1b: the issues of the view that brought new wording are the newest the editor has (AI-claim issues are computed on the
// AI wording, so the old wording's would otherwise stay on screen until the next save).
describe("useSite.refreshAi issues", () => {
  it("takes the issues of the view it refreshed from", async () => {
    const claim = { path: ["copy", "heroSubheadline"], code: "ai_claim", message: "“free” isn't backed by your answers. Edit this wording or update your answers." };
    const first = { ...VIEW, ai: { generationId: "g1", draft: { copy: {} } }, edits: { theme: null }, limits: { generationsLeftToday: 1, generationsLeftTotal: 1 }, issues: { facts: [], brief: [], photos: [], document: [claim] } } as unknown as SiteView;
    const fresh = { ...first, ai: { generationId: "g2", draft: { copy: {} } }, issues: { facts: [], brief: [], photos: [], document: [] } } as unknown as SiteView;
    const { site, unmount } = await mount(() => json(fresh), first);
    const loaded = site().load;
    expect(loaded.state === "ready" ? loaded.view.issues.document : null).toEqual([claim]);
    await act(async () => {
      expect(await site().refreshAi()).toBe(true);
    });
    const load = site().load;
    expect(load.state === "ready" ? load.view.issues : null).toEqual({ facts: [], brief: [], photos: [], document: [] });
    await unmount();
  });
});

// STRICT (customer data): the server refuses a wording or order change built on an older AI draft (wording_changed). The hook must
// not loop on it, must keep the owner's hidden sections and look, and must say the wording change did not apply.
const NO_ISSUES = { facts: [], brief: [], photos: [], document: [] };
const seenBy = (generationId: string, edits: object) =>
  ({
    ...VIEW,
    ai: { generationId, draft: { copy: {} } },
    edits: { baseGenerationId: generationId, copy: {}, order: null, hidden: [], theme: null, ...edits },
    limits: { generationsLeftToday: 1, generationsLeftTotal: 1 },
  }) as unknown as SiteView;

describe("useSite wording_changed", () => {
  it("refreshes the AI wording, saves the rest on the new wording without the stale wording, and says so", async () => {
    const patches: Array<{ rev: number; edits: Record<string, unknown> }> = [];
    const { site, unmount } = await mount((method, init) => {
      if (method !== "PATCH") return json(seenBy("g2", {}));
      patches.push(JSON.parse(String(init.body)));
      return patches.length === 1 ? json({ error: { code: "wording_changed", message: "New wording arrived." } }, 409) : json({ rev: 2, issues: NO_ISSUES });
    }, seenBy("g1", { hidden: ["gallery"] }));
    act(() => site().update((current) => ({ edits: { ...current.edits, copy: { ctaText: "Mine" } } })));
    await act(async () => {
      await site().flush();
    });

    expect(patches).toHaveLength(2);
    expect(patches[0]?.edits).toMatchObject({ baseGenerationId: "g1", copy: { ctaText: "Mine" } });
    expect(patches[1]).toMatchObject({ rev: 1, edits: { baseGenerationId: "g2", copy: {}, order: null, hidden: ["gallery"] } });
    expect(site().saver).toMatchObject({ status: "saved", rev: 2, wordingDropped: true });
    await unmount();
  });

  it("does not send wording left over from an older AI draft with a hidden or look change", async () => {
    const patches: Array<{ edits: Record<string, unknown> }> = [];
    const stale = { ...seenBy("g2", { hidden: [] }), edits: { baseGenerationId: "g1", copy: { ctaText: "Old" }, order: null, hidden: [], theme: null } } as unknown as SiteView;
    const { site, unmount } = await mount((_method, init) => {
      patches.push(JSON.parse(String(init.body)));
      return json({ rev: 2, issues: NO_ISSUES });
    }, stale);
    act(() => site().update((current) => ({ edits: { ...current.edits, hidden: ["gallery"] } })));
    await act(async () => {
      await site().flush();
    });

    expect(patches).toHaveLength(1);
    expect(patches[0]?.edits).toEqual({ baseGenerationId: "g2", copy: {}, order: null, hidden: ["gallery"], theme: null });
    expect(site().saver).toMatchObject({ status: "saved" });
    expect(site().saver.wordingDropped).toBeUndefined();
    await unmount();
  });
});

// STRICT (customer data): the [409, 200, 200] shape. The refused wording change is told even when another change is saved in the same run.
describe("useSite wording_changed with another change in the same run", () => {
  it("keeps the notice through the later save, and the first leaving action answers 'dropped'", async () => {
    const patches: Array<Record<string, unknown>> = [];
    let release!: () => void;
    const { site, unmount } = await mount((method, init) => {
      if (method !== "PATCH") return json(seenBy("g2", {}));
      patches.push(JSON.parse(String(init.body)));
      if (patches.length === 1) return new Promise<Response>((resolve) => (release = () => resolve(json({ error: { code: "wording_changed", message: "New wording arrived." } }, 409))));
      return json({ rev: patches.length, issues: NO_ISSUES });
    }, seenBy("g1", {}));
    act(() => site().update((current) => ({ edits: { ...current.edits, copy: { ctaText: "Mine" } } })));
    let result: boolean | "dropped" | undefined;
    await act(async () => {
      const flushing = site().flush();
      await Promise.resolve();
      site().update(() => ({ facts: { typed: "while saving" } }));
      release();
      result = await flushing;
    });

    expect(patches).toHaveLength(3);
    expect(site().saver).toMatchObject({ status: "saved", wordingDropped: true });
    expect(result).toBe("dropped");
    await unmount();
  });
});

// STRICT (customer data), R2: a drop, then a conflict in the same run. The conflict's Reload replaces the saver, so the notice the owner
// has not seen must be carried to the new one.
describe("useSite.reload after a dropped wording change", () => {
  it("carries the unseen notice to the reloaded draft, when the run went on to a conflict", async () => {
    let patches = 0;
    const { site, unmount } = await mount((method) => {
      if (method !== "PATCH") return json(seenBy("g2", {}));
      patches += 1;
      if (patches === 1) return json({ error: { code: "wording_changed", message: "New wording arrived." } }, 409);
      if (patches === 2) return json({ rev: 2, issues: NO_ISSUES });
      return json({ error: { code: "conflict", message: "Changed elsewhere." } }, 409);
    }, seenBy("g1", {}));
    act(() => site().update((current) => ({ edits: { ...current.edits, copy: { ctaText: "Mine" } } })));
    await act(async () => {
      await site().retry();
    });
    expect(site().saver).toMatchObject({ status: "saved", wordingDropped: true });
    act(() => site().update(() => ({ facts: { typed: "later" } })));
    await act(async () => {
      await site().retry();
    });
    expect(site().saver.status).toBe("conflict");

    await act(async () => {
      await site().reload();
    });
    expect(site().saver).toMatchObject({ status: "idle", wordingDropped: true });
    await unmount();
  });
});

// STRICT (customer data), round 4: one drop stops a leave ONCE, also across an in-page reload (the address Save and a conflict's Reload
// replace the saver). The reload carries the flag AND the fact that the owner was stopped already.
describe("useSite.flush across an in-page reload", () => {
  it("stops once for one drop: dropped, reload, then the next flush goes on", async () => {
    let patches = 0;
    const { site, unmount } = await mount((method) => {
      if (method !== "PATCH") return json(seenBy("g2", {}));
      patches += 1;
      return patches === 1 ? json({ error: { code: "wording_changed", message: "New wording arrived." } }, 409) : json({ rev: patches, issues: NO_ISSUES });
    }, seenBy("g1", {}));
    act(() => site().update((current) => ({ edits: { ...current.edits, copy: { ctaText: "Mine" } } })));
    const results: Array<boolean | "dropped" | undefined> = [];
    await act(async () => {
      results.push(await site().flush());
      await site().reload();
      results.push(await site().flush());
    });
    expect(results).toEqual(["dropped", true]);
    expect(site().saver.wordingDropped).toBeUndefined();
    await unmount();
  });
});

// R5 (the f4 review's U-2 probe): a change typed while an edits-bearing save is being refused is dropped TOGETHER with the reset, so the
// screen equals what is stored and nothing is sent later behind the owner's back (the rewrite may have ended by then).
describe("useSite generation_in_progress drops the queued changes with the reset", () => {
  it("does not store a change typed while the refused save was in flight, and the screen shows the stored value", async () => {
    const patches: Array<Record<string, unknown>> = [];
    const running = { id: "gen-2", kind: "regenerate", status: "running" };
    const first = { ...seenBy("g1", { copy: { heroHeadline: "Saved" } }), facts: { phone: "+15125550142" } } as unknown as SiteView;
    const stored = { ...first, activeGeneration: running } as unknown as SiteView;
    let release!: () => void;
    const { site, unmount } = await mount((method, init) => {
      if (method !== "PATCH") return json(stored);
      patches.push(JSON.parse(String(init.body)));
      if (patches.length === 1) {
        return new Promise<Response>((resolve) => {
          release = () => resolve(json({ error: { code: "generation_in_progress", message: "New wording is being written." } }, 409));
        });
      }
      return json({ rev: 2, issues: NO_ISSUES }); // the rewrite has ended just now: a second save would be accepted
    }, first);
    act(() => site().update((current) => ({ edits: { ...current.edits, hidden: ["gallery"] } })));
    await act(async () => {
      const saving = site().retry();
      await vi.waitFor(() => {
        if (patches.length !== 1) throw new Error("the first save is not sent yet");
      });
      site().update((current) => ({ facts: { ...(current.facts as object), phone: "+15125558888" } }));
      release();
      await saving;
    });
    await act(async () => {
      await site().retry();
    });
    expect(patches).toHaveLength(1);
    expect((site().draft?.facts as { phone?: string }).phone).toBe("+15125550142");
    expect(site().saver).toMatchObject({ wordingDropped: true, droppedWhileWriting: true });
    await unmount();
  });
});

// STRICT (customer data), round 4: while new wording is written the server refuses a save that carries edits (generation_in_progress; answer and brief saves are stored). The hook must NEVER
// send the refused change again (the old retry with the wording stripped erased the owner's saved wording), must put the draft back to what
// the server holds, must name the running rewrite so the editor locks, and must say exactly why nothing was saved.
describe("useSite generation_in_progress", () => {
  it("sends the refused save once, shows what the server holds, names the rewrite, and says the change was not saved", async () => {
    const patches: Array<{ edits: Record<string, unknown> }> = [];
    const running = { id: "gen-2", kind: "regenerate", status: "queued" };
    const stored = { ...seenBy("g1", { copy: { heroHeadline: "Saved" } }), activeGeneration: running } as unknown as SiteView;
    const { site, unmount } = await mount((method, init) => {
      if (method !== "PATCH") return json(stored);
      patches.push(JSON.parse(String(init.body)));
      return json({ error: { code: "generation_in_progress", message: "New wording is being written." } }, 409);
    }, seenBy("g1", { copy: { heroHeadline: "Saved" } }));
    act(() => site().update((current) => ({ edits: { ...current.edits, hidden: ["gallery"], copy: { heroHeadline: "Saved" } } })));
    let result: boolean | "dropped" | undefined;
    await act(async () => {
      result = await site().flush();
      await site().retry();
    });

    expect(patches).toHaveLength(1);
    expect(site().draft?.edits).toMatchObject({ copy: { heroHeadline: "Saved" }, hidden: [] });
    expect(site().saver).toMatchObject({ rev: 1, wordingDropped: true, droppedWhileWriting: true });
    expect(site().saver.status).not.toBe("error");
    const loaded = site().load;
    expect(loaded.state === "ready" ? loaded.view.activeGeneration : null).toMatchObject({ id: "gen-2", kind: "regenerate" });
    expect(result).toBe("dropped");
    await unmount();
  });

  it("answers an ordinary failure, and keeps the change as unsaved, when the server's view cannot be read", async () => {
    const patches: unknown[] = [];
    const { site, unmount } = await mount((method, init) => {
      if (method !== "PATCH") return new Response("<html>nope</html>", { status: 200 });
      patches.push(init.body);
      return json({ error: { code: "generation_in_progress", message: "New wording is being written." } }, 409);
    }, seenBy("g1", {}));
    vi.useFakeTimers();
    act(() => site().update((current) => ({ edits: { ...current.edits, hidden: ["gallery"] } })));
    await act(async () => {
      const saving = site().retry();
      await vi.advanceTimersByTimeAsync(5_000);
      await saving;
    });
    expect(patches).toHaveLength(1);
    expect(site().saver.status).toBe("error");
    expect(site().draft?.edits).toMatchObject({ hidden: ["gallery"] });
    await unmount();
  });
});
