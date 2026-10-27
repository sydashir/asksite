import type { SiteShopStatus } from "@asksite/core";
import { describe, expect, it } from "vitest";
import {
  addressLines,
  buyerMailto,
  emailLine,
  emptyOrdersText,
  ordersPath,
  ordersRequest,
  readOrdersFilters,
  orderBlocker,
  resumedText,
  shopLines,
  STATUS_WORD,
  staffName,
  statusChangeText,
} from "../../src/client/orders/words.ts";

const SITE = "0b0c4f5e-6a8d-4c1e-9a3b-2f4d5e6a7b8c";
const NOT_V4 = "0b0c4f5e-6a8d-1c1e-0a3b-2f4d5e6a7b8c";
const time = (ms: number) => `t${ms}`;

describe("emailLine: the order email in words", () => {
  it.each([
    ["sent", null, "Emailed to the client"],
    ["pending", null, "Email not sent yet"],
    ["skipped", null, "Not emailed"],
    ["held", null, "Waiting for card payment"],
    ["failed", null, "Email failed"],
    ["failed", "daily_cap", "Email failed: daily email limit reached"],
    ["failed", "provider_429", "Email failed (code: provider_429)"],
  ] as const)("%s %s: %j", (status, error, text) => {
    expect(emailLine(status, error)).toBe(text);
  });
});

describe("who changed an order", () => {
  it("drops the admin: prefix, and shows anything else as it is", () => {
    expect(staffName("admin:ashir@hybridmediaworks.com")).toBe("ashir@hybridmediaworks.com");
    expect(staffName("system")).toBe("system");
  });

  it("names the change, and only the last one when both happened (one statusAt/statusBy)", () => {
    const by = { statusAt: 5, statusBy: "admin:a@b.co" };
    expect(statusChangeText({ status: "cancelled", spam: false, ...by }, time)).toBe("Canceled by a@b.co on t5.");
    expect(statusChangeText({ status: "new", spam: true, ...by }, time)).toBe("Marked as spam by a@b.co on t5.");
    expect(statusChangeText({ status: "cancelled", spam: true, ...by }, time)).toBe("Last changed by a@b.co on t5.");
    expect(statusChangeText({ status: "new", spam: false, statusAt: null, statusBy: null }, time)).toBeNull();
  });
});

describe("buyerMailto: a link only for a plain address (buyer-typed text)", () => {
  it("puts the order number in the subject", () => {
    expect(buyerMailto({ number: 1042, email: "maria@example.com" })).toBe("mailto:maria@example.com?subject=Your%20order%20%231042");
  });

  it.each(["maria@example.com?cc=x@evil.example", "a@b.com&body=hi", "a@b.com#x", "a%40b.com", "a b@c.com", "a@b.com\n"])("gives no link for %j", (email) => {
    expect(buyerMailto({ number: 1, email })).toBeNull();
  });
});

describe("addressLines", () => {
  it("keeps the second line only when there is one", () => {
    expect(addressLines({ line1: "1 Main St", city: "Austin", state: "TX", zip: "78701" })).toEqual(["1 Main St", "Austin, TX 78701"]);
    expect(addressLines({ line1: "1 Main St", line2: "Apt 4", city: "Austin", state: "TX", zip: "78701" })).toEqual(["1 Main St", "Apt 4", "Austin, TX 78701"]);
    expect(addressLines({ line1: "1 Main St", line2: "", city: "Austin", state: "TX", zip: "78701" })).toEqual(["1 Main St", "Austin, TX 78701"]);
  });
});

describe("filters in the page address and in the API request", () => {
  it("reads the site and spam filters, ignoring anything else", () => {
    expect(readOrdersFilters(`?site=${SITE}&spam=1`)).toEqual({ siteId: SITE, spam: true });
    expect(readOrdersFilters("")).toEqual({ siteId: null, spam: false });
    expect(readOrdersFilters("?site=nope&spam=yes")).toEqual({ siteId: null, spam: false });
    // A 36-character id the API would refuse (not a v4 UUID): treated as no site, so the page shows all orders instead of an error.
    expect(readOrdersFilters(`?site=${NOT_V4}`)).toEqual({ siteId: null, spam: false });
  });

  it("writes them back, and the two round-trip", () => {
    expect(ordersPath({ siteId: null, spam: false })).toBe("/orders");
    expect(ordersPath({ siteId: SITE, spam: true })).toBe(`/orders?site=${SITE}&spam=1`);
    for (const filters of [{ siteId: null, spam: true }, { siteId: SITE, spam: false }]) expect(readOrdersFilters(ordersPath(filters).replace("/orders", ""))).toEqual(filters);
  });

  it("asks the API for one page, with the cursor when there is one", () => {
    expect(ordersRequest({ siteId: null, spam: false }, null)).toBe("/api/admin/orders?spam=0&limit=50");
    expect(ordersRequest({ siteId: SITE, spam: true }, 1234, 2)).toBe(`/api/admin/orders?spam=1&limit=2&siteId=${SITE}&before=1234`);
  });

  it("says what an empty list means", () => {
    expect(emptyOrdersText({ siteId: null, spam: false })).toBe("No orders yet. When a buyer orders from a shop, it shows up here.");
    expect(emptyOrdersText({ siteId: SITE, spam: false })).toBe("No orders for this site yet.");
    expect(emptyOrdersText({ siteId: SITE, spam: true })).toBe("Nothing is marked as spam.");
  });
});

