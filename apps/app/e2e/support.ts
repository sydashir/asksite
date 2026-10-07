import AxeBuilder from "@axe-core/playwright";
import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";

export const APP = "https://app.localhost:8787";

export const FACTS = {
  businessName: "Joe's Plumbing",
  trade: "plumbing",
  phone: "+15125550142",
  email: "office@joesplumbing.example",
  location: { city: "Austin", state: "TX" },
  serviceArea: { places: ["Austin", "Round Rock"] },
  services: [{ name: "Drain cleaning", startingPrice: 89 }, { name: "Water heaters" }],
};
export const BRIEF = { tone: "friendly", goal: "call" };

export const uniqueEmail = (label: string) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
export const uniqueSlug = (label: string) => `${label}-${Math.random().toString(36).slice(2, 8)}`;

/** Invite (as the admin would) and accept it in the browser. Returns the new site's id. */
export async function acceptInvite(page: Page, email = uniqueEmail("owner")): Promise<string> {
  const res = await page.request.post(`${APP}/__test/invites`, { data: { email } });
  const { token } = (await res.json()) as { token: string };
  await page.goto(`/invite#${token}`);
  await page.getByRole("button", { name: "Set up my website" }).click();
  await page.waitForURL(/\/sites\/[0-9a-f-]{36}\/setup\/business$/);
  return new URL(page.url()).pathname.split("/")[2]!;
}

/** Same-origin API call from the signed-in browser context (sends the session cookie and our Origin). */
export async function apiCall(page: Page, method: string, path: string, data?: unknown) {
  const res = await page.request.fetch(`${APP}${path}`, { method, headers: { Origin: APP }, ...(data === undefined ? {} : { data }) });
  return { status: res.status(), json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

/**
 * Writes a first draft and a web address for the site acceptInvite just opened. That page saves its own prefill (the business email,
 * BusinessStep.tsx) at rev 1 soon after it loads, so a write at a fixed rev 1 can be refused with 409. This waits for that save, writes
 * at the rev the server holds, and asserts both writes worked (a refused seed would otherwise show up as a hang much later).
 */
export async function seedDraft(page: Page, siteId: string, slugLabel: string, facts: object = FACTS): Promise<void> {
  await expect(page.getByRole("status").filter({ hasText: "All changes saved." })).toBeVisible();
  const rev = (await apiCall(page, "GET", `/api/sites/${siteId}`)).json!["rev"] as number;
  const draft = await apiCall(page, "PATCH", `/api/sites/${siteId}/draft`, { rev, facts, brief: BRIEF });
  expect(draft.status).toBe(200);
  const slug = await apiCall(page, "PUT", `/api/sites/${siteId}/slug`, { rev: draft.json!["rev"], slug: uniqueSlug(slugLabel) });
  expect(slug.status).toBe(200);
}

/** A signed-in owner whose first draft has been written (with `copy` in place of the test draft's own wording, if given). Returns the site id. */
export async function builtSite(page: Page, facts: object = FACTS, copy?: object): Promise<string> {
  const siteId = await acceptInvite(page);
  await seedDraft(page, siteId, "joes", facts);
  const started = await apiCall(page, "POST", `/api/sites/${siteId}/generations`, {});
  const generationId = (started.json?.["generation"] as { id: string }).id;
  await finishGeneration(page.request, generationId, "succeeded", copy);
  return siteId;
}

/** Ends a generation as the generator would; a success stores the test draft, with `copy` fields in place of its own if given. */
export async function finishGeneration(request: APIRequestContext, generationId: string, status: "succeeded" | "failed" = "succeeded", copy?: object) {
  await request.post(`${APP}/__test/generations/${generationId}/finish`, { data: { status, ...(copy === undefined ? {} : { copy }) } });
}

/** WCAG 2.2 AA with axe (the same tags as Plan 1). The preview iframe is Plan 1's page and is tested there. */
export async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).exclude("iframe").analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

/** No sideways scrolling at this width (WCAG 1.4.10). */
export async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

/**
 * Collects Content-Security-Policy violations from two sources: console text (Chromium and WebKit
 * word them there; entries start with "console ") and `securitypolicyviolation` events, which every
 * engine fires (Firefox logs nothing a console match can catch; entries start with "event " and keep
 * the effective directive and the blocked URI). The event listener is added by Playwright's init
 * script, not by a page script, so the page's own policy cannot block it. It reports through
 * page.exposeBinding, so the events reach Node at once and survive navigations. Awaiting this call
 * guarantees both are in place before the first navigation. The returned reader throws when the
 * collector is missing from the page, never an empty list.
 */
export async function watchCsp(page: Page): Promise<() => Promise<string[]>> {
  const seen: string[] = [];
  page.on("console", (message) => {
    if (/Content[- ]Security[- ]Policy/i.test(message.text())) seen.push(`console ${message.text()}`);
  });
  await page.exposeBinding("__reportCspViolation", (_source, entry: string) => {
    seen.push(`event ${entry}`);
  });
  await page.addInitScript(() => {
    const report = (window as unknown as { __reportCspViolation: (entry: string) => Promise<void> }).__reportCspViolation;
    (window as unknown as { __cspCollector: boolean }).__cspCollector = true;
    document.addEventListener("securitypolicyviolation", (event) => {
      void report(`${event.effectiveDirective} ${event.blockedURI}`);
    });
  });
  return async () => {
    const installed = await page.evaluate(() => (window as unknown as { __cspCollector?: boolean }).__cspCollector === true);
    if (!installed) throw new Error("watchCsp: the violation collector is missing from this page");
    return [...seen];
  };
}

/** Phones show the editor and the preview one at a time (§3.1 step 5): switch to the preview there. */
export async function showPreview(page: Page) {
  if ((page.viewportSize()?.width ?? 1280) < 768) await page.getByRole("button", { name: "Preview", exact: true }).click();
}

/**
 * Press Tab (or Shift+Tab with `back`) until `target` has focus: proves it can be reached with the
 * keyboard alone. WebKit, like Safari by default, skips links and buttons on Tab; Safari users reach
 * them with Option+Tab, so WebKit presses that.
 */
export async function tabTo(page: Page, target: Locator, options: { back?: boolean; max?: number } = {}) {
  const tab = page.context().browser()?.browserType().name() === "webkit" ? "Alt+Tab" : "Tab";
  const key = options.back ? `Shift+${tab}` : tab;
  for (let i = 0; i < (options.max ?? 80); i += 1) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press(key);
  }
  throw new Error(`could not reach ${target.toString()} with ${key}`);
}

