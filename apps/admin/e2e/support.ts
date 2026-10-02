import AxeBuilder from "@axe-core/playwright";
import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";

export const ADMIN = "https://admin.localhost:8788";

export const FACTS = {
  businessName: "Joe's Plumbing",
  trade: "plumbing",
  phone: "+15125550142",
  email: "office@joesplumbing.example",
  location: { city: "Austin", state: "TX" },
  serviceArea: { places: ["Austin"] },
  services: [{ name: "Drain cleaning" }],
};

/** An owner whose site is waiting for review (test Worker helper). */
export async function pendingSite(request: APIRequestContext, facts: object = FACTS, options: { emailDomain?: string } = {}) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const email = `owner-${suffix}@${options.emailDomain ?? "example.com"}`;
  const res = await request.post(`${ADMIN}/__test/sites`, { data: { email, slug: `joes-${suffix}`, facts, reviewsAreReal: true } });
  expect(res.ok()).toBe(true);
  return { ...((await res.json()) as { siteId: string; versionId: string; ownerId: string }), slug: `joes-${suffix}`, email };
}

/** What the review says, once, when Approve turns on. */
export const UNLOCKED = "Every page has been looked at. You can approve now.";

/**
 * Shows every page of the version in the review's preview, one by one, and waits until each one counts as looked at: the gate line
 * under Approve stops naming it. Approve is then on. (Waiting on that line, never on a timer, so a slow machine never clicks on before a frame loaded.)
 */
export async function showEveryPage(page: Page) {
  const group = page.getByRole("group", { name: "Page", exact: true });
  await expect(group).toBeVisible();
  for (const name of await group.getByRole("button").allTextContents()) {
    await group.getByRole("button", { name, exact: true }).click();
    await expect(page.getByText(new RegExp(`Not looked at yet:.*\\b${name}\\b`))).toHaveCount(0);
  }
  await expect(page.getByRole("button", { name: "Approve and publish" })).toHaveAttribute("aria-disabled", "false");
}

export async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).exclude("iframe").analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

export async function expectNoSidewaysScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

/**
 * Collects Content-Security-Policy violations from two sources: console text (Chromium and WebKit word them there;
 * entries start with "console ") and `securitypolicyviolation` events, which every engine fires (Firefox logs nothing
 * a console match can catch; entries start with "event " and keep the effective directive and the blocked URI). The
 * event listener is added by Playwright's init script, not by a page script, so the page's own policy cannot block it.
 * It reports through page.exposeBinding, so events reach Node at once and survive navigations. Awaiting this call
 * guarantees both are in place before the first navigation. The returned reader throws when the collector is missing
 * from the page, never an empty list. (Same design as the owner app's watchCsp in lane C, commit 115cbd0.)
 */
export async function watchCsp(page: Page): Promise<() => Promise<string[]>> {
  const seen: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy/i.test(message.text())) seen.push(`console ${message.text()}`);
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

/** Tab (Shift+Tab with `back`) until `target` has focus; WebKit presses Option+Tab, which also reaches links, as Safari users do. */
export async function tabTo(page: Page, target: Locator, options: { back?: boolean; max?: number } = {}) {
  const tab = page.context().browser()?.browserType().name() === "webkit" ? "Alt+Tab" : "Tab";
  const key = options.back ? `Shift+${tab}` : tab;
  for (let i = 0; i < (options.max ?? 80); i += 1) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press(key);
  }
  throw new Error(`could not reach ${target.toString()} with ${key}`);
}
