import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN, expectAccessible, expectNoSidewaysScroll, pendingSite } from "./support.ts";

// The staff orders screens (admin-orders-plan.md; customer data, strict tier). Orders are seeded through the test Worker's
// /__test/orders (the stored shape of the sites Worker); every change goes through the real admin API. A change "made elsewhere"
// is made in a second tab, as a second staff member would.

interface SeedOrder {
  number: number;
  createdAt?: number;
  name?: string;
  email?: string;
  phone?: string | null;
  fulfilment?: "pickup" | "delivery" | "shipping";
  address?: { line1: string; line2?: string; city: string; state: string; zip: string } | null;
  note?: string | null;
  items?: Array<{ name: string; variantLabel?: string | null; unitCents: number; qty: number }>;
  spam?: boolean;
  emailStatus?: "pending" | "sent" | "failed" | "skipped";
  emailError?: string | null;
}

async function seedOrders(request: APIRequestContext, siteId: string, orders: SeedOrder[]): Promise<string[]> {
  const res = await request.post(`${ADMIN}/__test/orders`, {
    data: {
      siteId,
      orders: orders.map((o) => ({
        name: "Maria Lopez",
        email: "maria@example.com",
        fulfilment: "pickup",
        items: [{ name: "Mom Flipflop", variantLabel: "Size 8, Black", unitCents: 990, qty: 2 }],
        ...o,
      })),
    },
  });
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { ids: string[] }).ids;
}

/**
 * A site for these tests, taken out of the review queue at once (rejected through the real admin API): the queue lists only the 50
 * oldest waiting sites, so sites left waiting here would push other specs' sites off it (admin.spec, keyboard.spec).
 */
async function orderSite(request: APIRequestContext) {
  const site = await pendingSite(request);
  const res = await request.post(`${ADMIN}/api/admin/versions/${site.versionId}/reject`, { data: { note: "Orders test site, not for review." }, headers: { Origin: ADMIN } });
  expect(res.ok()).toBe(true);
  return site;
}

/** A site with one order. */
async function siteWithOrder(page: Page, order: Partial<SeedOrder> = {}) {
  const site = await orderSite(page.request);
  const [orderId] = await seedOrders(page.request, site.siteId, [{ number: 1001, ...order }]);
  return { ...site, orderId: orderId! };
}

test("the list shows a site's orders newest first, with spam apart, and pages older orders", async ({ page }) => {
  const site = await orderSite(page.request);
  const base = Date.now() - 10_000_000;
  const many: SeedOrder[] = Array.from({ length: 52 }, (_, i) => ({ number: 1001 + i, createdAt: base + i * 1000, name: `Buyer ${i + 1}` }));
  await seedOrders(page.request, site.siteId, [...many, { number: 2001, createdAt: base + 999_999, name: "Junk Buyer", spam: true }]);

  await page.goto(`/orders?site=${site.siteId}`);
  await expect(page.getByRole("heading", { level: 1, name: "Orders" })).toBeVisible();
  const rows = page.locator(".order-row");
  await expect(rows).toHaveCount(50);
  await expect(rows.first()).toContainText("Order #1052");
  await expect(rows.first()).toContainText("Buyer 52");
  await expect(rows.first()).toContainText("$19.80");
  await expect(rows.first()).toContainText("Emailed to the client");
  await expect(page.getByText("Junk Buyer")).toHaveCount(0);
  await expectAccessible(page);
  await expectNoSidewaysScroll(page);

  await page.getByRole("button", { name: "Show older orders" }).click();
  await expect(rows).toHaveCount(52);
  await expect(page.getByRole("button", { name: /older orders/ })).toHaveCount(0);
  // The button went with the last page: focus is on the first new row, not lost.
  await expect(rows.nth(50)).toBeFocused();

  await page.getByRole("group", { name: "Show" }).getByRole("button", { name: "Spam" }).click();
  await expect(page).toHaveURL(new RegExp(`/orders\\?site=${site.siteId}&spam=1$`));
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Junk Buyer");
  await expect(rows.first()).toContainText("Spam");
});

