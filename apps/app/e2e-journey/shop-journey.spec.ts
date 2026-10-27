import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { emailLine } from "../../admin/src/client/orders/words.ts";
import { adminApi, APP, expectAccessible, expectLive, latestEmail, LIVE_PORT, pageUrl, reviewVersion } from "./support.ts";

// SHOP STEP 1 JOURNEY (final proof for the boss demo). Source script: .superpowers/phase2/shop-journey.md (J-1..J-20).
//
// What it proves, end to end: staff build a shop site and add products in the owner app, send it for review and the
// admin approves; a buyer adds to the cart and sends an order on the live site; the staff see the order in the admin;
// the order email reaches the client's order address (the dev outbox).
// Checks on every step that has them: money only as the catalog's cents show it (990 cents is "$9.90", 2 x 990 is
// 1980 cents is "$19.80"; no amount is summed in the test); buyer text shown as text (a note holding <b>x</b> shows
// the tags); the admin row words ("Order #1001", "Emailed to the client"); the outbox email to the client's address.
//
// HOW TO READ IT. Tests run in order (serial). A test that needs a piece that is not built yet is `test.fixme(true,
// "<dependency id>: <what is missing>")` with the REAL steps written below that line. The ids are the ones in
// shop-journey.md: D-C1 shop contract and trade "shop"; D-ED owner-app editor/API for products; D-PUB publishing writes
// the catalog; D-REN renderer shop pages and cart markup (Plan 3); D-SITES cart and order endpoints wired in the sites
// router; D-ADDR admin calls to set and confirm the client's order address; D-MAIL the order email sender; D-ADMUI.
//
// HOW TO SWITCH A STEP ON. Delete its `test.fixme(true, ...)` line (one line). Switch on in order, because later steps
// use state that earlier steps leave in `state` (the shop site, the order address, the order numbers). The file order is
// the run order: the empty-orders check (J-16 today) sits right after J-7 and before J-8, where "no address, no orders" stays
// true for good; J-8 and J-13 change that state. Where a step still guesses a name (a selector or a route, marked
// "VERIFY WHEN ON"), check it against the built code when you switch it on.
// The order address is made per run (`state.orderAddress`), so the two browser projects never read each other's email.
// The sites Worker allows 3 order posts per minute per site and IP (ORDER_RL); J-19 and J-20 wait out the window first.
//   - D-C1: also change TRADE below to "shop" and the questionnaire answers in `facts` (the shop goal "buy").
//   - D-ADDR: fill in ORDER_ADDRESS_ROUTES with the real admin routes.
//
// WHAT RUNS TODAY (this branch, verified in code on 2026-10-27): J-1/J-3 (an owner and a built site, through the API as
// the admin journey does), J-7 (send for review, the admin approves, the pages are live), and the empty admin orders
// state of J-16 through the admin API. The admin SCREENS cannot be driven here: this runtime serves the static files of
// one Worker only (server.ts), the app's, so the journey reads the admin through its API (support.ts adminApi). The words
// the admin screens show for an order row are imported from the admin's own words.ts (emailLine) and checked against the
// API's values; the screens have their own browser tests.
// NOT wired in the sites router on this branch: no `/_o/`, no `/cart` in apps/sites/src/router.ts (order.ts has the logic).

const TRADE = "plumbing"; // D-C1: "shop"
const BUSINESS = "Hip Hop Flip Flopp";
const BRIEF = { tone: "friendly", goal: "call" }; // D-C1: goal "buy"

/** Prices are the catalog's cents; the screens show them with `formatUsd`. Written out here so a wrong sum cannot hide. */
const MOM_FLIPFLOP = { name: "Mom Flipflop", cents: 990, shown: "$9.90" };
const QTY = 2;
const LINE = { cents: 1980, shown: "$19.80" }; // 2 x 990, as the server stores it

/** D-ADDR VERIFY WHEN ON: the admin routes that set and confirm the client's order address (pages, not in code yet). */
const ORDER_ADDRESS_ROUTES = {
  set: (siteId: string) => `/api/admin/sites/${siteId}/order-address`,
  confirm: (siteId: string) => `/api/admin/sites/${siteId}/order-address/confirm`,
};

