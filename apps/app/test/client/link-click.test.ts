import { describe, expect, it } from "vitest";
import { inAppPath } from "../../src/client/lib/in-app-path.ts";

// In-app links (onLinkClick, linkAfter in hooks/use-route.ts) navigate without a reload to inAppPath(url). It must keep the whole
// address after the origin: the admin's orders filters live in the query (/orders?site=…&spam=1), and a hash marks a place.

describe("inAppPath: where an in-app link goes", () => {
  it("keeps the query and the hash", () => {
    expect(inAppPath(new URL("https://admin.localhost:8788/orders?site=0b0c4f5e-6a8d-4c1e-9a3b-2f4d5e6a7b8c&spam=1#list"))).toBe(
      "/orders?site=0b0c4f5e-6a8d-4c1e-9a3b-2f4d5e6a7b8c&spam=1#list",
    );
    expect(inAppPath(new URL("https://app.localhost:8787/sites/abc/leads?page=2"))).toBe("/sites/abc/leads?page=2");
  });

  it("keeps a plain path plain, and a hash alone", () => {
    expect(inAppPath(new URL("https://app.localhost:8787/sites/abc/edit"))).toBe("/sites/abc/edit");
    expect(inAppPath(new URL("https://app.localhost:8787/login#token=x"))).toBe("/login#token=x");
  });

  it("drops the origin, so a link can never leave the app this way", () => {
    expect(inAppPath(new URL("https://app.localhost:8787/orders?x=1"))).not.toContain("localhost");
  });
});