test("an empty site says so, and a bad filter in the address shows all orders", async ({ page }) => {
  const site = await orderSite(page.request);
  await page.goto(`/orders?site=${site.siteId}`);
  await expect(page.getByText("No orders for this site yet.")).toBeVisible();
  await page.goto("/orders?site=nope&spam=maybe");
  await expect(page.getByRole("combobox", { name: "Site" })).toHaveValue("");
  await expect(page.getByRole("group", { name: "Show" }).getByRole("button", { name: "Orders" })).toHaveAttribute("aria-pressed", "true");
});

test("an order shows its lines, subtotal, how the buyer gets it, and the buyer's details as typed (never as markup)", async ({ page }) => {
  const site = await siteWithOrder(page, {
    phone: "+15125550142",
    fulfilment: "delivery",
    address: { line1: "1200 Barton Springs Rd", line2: "Apt 4", city: "Austin", state: "TX", zip: "78704" },
    note: "<b>Gate</b> code 12\nThanks!",
    items: [
      { name: "Mom Flipflop", variantLabel: "Size 8, Black", unitCents: 990, qty: 2 },
      { name: "Beach Tote", unitCents: 2400, qty: 1 },
    ],
    emailStatus: "failed",
    emailError: "daily_cap",
  });
  await page.goto(`/orders?site=${site.siteId}`);
  await page.getByRole("link", { name: /Order #1001/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Order #1001" })).toBeVisible();
  const items = page.getByRole("table");
  await expect(items.getByRole("row", { name: /Mom Flipflop/ })).toContainText("$19.80");
  await expect(items.getByRole("row", { name: /Beach Tote/ })).toContainText("$24.00");
  await expect(items.getByRole("row", { name: /Subtotal/ })).toContainText("$43.80");
  await expect(page.getByText("Local delivery")).toBeVisible();
  await expect(page.getByText("Austin, TX 78704")).toBeVisible();
  await expect(page.getByText("<b>Gate</b> code 12", { exact: false })).toBeVisible();
  await expect(page.locator("b", { hasText: "Gate" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "maria@example.com" })).toHaveAttribute("href", "mailto:maria@example.com?subject=Your%20order%20%231001");
  await expect(page.getByRole("link", { name: "+15125550142" })).toHaveAttribute("href", "tel:+15125550142");
  await expect(page.getByText("Email failed: daily email limit reached")).toBeVisible();
  await expectAccessible(page);
  await expectNoSidewaysScroll(page);

  await page.getByRole("link", { name: "All orders" }).click();
  await expect(page).toHaveURL(new RegExp(`/orders\\?site=${site.siteId}$`));
});

test("Cancel asks first and can be backed out of; then it cancels, and the page says so", async ({ page }) => {
  const site = await siteWithOrder(page);
  await page.goto(`/orders/${site.orderId}`);
  // Opened from the keyboard, so focus is on the button before the dialog (a click does not focus a button in WebKit on macOS).
  const cancel = page.getByRole("button", { name: "Cancel this order" });
  await cancel.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Cancel order #1001?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Keep it" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(cancel).toBeFocused();

  await page.getByRole("button", { name: "Cancel this order" }).click();
  await dialog.getByRole("button", { name: "Cancel the order" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Order canceled." })).toBeFocused();
  await expect(page.locator(".pill", { hasText: "Canceled" })).toBeVisible();
  await expect(page.getByText(/^Canceled by .+ on .+\.$/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel this order" })).toHaveCount(0);
});

test("a cancel made in another tab first: this tab's cancel gets the 409, reloads, and says the order changed", async ({ page, context }) => {
  const site = await siteWithOrder(page);
  await page.goto(`/orders/${site.orderId}`);
  const other = await context.newPage();
  await other.goto(`/orders/${site.orderId}`);
  await other.getByRole("button", { name: "Cancel this order" }).click();
  await other.getByRole("dialog").getByRole("button", { name: "Cancel the order" }).click();
  await expect(other.getByText("Order canceled.")).toBeVisible();

  await page.getByRole("button", { name: "Cancel this order" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel the order" }).click();
  await expect(page.getByRole("status").filter({ hasText: "This order changed while you were looking. It now shows its latest state." })).toBeFocused();
  await expect(page.locator(".pill", { hasText: "Canceled" })).toBeVisible();
});

test("a cancel with no clear answer never claims either way: committed-but-lost shows the new state, a server error the old", async ({ page }) => {
  const UNSURE = "We couldn't tell whether that worked. Reload to see the latest state.";
  const site = await siteWithOrder(page);
  await page.goto(`/orders/${site.orderId}`);
  // The server cancels the order, but the answer never reaches the page.
  await page.route("**/api/admin/orders/*/cancel", async (route) => {
    await route.fetch();
    await route.abort();
  });
  await page.getByRole("button", { name: "Cancel this order" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel the order" }).click();
  await expect(page.getByRole("status").filter({ hasText: UNSURE })).toBeFocused();
  await expect(page.locator(".pill", { hasText: "Canceled" })).toBeVisible();
  await page.unroute("**/api/admin/orders/*/cancel");

  // A server error before anything changed: the same honest line, and the order is still as it was.
  const other = await siteWithOrder(page);
  await page.goto(`/orders/${other.orderId}`);
  await page.route("**/api/admin/orders/*/spam", (route) => route.fulfill({ status: 500, json: { error: { code: "internal", message: "Something went wrong." } } }));
  await page.getByRole("button", { name: "Mark as spam" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Mark as spam" }).click();
  await expect(page.getByRole("status").filter({ hasText: UNSURE })).toBeFocused();
  await expect(page.getByRole("button", { name: "Mark as spam" })).toBeVisible();
});

test("Mark as spam moves the order to the Spam list", async ({ page }) => {
  const site = await siteWithOrder(page);
  await page.goto(`/orders/${site.orderId}`);
  await page.getByRole("button", { name: "Mark as spam" }).click();
  await page.getByRole("dialog", { name: "Mark order #1001 as spam?" }).getByRole("button", { name: "Mark as spam" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Marked as spam." })).toBeFocused();
  await expect(page.getByRole("button", { name: "Mark as spam" })).toHaveCount(0);
  await page.goto(`/orders?site=${site.siteId}`);
  await expect(page.getByText("No orders for this site yet.")).toBeVisible();
  await page.goto(`/orders?site=${site.siteId}&spam=1`);
  await expect(page.locator(".order-row")).toHaveCount(1);
});

test("an unknown order says it no longer exists", async ({ page }) => {
  await page.goto("/orders/00000000-0000-4000-8000-000000000000");
  await expect(page.getByText("This order no longer exists.")).toBeVisible();
  await expect(page.getByRole("link", { name: "All orders" })).toBeVisible();
});

test("a site's shop card: pause asks first, resume does not, and a pause made in another tab gives the 409 line", async ({ page, context }) => {
  const site = await siteWithOrder(page);
  await page.goto(`/sites/${site.siteId}`);
  const card = page.getByRole("region", { name: "Shop" });
  // The test site was rejected (not live) and has no order address: the card says it takes no orders, and why (the insert guard's order).
  await expect(card).toContainText("No: the site is not live");
  await expect(card).toContainText("Not paused");
  await expect(card).toContainText("None yet. Orders can't be placed.");
  await expect(card).toContainText("1 in all");
  await expectAccessible(page);
  await expectNoSidewaysScroll(page);

  await card.getByRole("button", { name: "Pause this site's orders" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Pause orders" }).click();
  await expect(card.getByRole("status").filter({ hasText: "Orders paused for this site." })).toBeFocused();
  await expect(card).toContainText(/Paused by .+ on /);
  await card.getByRole("button", { name: "Resume this site's orders" }).click();
  // The test site is not live, so Resume says it still can't take orders (never "takes orders again").
  await expect(card.getByRole("status").filter({ hasText: "This site's own pause is off, but it can't take orders: the site is not live." })).toBeVisible();

  const other = await context.newPage();
  await other.goto(`/sites/${site.siteId}`);
  await other.getByRole("region", { name: "Shop" }).getByRole("button", { name: "Pause this site's orders" }).click();
  await other.getByRole("dialog").getByRole("button", { name: "Pause orders" }).click();
  await expect(other.getByText("Orders paused for this site.")).toBeVisible();

  // This tab still shows "Not paused": its pause is now a 409, and the card reloads to the paused state.
  await card.getByRole("button", { name: "Pause this site's orders" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Pause orders" }).click();
  await expect(card.getByRole("status").filter({ hasText: "Someone else changed this just now. It shows the latest state." })).toBeFocused();
  await expect(card.getByRole("button", { name: "Resume this site's orders" })).toBeVisible();

  await card.getByRole("link", { name: "See this site's orders" }).click();
  await expect(page).toHaveURL(new RegExp(`/orders\\?site=${site.siteId}$`));
});

test("the every-shop switch: pause and turn the pause off, with the state shown once known (mocked answers: no real global flip)", async ({ page }) => {
  // The real setting is shared by every shop and every test running beside this one, so this test never changes it: the
  // switch's answers and the shop status are mocked here, and pages' workerd tests cover the real API.
  let paused = false;
  await page.route("**/api/admin/orders/pause-all", (route) => {
    paused = true;
    return route.fulfill({ json: { allOrdersPaused: true } });
  });
  await page.route("**/api/admin/orders/resume-all", (route) => {
    paused = false;
    return route.fulfill({ json: { allOrdersPaused: false } });
  });
  await page.route("**/api/admin/sites/*/shop", async (route) => {
    const status = (await (await route.fetch()).json()) as Record<string, unknown>;
    await route.fulfill({ json: { ...status, allOrdersPaused: paused } });
  });

  const site = await siteWithOrder(page);
  await page.goto(`/orders?site=${site.siteId}`);
  await expect(page.getByText("The every-shop pause is off.", { exact: true })).toBeVisible();
  const card = page.getByRole("region", { name: "Shop" });
  await expect(card).toContainText("All shops");
  await expect(card).not.toContainText("Paused for every shop");

  await page.getByRole("button", { name: "Pause all orders" }).click();
  await page.getByRole("dialog", { name: "Pause orders on every shop?" }).getByRole("button", { name: "Pause all orders" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Orders paused on every shop." })).toBeFocused();
  await expect(page.getByText("The every-shop pause is on: no shop takes orders.")).toBeVisible();
  // The Shop card on the same page reads the new state too.
  await expect(card).toContainText("Paused for every shop");

  await page.getByRole("button", { name: "Turn off the every-shop pause" }).click();
  await page.getByRole("dialog", { name: "Turn off the every-shop pause?" }).getByRole("button", { name: "Turn it off" }).click();
  await expect(page.getByRole("status").filter({ hasText: "The every-shop pause is off. Shops paused on their own stay paused." })).toBeFocused();
  await expect(card).not.toContainText("Paused for every shop");
  // The header shows the new state and offers pausing again (and no longer the turn-off button).
  await expect(page.getByText("The every-shop pause is off.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pause all orders" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Turn off the every-shop pause" })).toHaveCount(0);
});

test("the every-shop switch with no clear answer: the page stops claiming either state and re-reads the card", async ({ page }) => {
  await page.route("**/api/admin/orders/pause-all", (route) => route.fulfill({ status: 500, json: { error: { code: "internal", message: "Something went wrong." } } }));
  const site = await siteWithOrder(page);
  await page.goto(`/orders?site=${site.siteId}`);
  await expect(page.getByText("The every-shop pause is off.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Pause all orders" }).click();
  await page.getByRole("dialog", { name: "Pause orders on every shop?" }).getByRole("button", { name: "Pause all orders" }).click();
  await expect(page.getByRole("status").filter({ hasText: "We couldn't tell whether that worked. Reload to see the latest state." })).toBeFocused();
  // The card re-read the real state (nothing changed: the mocked 500 never reached the server), and the header offers both ways.
  await expect(page.getByRole("region", { name: "Shop" })).not.toContainText("Paused for every shop");
  await expect(page.getByText("The every-shop pause is off.", { exact: true })).toBeVisible();
});

test("a site pause with no clear answer says so, and the card shows what really happened", async ({ page }) => {
  const site = await siteWithOrder(page);
  await page.goto(`/sites/${site.siteId}`);
  const card = page.getByRole("region", { name: "Shop" });
  // The server pauses the site, but the answer never reaches the page.
  await page.route("**/api/admin/sites/*/orders/pause", async (route) => {
    await route.fetch();
    await route.abort();
  });
  await card.getByRole("button", { name: "Pause this site's orders" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Pause orders" }).click();
  await expect(card.getByRole("status").filter({ hasText: "We couldn't tell whether that worked. Reload to see the latest state." })).toBeFocused();
  await expect(card).toContainText(/Paused by .+ on /);
  await expect(card.getByRole("button", { name: "Resume this site's orders" })).toBeVisible();
});

test("Try again: the list and the Shop card each recover from a failed load and keep keyboard focus on the page", async ({ page }) => {
  const site = await siteWithOrder(page);
  let ordersFailures = 1;
  await page.route("**/api/admin/orders?*", (route) => (ordersFailures-- > 0 ? route.fulfill({ status: 500, json: { error: { code: "internal", message: "Something went wrong." } } }) : route.continue()));
  let shopFailures = 1;
  await page.route("**/api/admin/sites/*/shop", (route) => (shopFailures-- > 0 ? route.fulfill({ status: 500, json: { error: { code: "internal", message: "Something went wrong." } } }) : route.continue()));
  await page.goto(`/orders?site=${site.siteId}`);

  const listRetry = page.getByRole("alert").filter({ hasText: "We couldn't load the orders." }).getByRole("button", { name: "Try again" });
  await listRetry.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".order-row")).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName ?? "")).not.toBe("BODY");

  const shopRetry = page.getByRole("alert").filter({ hasText: "We couldn't load the shop." }).getByRole("button", { name: "Try again" });
  await shopRetry.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Shop" })).toContainText("Takes orders");
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName ?? "")).not.toBe("BODY");
});

test("a late answer for the old filter never shows under the new one", async ({ page }) => {
  const site = await siteWithOrder(page, { name: "Real Buyer" });
  await seedOrders(page.request, site.siteId, [{ number: 1002, name: "Junk Buyer", spam: true }]);
  // The first list request (Orders) is held back; the Spam request that follows answers at once.
  let held = true;
  await page.route("**/api/admin/orders?*", async (route) => {
    if (held && route.request().url().includes("spam=0")) {
      held = false;
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    await route.continue();
  });
  await page.goto(`/orders?site=${site.siteId}`);
  await page.getByRole("group", { name: "Show" }).getByRole("button", { name: "Spam" }).click();
  await expect(page.locator(".order-row")).toHaveCount(1);
  await expect(page.locator(".order-row").first()).toContainText("Junk Buyer");
  // The held Orders answer arrives now; it must be dropped.
  await page.waitForTimeout(3000);
  await expect(page.locator(".order-row")).toHaveCount(1);
  await expect(page.getByText("Real Buyer")).toHaveCount(0);
});

test("keyboard: an order opens from the list with Enter", async ({ page }) => {
  const site = await siteWithOrder(page);
  await page.goto(`/orders?site=${site.siteId}`);
  const row = page.getByRole("link", { name: /Order #1001/ });
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Order #1001" })).toBeFocused();
});