const json = async <T>(res: { json(): Promise<unknown> }): Promise<T> => (await res.json()) as T;
const stamp = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

type Generation = { id: string; status: string; usedFallback: boolean };
interface AdminOrder {
  id: string;
  number: number;
  name: string;
  subtotalCents: number;
  status: "new" | "cancelled";
  spam: boolean;
  emailStatus: "sent" | "pending" | "skipped" | "held" | "failed";
  emailError: string | null;
  slug: string | null;
}
interface AdminOrderDetail extends AdminOrder {
  email: string;
  note: string | null;
  fulfilment: string;
  items: Array<{ name: string; variantLabel: string | null; unitCents: number; qty: number; lineCents: number }>;
}

// State the steps hand to each other (serial mode: one worker runs them in order).
const state = {
  id: stamp(),
  email: "",
  slug: "",
  siteId: "",
  rev: 0,
  versionId: "",
  pages: [] as Awaited<ReturnType<typeof reviewVersion>>["pages"],
  orderId: "",
  orderAddress: "",
};

let ownerContext: BrowserContext;
let adminContext: BrowserContext;
let buyerContext: BrowserContext;
let owner: Page;
let buyer: Page;
let admin: APIRequestContext;

async function ownerApi(method: "GET" | "POST" | "PUT" | "PATCH", path: string, data?: unknown) {
  const res = await owner.request.fetch(`${APP}${path}`, { method, headers: { Origin: APP }, ...(data === undefined ? {} : { data }) });
  expect(res.status(), `${method} ${path}`).toBeLessThan(300);
  return res;
}

const currentRev = async () => (await json<{ rev: number }>(await ownerApi("GET", `/api/sites/${state.siteId}`))).rev;

/** The admin's list of orders for the site, as the Orders screen requests it (apps/admin words.ts ordersRequest). */
async function siteOrders(spam: "0" | "1" = "0") {
  return json<{ orders: AdminOrder[]; nextBefore: number | null }>(await adminApi(admin, "GET", `/api/admin/orders?siteId=${state.siteId}&spam=${spam}&limit=50`));
}

interface Buyer { name: string; email: string; delivery: boolean; line1: string; city: string; state: string; zip: string; note: string }
const MARIA: Buyer = { name: "Maria Lopez", email: "maria@example.com", delivery: true, line1: "1 Main St", city: "Austin", state: "TX", zip: "78701", note: "Can you deliver Saturday morning? <b>x</b>" };

/** D-REN VERIFY WHEN ON: the product page and cart markup of Plan 3. Adds QTY of Mom Flipflop (Size 7, Black) to the cart. */
async function addFlipflopToCart() {
  await buyer.goto(pageUrl(state.slug, "home"));
  await buyer.getByRole("navigation").getByRole("link", { name: "Shop" }).first().click();
  await buyer.getByRole("link", { name: MOM_FLIPFLOP.name }).click();
  await buyer.getByLabel("Size").selectOption("7");
  await buyer.getByLabel("Color").selectOption("Black");
  await buyer.getByLabel("Quantity").fill(String(QTY));
  await buyer.getByRole("button", { name: /Add to cart/i }).click();
  await expect(buyer.getByText(/added/i).first()).toBeVisible();
}

/** Fills EVERY order field (State included: delivery requires it) and sends. `addItem: false` reuses the cart the buyer already holds. */
async function placeOrder(who: Buyer, { addItem = true }: { addItem?: boolean } = {}) {
  if (addItem) await addFlipflopToCart();
  await buyer.goto(`https://${state.slug}.localhost:${LIVE_PORT}/cart`);
  await buyer.getByLabel("Name").fill(who.name); // VERIFY WHEN ON: the field labels Plan 3 renders
  await buyer.getByLabel("Email").fill(who.email);
  if (who.delivery) await buyer.getByLabel("Local delivery").check();
  else await buyer.getByLabel("Pickup").check();
  await buyer.getByLabel("Address").fill(who.line1);
  await buyer.getByLabel("City").fill(who.city);
  await buyer.getByLabel("State").fill(who.state);
  await buyer.getByLabel("Zip").fill(who.zip);
  await buyer.getByLabel("Note").fill(who.note);
  await buyer.getByRole("button", { name: /Send order|Place order/i }).click();
}

