import type { SiteView } from "@asksite/core";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSite, type SiteState } from "../../src/client/hooks/use-site.ts";

// STRICT (customer data): useSite.reload saves first and never replaces the draft after a failed save. This drives the real hook;
// no screen reaches reload with a failed save today, so only a hook-level test can fail if the guard's wiring is removed.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VIEW = { rev: 1, facts: {}, brief: {}, edits: {}, ai: null, issues: { facts: [], brief: [], photos: [], document: [] } } as unknown as SiteView;

afterEach(() => vi.unstubAllGlobals());

describe("useSite.reload", () => {
  it("keeps the draft and fetches nothing when the save before it failed", async () => {
    const gets: string[] = [];
    vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
      if (init.method === "GET") {
        gets.push(path);
        return new Response(JSON.stringify(VIEW), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { code: "internal", message: "no" } }), { status: 500 });
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
    expect(gets).toHaveLength(1);

    act(() => site.update(() => ({ facts: { typed: "unsaved" } })));
    let reloaded: SiteView | null | undefined;
    await act(async () => {
      reloaded = await site.reload();
    });

    expect(site.saver.status).toBe("error");
    expect(reloaded).toBeNull();
    expect(gets).toHaveLength(1);
    expect(site.draft?.facts).toEqual({ typed: "unsaved" });
    await act(async () => root.unmount());
  });
});