const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js*";

/** Cloudflare's documented dummy token (developers.cloudflare.com/turnstile/troubleshooting/testing/). */
export const TURNSTILE_DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

/**
 * Stands in for Cloudflare's widget script, so browser tests never touch the network (M2). It copies the
 * documented render API (sitekey, action, size, callback), draws a box of the documented size (normal
 * 300x65, compact 150x140) so layout tests are real, and answers with the dummy token 50 ms after each
 * render or reset. The Worker under test holds Cloudflare's always-pass test secret, which accepts that
 * token. The URL is unchanged, so the app's Content-Security-Policy still decides whether the script loads.
 * Every render is recorded on `window.__turnstileRenders`. Returns the script URLs requested so far.
 * Task 27 checks the real widget on the real domain.
 */
export async function stubTurnstile(page: Page): Promise<string[]> {
  const requested: string[] = [];
  await page.route(TURNSTILE_SCRIPT, (route) => {
    requested.push(route.request().url());
    return route.fulfill({
      contentType: "application/javascript",
      body: `(function () {
  var renders = (window.__turnstileRenders = []);
  var boxes = {};
  var callbacks = {};
  var seq = 0;
  function solve(id) {
    setTimeout(function () {
      var box = boxes[id];
      if (!box) return;
      box.setAttribute("data-state", "solved");
      box.textContent = "Verified (test stub)";
      callbacks[id]("${TURNSTILE_DUMMY_TOKEN}");
    }, 50);
  }
  window.turnstile = {
    render: function (target, options) {
      var container = typeof target === "string" ? document.querySelector(target) : target;
      var size = options.size || "normal";
      var box = document.createElement("div");
      var id = "stub-" + ++seq;
      box.setAttribute("data-stub-turnstile", id);
      box.setAttribute("data-state", "working");
      box.style.cssText = "box-sizing:border-box;border:1px solid #555;background:#fff;color:#111;font:14px sans-serif;padding:8px;width:" + (size === "compact" ? "150px;height:140px" : "300px;height:65px");
      box.textContent = "Security check (test stub)";
      container.appendChild(box);
      boxes[id] = box;
      callbacks[id] = options.callback;
      renders.push({ sitekey: options.sitekey, action: options.action, size: size });
      solve(id);
      return id;
    },
    reset: function (id) {
      var box = boxes[id];
      if (!box) return;
      box.setAttribute("data-state", "working");
      box.textContent = "Security check (test stub)";
      solve(id);
    },
    remove: function (id) {
      if (boxes[id]) boxes[id].remove();
      delete boxes[id];
    },
    getResponse: function () {
      return undefined;
    }
  };
})();`,
    });
  });
  return requested;
}

/** The widget's records of how it was rendered (see stubTurnstile). */
export function turnstileRenders(page: Page): Promise<Array<{ sitekey: string; action: string; size: string }>> {
  return page.evaluate(() => (window as unknown as { __turnstileRenders?: Array<{ sitekey: string; action: string; size: string }> }).__turnstileRenders ?? []);
}

/** Waits until the sign-in widget has produced its token (the stub marks its box "solved"). */
export async function waitForSecurityCheck(page: Page) {
  await expect(page.locator("[data-stub-turnstile][data-state=solved]")).toHaveCount(1);
}

/** Asks for new wording through the dialog. Returns the generation's id; finish it with finishGeneration. */
export async function askNewWording(page: Page, siteId: string): Promise<string> {
  await page.getByRole("tab", { name: "Words" }).click();
  await page.getByRole("button", { name: "Write new wording" }).click();
  const [started] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/api/sites/${siteId}/generations`) && r.request().method() === "POST"),
    page.getByRole("dialog", { name: "Write new wording?" }).getByRole("button", { name: "Write new wording" }).click(),
  ]);
  return ((await started.json()) as { generation: { id: string } }).generation.id;
}

/** Answers the next `count` GETs of the site (or every one, with Infinity) with a 503, once armed. Returns how many it failed. */
export async function failSiteGets(page: Page, siteId: string, count: number) {
  const gate = { armed: false, failed: 0 };
  await page.route(`**/api/sites/${siteId}`, (route) => {
    if (!gate.armed || route.request().method() !== "GET" || gate.failed >= count) return route.fallback();
    gate.failed += 1;
    return route.fulfill({ status: 503, json: { error: { code: "internal", message: "Something went wrong. Please try again." } } });
  });
  return gate;
}