/** ORDER_RL is 3 posts per 60 s per site and IP, in clock-aligned one-minute windows (wrangler.jsonc; the local runtime keeps the same windows). Wait for the next window so the next posts get the real answer, not "rate_limited". */
async function waitForFreshOrderWindow() {
  await buyer.waitForTimeout(60_000 - (Date.now() % 60_000) + 1_000);
}

test.describe("shop step 1 journey", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }, testInfo) => {
    const viewport = testInfo.project.use.viewport ?? null;
    ownerContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport });
    adminContext = await browser.newContext({ ignoreHTTPSErrors: true });
    // The buyer is a second, private window: no owner cookies, a cart of its own.
    buyerContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport });
    owner = await ownerContext.newPage();
    buyer = await buyerContext.newPage();
    admin = adminContext.request;
    state.id = stamp();
    state.email = `shop-journey-${state.id}@example.com`;
    state.slug = `shop-journey-${state.id}`;
    state.orderAddress = `orders-${state.id}@hiphop.example`;
  });

  test.afterAll(async () => {
    await ownerContext.close();
    await adminContext.close();
    await buyerContext.close();
  });

  // J-1, J-2, J-3 (RUNS TODAY with a plumbing site). Staff build sites with an owner account today: the admin invites the
  // owner, the owner accepts, the answers go in through the draft API, the generator (fake model) writes the draft.
  // D-C1: set TRADE "shop" and BRIEF goal "buy"; the UI label of the trade is "Online shop" (a new text).
  test("J-1..J-3: staff sign up a client and build the site with the fake model", async () => {
    await adminApi(admin, "POST", "/api/admin/invites", { email: state.email });
    const link = /https:\/\/app\.localhost:8789\/invite#[A-Za-z0-9_-]{43}/.exec(await latestEmail(owner.request, state.email, /invited/))![0];
    await owner.goto(link);
    await owner.getByRole("button", { name: "Set up my website" }).click();
    await expect(owner.getByRole("heading", { level: 1, name: "Your business" })).toBeFocused();
    await expect(owner.getByRole("status").filter({ hasText: "All changes saved." })).toBeVisible();
    state.siteId = new URL(owner.url()).pathname.split("/")[2]!;
    await owner.goto(`${APP}/`);
    state.rev = await currentRev();

    const facts = {
      businessName: BUSINESS,
      trade: TRADE,
      phone: "+15125550142",
      email: state.email,
      location: { city: "Austin", state: "TX" },
      serviceArea: { places: ["Austin"] },
      services: [{ name: "Drain cleaning" }], // D-C1: a shop has products in facts instead
    };
    state.rev = (await json<{ rev: number }>(await ownerApi("PATCH", `/api/sites/${state.siteId}/draft`, { rev: state.rev, facts, brief: BRIEF }))).rev;
    state.rev = (await json<{ rev: number }>(await ownerApi("PUT", `/api/sites/${state.siteId}/slug`, { rev: state.rev, slug: state.slug }))).rev;

    const { generation } = await json<{ generation: Generation }>(await ownerApi("POST", `/api/sites/${state.siteId}/generations`, {}));
    let view = generation;
    await expect
      .poll(async () => {
        view = await json<Generation>(await ownerApi("GET", `/api/sites/${state.siteId}/generations/${generation.id}`));
        return view.status;
      }, { timeout: 120_000 })
      .toMatch(/^(succeeded|failed)$/);
    expect(view).toMatchObject({ status: "succeeded", usedFallback: false });
    await owner.goto(`${APP}/sites/${state.siteId}/edit`);
    await expectAccessible(owner);
  });

  // J-4 (D-C1, D-ED). Staff add the first product in the editor. Texts: shop-texts-for-approval.md A1, A2.
  test("J-4: staff add the product Mom Flipflop with sizes and colors", async () => {
    test.fixme(true, "D-C1 + D-ED: the shop contract (trade shop, products in facts) and the owner-app product screens are not wired into the editor yet");
    await owner.goto(`${APP}/sites/${state.siteId}/edit`);
    await owner.getByRole("link", { name: "Products" }).click(); // VERIFY WHEN ON: where the editor links the product list
    await expect(owner.getByRole("heading", { name: "Products" })).toBeVisible();
    await expect(owner.getByText("No products yet")).toBeVisible();
    await owner.getByRole("button", { name: "Add a product" }).click();
    await owner.getByLabel("Name", { exact: true }).fill(MOM_FLIPFLOP.name);
    await owner.getByLabel("Price in US dollars").fill("9.9");
    await owner.getByLabel("Price in US dollars").blur();
    await expect(owner.getByLabel("Price in US dollars")).toHaveValue("9.90");
    await expect(owner.getByText(`Shown as ${MOM_FLIPFLOP.shown}.`)).toBeVisible();
    await owner.getByRole("button", { name: "Add sizes or colors" }).click();
    await owner.getByLabel("Name of list 1").fill("Size");
    await owner.getByLabel("Add to Size").fill("6, 7, 8");
    await owner.getByLabel("Add to Size").press("Enter");
    await expect(owner.getByText("Added 6, 7 and 8.")).toBeVisible();
    await owner.getByRole("button", { name: "Add another list, like Color" }).click();
    await owner.getByLabel("Name of list 2").fill("Color");
    await owner.getByLabel("Add to Color").fill("Black, Coral");
    await owner.getByLabel("Add to Color").press("Enter");
    await expect(owner.getByText("Added Black and Coral.")).toBeVisible();
    // 3 sizes x 2 colors = 6 choices; unchecking "Size 8, Color Coral" leaves the 5 the shop sells.
    await expect(owner.getByRole("heading", { name: "What buyers can choose" })).toBeVisible();
    await owner.getByRole("checkbox", { name: "Size 8, Color Coral is sold here", exact: true }).uncheck(); // ProductForm.tsx: each row also has "... is sold out"
    await expect(owner.getByText("5 choices are offered")).toHaveCount(0); // the limit sentence shows only near 20
    // One photo. VERIFY WHEN ON: the fixture path.
    await owner.getByLabel("Add photos").setInputFiles({ name: "flipflop.jpg", mimeType: "image/jpeg", buffer: await samplePhoto() });
    await expect(owner.getByText("Main photo", { exact: true })).toBeVisible(); // the hint sentence also contains "main photo"
    await expectAccessible(owner);
    await owner.getByRole("button", { name: "All products" }).click();
    await expect(owner.getByText(MOM_FLIPFLOP.name)).toBeVisible();
    await expect(owner.getByText(MOM_FLIPFLOP.shown)).toBeVisible();
  });

  // J-5 (D-ED): second product, ordering, sold out.
  test("J-5: staff add Beach Tote, move it up, mark it sold out", async () => {
    test.fixme(true, "D-ED: the product list and form are not wired into the editor yet (depends on J-4's product list)");
    await owner.getByRole("button", { name: "Add a product" }).click();
    await owner.getByLabel("Name", { exact: true }).fill("Beach Tote");
    await owner.getByLabel("Price in US dollars").fill("24");
    await owner.getByRole("checkbox", { name: "The whole product is sold out" }).check(); // VERIFY WHEN ON: control type of "The whole product is sold out"
    await owner.getByRole("button", { name: "All products" }).click();
    await expect(owner.getByText("Sold out", { exact: true })).toBeVisible();
    await owner.getByRole("button", { name: "Move Beach Tote up" }).click();
    const names = await owner.getByRole("button", { name: /^Edit / }).allInnerTexts(); // VERIFY WHEN ON: the row's button name
    expect(names.map((n) => n.replace(/^Edit /, ""))[0]).toBe("Beach Tote");
    await expect(owner.getByText("2 of 24")).toBeVisible();
  });

  // J-6 (D-ED): shop settings.
  test("J-6: staff set the shop settings (pickup, local delivery, note for buyers)", async () => {
    test.fixme(true, "D-ED: the shop settings screen is not wired into the editor yet");
    await owner.getByRole("link", { name: "Shop settings" }).click(); // VERIFY WHEN ON
    await expect(owner.getByRole("heading", { name: "Shop settings" })).toBeVisible();
    await owner.getByLabel("Pickup").check();
    await owner.getByLabel("Local delivery").check();
    await owner.getByLabel("Note for buyers").fill("Pickup Tuesday to Saturday at our Austin store.");
    await expect(owner.getByRole("status").filter({ hasText: "All changes saved." })).toBeVisible();
    await expectAccessible(owner);
  });

  // J-7 (RUNS TODAY for the pages; the shop part waits). Send for review, the admin reviews every stored page and approves.
  test("J-7: staff send the site for review, the admin approves, the site is live", async () => {
    await owner.goto(`${APP}/sites/${state.siteId}/publish`);
    await owner.getByRole("button", { name: "Send for review" }).click();
    await expect(owner.getByRole("heading", { name: "Waiting for approval" })).toBeVisible();

    const queue = await json<{ items: Array<{ version: { id: string; number: number }; site: { slug: string | null } }> }>(await adminApi(admin, "GET", "/api/admin/reviews"));
    const item = queue.items.find((i) => i.site.slug === state.slug)!;
    expect(item.version.number).toBe(1);
    state.versionId = item.version.id;
    // A site with no photos has no Gallery. D-PUB/D-REN: a shop also lists the Shop page here; see the next test.
    const reviewed = await reviewVersion(admin, state.versionId, { gallery: false });
    state.pages = reviewed.pages;
    await adminApi(admin, "POST", `/api/admin/versions/${state.versionId}/approve`, { htmlSha256: reviewed.htmlSha256 });
    await latestEmail(owner.request, state.email, /Your website is live/);

    expect(pageUrl(state.slug, "home")).toBe(`https://${state.slug}.localhost:${LIVE_PORT}/`);
    await expectLive(buyer.request, state.slug, state.pages);
  });

  test("J-7 (shop): the Shop page is in the menu and in the approved pages", async () => {
    test.fixme(true, "D-PUB + D-REN: publishing the catalog and the renderer's shop pages are not merged on this branch");
    // The approved version lists a shop page and the live Home links to it.
    expect(state.pages.map((p) => p.page)).toContain("shop" as never); // VERIFY WHEN ON: the page id Plan 3 uses
    await buyer.goto(pageUrl(state.slug, "home"));
    await expect(buyer.getByRole("navigation").getByRole("link", { name: "Shop" }).first()).toBeVisible();
  });

  // J-16 (RUNS TODAY: the empty state). Staff look at the site's orders in the admin (through the admin API, see the header).
  test("J-16 (today): the admin shows no orders for this site yet", async () => {
    const list = await siteOrders();
    expect(list).toEqual({ orders: [], nextBefore: null });
    expect((await siteOrders("1")).orders).toEqual([]); // nothing in Spam either
    const shop = await json<{ orderCount: number; ordersToday: number; orderEmail: string | null; ordersPausedAt: number | null }>(await adminApi(admin, "GET", `/api/admin/sites/${state.siteId}/shop`));
    expect(shop).toMatchObject({ orderCount: 0, ordersToday: 0, orderEmail: null, ordersPausedAt: null });
    // The Orders screen shows, for this state: "No orders for this site yet." (words.ts emptyOrdersText; screen tests cover it).
  });

  // J-8 (D-ADDR): without a confirmed order address the shop refuses every order (order-sql.ts insert guard).
  test("J-8: staff set and confirm the client's order address", async () => {
    test.fixme(true, "D-ADDR: the admin calls that set and confirm the client's order address are not in code yet (pages, ETA 19:15)");
    await adminApi(admin, "POST", ORDER_ADDRESS_ROUTES.set(state.siteId), { email: state.orderAddress });
    const code = /\b(\d{6})\b/.exec(await latestEmail(owner.request, state.orderAddress, /confirm|code/i))?.[1]; // VERIFY WHEN ON: the code's form and the email subject
    expect(code).toBeDefined();
    await adminApi(admin, "POST", ORDER_ADDRESS_ROUTES.confirm(state.siteId), { code });
    const shop = await json<{ orderEmail: string | null; orderEmailConfirmedAt: number | null; orderCount: number }>(await adminApi(admin, "GET", `/api/admin/sites/${state.siteId}/shop`));
    expect(shop.orderEmail).toBe(state.orderAddress);
    expect(shop.orderEmailConfirmedAt).not.toBeNull();
  });

  // J-9 .. J-12 (D-REN, D-PUB, D-SITES): the buyer window.
  test("J-9..J-12: the buyer opens the product, adds two to the cart, cannot add the sold-out tote", async () => {
    test.fixme(true, "D-PUB + D-REN + D-SITES: no catalog on the live site, no shop or cart markup, and /cart is not routed in the sites Worker yet");
    await buyer.goto(pageUrl(state.slug, "home"));
    await buyer.getByRole("navigation").getByRole("link", { name: "Shop" }).first().click();
    await buyer.getByRole("link", { name: MOM_FLIPFLOP.name }).click();
    await expect(buyer.getByText(MOM_FLIPFLOP.shown).first()).toBeVisible(); // money as the catalog's cents show it
    await expectAccessible(buyer);
    // "Size 8, Color Coral" is not offered.
    await buyer.getByLabel("Size").selectOption("7");
    await buyer.getByLabel("Color").selectOption("Black");
    await buyer.getByLabel("Quantity").fill(String(QTY));
    await buyer.getByRole("button", { name: /Add to cart/i }).click();
    await expect(buyer.getByText(/added/i).first()).toBeVisible(); // VERIFY WHEN ON: the cart notice text (Plan 3 cart-markup)
    await expect(buyer.getByText(LINE.shown).first()).toBeVisible(); // 2 x $9.90, the server's line total
    // J-11: the sold-out tote has no Add button.
    await buyer.goto(pageUrl(state.slug, "home"));
    await buyer.getByRole("navigation").getByRole("link", { name: "Shop" }).first().click();
    await buyer.getByRole("link", { name: "Beach Tote" }).click();
    await expect(buyer.getByText("Sold out").first()).toBeVisible();
    await expect(buyer.getByRole("button", { name: /Add to cart/i })).toHaveCount(0);
    // J-12: change to 3 and back to 2; the subtotal follows the catalog prices only.
    await buyer.goto(`https://${state.slug}.localhost:${LIVE_PORT}/cart`);
    await buyer.getByLabel("Quantity").fill("3");
    await buyer.getByRole("button", { name: /Update/i }).click(); // VERIFY WHEN ON
    await expect(buyer.getByText("$29.70").first()).toBeVisible(); // 3 x 990 = 2970 cents, as the server prices it
    await buyer.getByLabel("Quantity").fill(String(QTY));
    await buyer.getByRole("button", { name: /Update/i }).click();
    await expect(buyer.getByText(LINE.shown).first()).toBeVisible();
  });

  // J-14 (D-SITES): the form comes back refilled with the error by the field. Needs the cart from J-9..J-12.
  test("J-14: a bad zip comes back with the typed values and the error by the field", async () => {
    test.fixme(true, "D-SITES + D-REN: POST /_o/<siteId> is not wired in the sites router and the order form markup is not merged (depends on J-9..J-12's cart)");
    await placeOrder({ ...MARIA, zip: "abc" }, { addItem: false });
    await expect(buyer.getByLabel("Name")).toHaveValue(MARIA.name); // refilled
    await expect(buyer.getByLabel("Zip")).toHaveValue("abc");
    await expect(buyer.getByLabel("Note")).toHaveValue(MARIA.note); // buyer text comes back as typed, tags included
    await expect(buyer.getByRole("alert").first()).toBeVisible(); // the error text is Plan 3's
    await expectAccessible(buyer);
  });

  // J-13 (D-SITES, D-ADDR, D-REN): the order is sent. First order of a site is #1001. It reuses J-12's cart (addItem false)
  // and fills every field itself, so it does not rely on what J-14 left in the form. Needs J-8's confirmed address.
  test("J-13: the buyer sends the order and sees the received page", async () => {
    test.fixme(true, "D-SITES + D-ADDR + D-REN: no order endpoint in the sites router, no confirmed order address (orders are refused without one), no order form markup");
    await placeOrder(MARIA, { addItem: false });
    await expect(buyer.getByText("1001")).toBeVisible();
    // Buyer text is shown as text: the tags are visible characters and no <b> element was made.
    await expect(buyer.getByText("<b>x</b>", { exact: false }).first()).toBeVisible(); // VERIFY WHEN ON: the received page must echo the note; if it does not, drop this line (J-14's toHaveValue and J-17 cover the text)
    await expect(buyer.locator("b", { hasText: /^x$/ })).toHaveCount(0);
    await expectAccessible(buyer);
  });

  // J-15 (D-MAIL): the order email in the dev outbox.
  test("J-15: the order email for #1001 is in the outbox, sent to the client's order address", async () => {
    test.fixme(true, "D-MAIL: the order email sender is not in code yet (orders are stored with email_status 'pending'); depends on J-13");
    const text = await latestEmail(owner.request, state.orderAddress, /1001/); // VERIFY WHEN ON: the subject wording
    expect(text).toContain(MOM_FLIPFLOP.name);
    expect(text).toContain("Size 7");
    expect(text).toContain("Black");
    expect(text).toContain(`${QTY}`);
    expect(text).toContain(MOM_FLIPFLOP.shown); // unit price
    expect(text).toContain(LINE.shown); // line total and subtotal, the server's
    expect(text).toContain("Maria Lopez");
    expect(text).toContain("Can you deliver Saturday morning?");
    expect(text).toContain("<b>x</b>"); // plain text email: the tags are characters
    expect(text).toContain("Pickup Tuesday to Saturday at our Austin store."); // the note for buyers (J-6)
  });

  test("J-16: the admin lists Order #1001 with the buyer, the subtotal and the email state", async () => {
    test.fixme(true, "D-SITES + D-ADDR + D-MAIL: no order can be placed or emailed yet (depends on J-13 and J-15)");
    const { orders } = await siteOrders();
    expect(orders).toHaveLength(1);
    const order = orders[0]!;
    state.orderId = order.id;
    expect(order).toMatchObject({ number: 1001, name: "Maria Lopez", subtotalCents: LINE.cents, status: "new", spam: false, slug: state.slug });
    // The row's words come from the admin's own words.ts: "Order #{number}" and the email line.
    expect(`Order #${order.number}`).toBe("Order #1001");
    expect(emailLine(order.emailStatus, order.emailError)).toBe("Emailed to the client");
  });

  test("J-17: the order's items and subtotal are exactly the cart's, and the buyer's text is intact", async () => {
    test.fixme(true, "D-SITES + D-ADDR + D-MAIL: no order exists yet (depends on J-16)");
    const detail = await json<AdminOrderDetail>(await adminApi(admin, "GET", `/api/admin/orders/${state.orderId}`));
    expect(detail.items).toEqual([{ name: MOM_FLIPFLOP.name, variantLabel: "Size 7, Color Black", unitCents: MOM_FLIPFLOP.cents, qty: QTY, lineCents: LINE.cents }]); // VERIFY WHEN ON: variantLabel wording
    expect(detail.subtotalCents).toBe(LINE.cents);
    expect(detail.fulfilment).toBe("delivery");
    expect(detail.note).toContain("Can you deliver Saturday morning?");
    expect(detail.note).toContain("<b>x</b>"); // stored as typed; the screens render it as text (OrderDetail.tsx has no raw HTML)
  });

  // J-18 .. J-20 place their own orders with placeOrder. J-14 and J-13 (and J-18) post within seconds, and
  // ORDER_RL allows 3 per minute, so J-19 and J-20 first wait for a fresh window. Orders are found by buyer name.
  test("J-18: staff cancel a second test order; a second cancel is a conflict", async () => {
    test.fixme(true, "D-SITES + D-ADDR: needs a second order placed in the buyer window (depends on J-8)");
    await waitForFreshOrderWindow();
    await placeOrder({ ...MARIA, name: "Test Cancel", email: "cancel@example.com", note: "Test order" });
    const second = (await siteOrders()).orders.find((o) => o.name === "Test Cancel")!;
    expect(second.number).toBe(1002);
    await adminApi(admin, "POST", `/api/admin/orders/${second.id}/cancel`, {});
    expect((await siteOrders()).orders.find((o) => o.name === "Test Cancel")).toMatchObject({ status: "cancelled" });
    const again = await admin.fetch(`https://admin.localhost:${LIVE_PORT}/api/admin/orders/${second.id}/cancel`, { method: "POST", headers: { Origin: `https://admin.localhost:${LIVE_PORT}` }, data: {} });
    expect(again.status()).toBe(409);
    // The screen shows "Order cancelled." and, for the 409, "This order changed while you were looking. ..." (shop-texts B2).
  });

  test("J-19: staff pause the site's orders, the buyer is refused, then orders work again", async () => {
    test.fixme(true, "D-SITES + D-ADDR + D-REN: the buyer's refusal page needs the order endpoint and Plan 3's refusal markup");
    test.setTimeout(150_000);
    await waitForFreshOrderWindow(); // the attempt must be refused as orders_paused, never as rate_limited
    await adminApi(admin, "POST", `/api/admin/sites/${state.siteId}/orders/pause`, {});
    await placeOrder({ ...MARIA, name: "Test Pause", email: "pause@example.com", note: "Test order" });
    await expect(buyer.getByText(/paused/i).first()).toBeVisible(); // VERIFY WHEN ON: Plan 3's refusal wording
    expect((await siteOrders()).orders.find((o) => o.name === "Test Pause")).toBeUndefined();
    await adminApi(admin, "POST", `/api/admin/sites/${state.siteId}/orders/resume`, {});
    const shop = await json<{ ordersPausedAt: number | null }>(await adminApi(admin, "GET", `/api/admin/sites/${state.siteId}/shop`));
    expect(shop.ordersPausedAt).toBeNull();
    // Ordering works again: the same cart goes through and the admin lists it.
    await placeOrder({ ...MARIA, name: "Test Pause", email: "pause@example.com", note: "Test order" }, { addItem: false });
    await expect(buyer.getByText(/^\s*Order|received|thank/i).first()).toBeVisible(); // VERIFY WHEN ON: Plan 3's received wording
    expect((await siteOrders()).orders.find((o) => o.name === "Test Pause")).toMatchObject({ status: "new", spam: false });
  });

  test("J-20: staff mark a junk order as spam; it leaves the Orders list and shows under Spam", async () => {
    test.fixme(true, "D-SITES + D-ADDR: needs junk orders placed in the buyer window");
    test.setTimeout(150_000);
    await waitForFreshOrderWindow();
    // An ordinary order that staff then judge to be junk (at most 3 links, so the sites Worker stores it as spam = 0).
    await placeOrder({ ...MARIA, name: "Test Junk", email: "junk@example.com", note: "Buy my stuff" });
    const junk = (await siteOrders()).orders.find((o) => o.name === "Test Junk")!;
    await adminApi(admin, "POST", `/api/admin/orders/${junk.id}/spam`, {});
    expect((await siteOrders()).orders.map((o) => o.id)).not.toContain(junk.id);
    expect((await siteOrders("1")).orders.map((o) => o.id)).toContain(junk.id);
    // More than 3 links in the note: the sites Worker stores it as spam straight away (order.ts hasTooManyLinks), never in the main list.
    await placeOrder({ ...MARIA, name: "Test Links", email: "links@example.com", note: "http://a.example http://b.example http://c.example http://d.example" });
    expect((await siteOrders()).orders.find((o) => o.name === "Test Links")).toBeUndefined();
    expect((await siteOrders("1")).orders.find((o) => o.name === "Test Links")).toMatchObject({ spam: true, emailStatus: "skipped" });
  });
});

/** A small valid JPEG for the product photo (J-4); sharp is already a dependency of the admin journey. */
async function samplePhoto(): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 230, g: 120, b: 90 } } }).jpeg().toBuffer();
}
