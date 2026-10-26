import { afterEach, describe, expect, it, vi } from "vitest";
import { linkAfter, onLinkClick } from "../../src/client/hooks/use-route.ts";

// In-app links navigate without a reload. They must keep the whole address after the path: the admin's orders filters live in
// the query (/orders?site=…&spam=1), and a hash marks a place on a page.

type LinkEvent = Parameters<typeof onLinkClick>[0];

function click(href: string, keys: { metaKey?: boolean; button?: number } = {}): LinkEvent & { preventDefault: ReturnType<typeof vi.fn> } {
  return {
    button: keys.button ?? 0,
    metaKey: keys.metaKey ?? false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    currentTarget: { href },
  } as unknown as LinkEvent & { preventDefault: ReturnType<typeof vi.fn> };
}

function stubNavigation() {
  const pushState = vi.fn();
  vi.stubGlobal("history", { pushState, replaceState: vi.fn() });
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  return pushState;
}

afterEach(() => vi.unstubAllGlobals());

describe("onLinkClick", () => {
  it("keeps the query and the hash", () => {
    const pushState = stubNavigation();
    const event = click("https://admin.localhost:8788/orders?site=0b0c4f5e-6a8d-4c1e-9a3b-2f4d5e6a7b8c&spam=1#list");
    onLinkClick(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(pushState).toHaveBeenCalledWith(null, "", "/orders?site=0b0c4f5e-6a8d-4c1e-9a3b-2f4d5e6a7b8c&spam=1#list");
  });

  it("keeps a plain path plain", () => {
    const pushState = stubNavigation();
    onLinkClick(click("https://app.localhost:8787/sites/abc/edit"));
    expect(pushState).toHaveBeenCalledWith(null, "", "/sites/abc/edit");
  });

  it("leaves a modified or non-left click to the browser", () => {
    const pushState = stubNavigation();
    const withMeta = click("https://admin.localhost:8788/orders?site=x", { metaKey: true });
    onLinkClick(withMeta);
    onLinkClick(click("https://admin.localhost:8788/orders?site=x", { button: 1 }));
    expect(withMeta.preventDefault).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
  });
});

describe("linkAfter", () => {
  it("keeps the query and the hash once the save is done", async () => {
    const pushState = stubNavigation();
    linkAfter(async () => true, vi.fn())(click("https://app.localhost:8787/sites/abc/leads?page=2#top"));
    await vi.waitFor(() => expect(pushState).toHaveBeenCalledWith(null, "", "/sites/abc/leads?page=2#top"));
  });
});
