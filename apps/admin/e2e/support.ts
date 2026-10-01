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

export async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).exclude("iframe").analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

export async function expectNoSidewaysScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

/**
 * Collects Content-Security-Policy violations from two sources: console text (Chromium and WebKit word them there)
 * and `securitypolicyviolation` events, which every engine fires (Firefox logs nothing a console match can catch).
 * The event listener is added by Playwright's init script, not by a page script, so the page's own policy cannot
 * block it. Only the directive and the blocked URI are kept. Call the returned function when the page has settled
 * to read the violations (the owner app's watchCsp works the same way).
 */
export function watchCsp(page: Page): () => Promise<string[]> {
  const consoleViolations: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy/i.test(message.text())) consoleViolations.push(message.text());
  });
  void page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __cspViolations: string[] }).__cspViolations = seen;
    document.addEventListener("securitypolicyviolation", (event) => {
      seen.push(`${event.violatedDirective} blocked ${event.blockedURI}`);
    });
  });
  return async () => {
    const events = await page.evaluate(() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? []);
    return [...consoleViolations, ...events];
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
