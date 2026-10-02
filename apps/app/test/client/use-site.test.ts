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
async function mount(later: (method: string) => Response) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (_path: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    calls.push(method);
    return calls.filter((c) => c === "GET").length === 1 && method === "GET" ? json(VIEW) : later(method);
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
