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