describe("shopLines: a site's shop state in words", () => {
  const base: SiteShopStatus = {
    ordersPausedAt: null, ordersPausedBy: null, allOrdersPaused: false, orderEmail: null, orderEmailRev: 0, orderEmailConfirmedAt: null,
    orderEmailConfirmedBy: null, orderCount: 0, ordersToday: 0,
  };

  it("not paused anywhere, no address: says it takes no orders, and why", () => {
    expect(shopLines(base, true, time)).toEqual({
      takesOrders: "No: it has no order address yet",
      orders: "Not paused",
      allShops: "Not paused",
      address: "None yet. Orders can't be placed.",
      counts: "0 in all · 0 today (UTC)",
    });
  });

  it("paused here and everywhere, address waiting, then confirmed", () => {
    const paused = { ...base, ordersPausedAt: 7, ordersPausedBy: "admin:a@b.co", allOrdersPaused: true, orderEmail: "orders@shop.example", orderCount: 12, ordersToday: 3 };
    expect(shopLines(paused, true, time)).toEqual({
      takesOrders: "No: orders are paused for this site",
      orders: "Paused by a@b.co on t7",
      allShops: "Paused for every shop",
      address: "orders@shop.example: not confirmed yet. Orders can't be placed until it is.",
      counts: "12 in all · 3 today (UTC)",
    });
    expect(shopLines({ ...paused, orderEmailConfirmedAt: 9, orderEmailConfirmedBy: "admin:c@d.co" }, true, time).address).toBe("orders@shop.example: confirmed t9 by c@d.co");
  });

  it("says Yes only when every condition of the insert guard holds", () => {
    const ready = { ...base, orderEmail: "orders@shop.example", orderEmailRev: 1, orderEmailConfirmedAt: 5, orderEmailConfirmedBy: "admin:a@b.co" };
    expect(shopLines(ready, true, time).takesOrders).toBe("Yes");
    expect(shopLines(ready, false, time).takesOrders).toBe("No: the site is not live");
    expect(shopLines(ready, null, time).takesOrders).toBe("No: the site's state could not be read");
  });
});

describe("orderBlocker: the sites Worker's insert guard, in its own order", () => {
  const ready: SiteShopStatus = {
    ordersPausedAt: null, ordersPausedBy: null, allOrdersPaused: false, orderEmail: "orders@shop.example", orderEmailRev: 1, orderEmailConfirmedAt: 5,
    orderEmailConfirmedBy: "admin:a@b.co", orderCount: 0, ordersToday: 0,
  };
  it.each([
    [ready, true, null],
    [ready, false, "the site is not live"],
    [{ ...ready, ordersPausedAt: 9 }, false, "the site is not live"],
    [{ ...ready, ordersPausedAt: 9 }, true, "orders are paused for this site"],
    [{ ...ready, allOrdersPaused: true }, true, "orders are paused on every shop"],
    [{ ...ready, orderEmailConfirmedAt: null }, true, "its order address is not confirmed yet"],
    [{ ...ready, orderEmail: null, orderEmailConfirmedAt: null }, true, "it has no order address yet"],
    [ready, null, "the site's state could not be read"],
  ] as const)("%#", (status, live, why) => {
    expect(orderBlocker(status, live)).toBe(why);
  });
});

describe("US English on screen", () => {
  it("says Canceled, while the API value stays cancelled", () => {
    expect(STATUS_WORD.cancelled).toBe("Canceled");
  });
});

describe("resumedText: Resume never promises orders the site cannot take", () => {
  const open: SiteShopStatus = {
    ordersPausedAt: null, ordersPausedBy: null, allOrdersPaused: false, orderEmail: "orders@shop.example", orderEmailRev: 1, orderEmailConfirmedAt: 5,
    orderEmailConfirmedBy: "admin:a@b.co", orderCount: 0, ordersToday: 0,
  };
  it.each([
    [open, true, "This site takes orders again."],
    [open, false, "This site's own pause is off, but it can't take orders: the site is not live."],
    [open, null, "This site's own pause is off, but it can't take orders: the site's state could not be read."],
    [{ ...open, allOrdersPaused: true }, true, "This site's own pause is off, but it can't take orders: orders are paused on every shop."],
    [{ ...open, orderEmailConfirmedAt: null }, true, "This site's own pause is off, but it can't take orders: its order address is not confirmed yet."],
    [{ ...open, orderEmail: null, orderEmailConfirmedAt: null }, true, "This site's own pause is off, but it can't take orders: it has no order address yet."],
    [{ ...open, ordersPausedAt: 9 }, true, "Orders are still paused for this site."],
  ] as const)("%#", (status, live, text) => {
    expect(resumedText(status, live)).toBe(text);
  });
});
