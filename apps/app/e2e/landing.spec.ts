import { expect, test, type Page } from "@playwright/test";
import { acceptInvite, APP, expectAccessible, expectNoSidewaysScroll, stubTurnstile, tabTo, uniqueEmail, waitForSecurityCheck } from "./support.ts";

const H1 = "Your business website, built from a few answers.";
const SECTIONS = ["How it works", "Three designs to choose from", "What you get", "Questions"];

async function expectLanding(page: Page) {
  await expect(page.getByRole("heading", { level: 1, name: H1, exact: true })).toBeVisible();
  for (const name of SECTIONS) await expect(page.getByRole("heading", { level: 2, name, exact: true })).toBeVisible();
  await expectNoSidewaysScroll(page);
}

/** Types the address, asks for the link, reads it from the dev outbox and opens it; returns the message's link. */
async function emailLink(page: Page, email: string, path: "/login" | "/invite") {
  await waitForSecurityCheck(page);
  await page.getByLabel("Your email address", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Email me a link", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText(`If we can send a link to ${email} right now, it's on its way. It can take a few minutes. Didn't get it? Email help@example.com.`);
  let text = "";
  await expect
    .poll(async () => {
      const res = await page.request.get(`${APP}/api/dev/outbox?to=${encodeURIComponent(email)}`);
      text = ((await res.json()) as { messages: Array<{ text: string }> }).messages.at(-1)?.text ?? "";
      return text;
    })
    .toContain(`${APP}${path}#`);
  return new RegExp(`https://app\\.localhost:8787${path}#[A-Za-z0-9_-]{43}`).exec(text)![0];
}

test("the signed-out home page is the landing page at 1280, 390 and 320 px, and passes axe @mobile", async ({ page }) => {
  await stubTurnstile(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await expectLanding(page);
  await expectAccessible(page);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await expectLanding(page);
    await expectAccessible(page);
  }
});

test("Get started opens the sign-up page, and the emailed link sets up the website", async ({ page }) => {
  const email = uniqueEmail("landing-signup");
  // Each run uses its own visitor network, so the limit of sign-ups per network a day never mixes tests.
  const network = `198.18.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 254) + 1}`;
  await page.route("**/api/auth/login", (route) => route.continue({ headers: { ...route.request().headers(), "cf-connecting-ip": network } }));
  await stubTurnstile(page);
  await page.goto("/");
  await page.getByRole("main").getByRole("link", { name: "Get started" }).first().click();
  await expect(page).toHaveURL(`${APP}/signup`);
  await expect(page.getByRole("heading", { level: 1, name: "Create your account", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Log in" }).last()).toHaveAttribute("href", "/login");
  const link = await emailLink(page, email, "/invite");
  await page.goto(link);
  await page.getByRole("button", { name: "Set up my website" }).click();
  await page.waitForURL(/\/sites\/[0-9a-f-]{36}\/setup\/business$/);
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
});

test("Log in in the header opens the log-in page, and an existing owner signs in with the emailed link", async ({ page }) => {
  const email = uniqueEmail("landing-login");
  await acceptInvite(page, email);
  await page.context().clearCookies();
  await stubTurnstile(page);
  await page.goto("/");
  await page.getByRole("banner").getByRole("link", { name: "Log in" }).click();
  await expect(page).toHaveURL(`${APP}/login`);
  await expect(page.getByRole("heading", { level: 1, name: "Log in", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Create your account" })).toHaveAttribute("href", "/signup");
  const link = await emailLink(page, email, "/login");
  // The emailed link opens in a new page; from /login a bare goto would only be a hash change on the same page.
  await page.goto("about:blank");
  await page.goto(link);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Your websites" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
});

test("signed in, the home page is still the list of websites, not the landing page", async ({ page }) => {
  await acceptInvite(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Your websites" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: H1 })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Your website", exact: true })).toBeVisible();
});

test("/login#token still opens the sign-in link page, not the form", async ({ page }) => {
  const requested = await stubTurnstile(page);
  await page.goto(`/login#${"a".repeat(43)}`);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByLabel("Your email address")).toHaveCount(0);
  await page.waitForLoadState("networkidle");
  expect(requested).toEqual([]);
});

test("on the log-in page the skip link moves to the content and keeps the form (only a real emailed token reloads it)", async ({ page }) => {
  await stubTurnstile(page);
  await page.goto("/login");
  await expect(page.getByRole("heading", { level: 1, name: "Log in", exact: true })).toBeVisible();
  const skip = page.getByRole("link", { name: "Skip to main content" });
  await tabTo(page, skip);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/login#main$/);
  await expect(page.locator("#main")).toBeFocused();
  await expect(page.getByRole("heading", { level: 1, name: "Log in", exact: true })).toBeVisible();
  await expect(page.getByLabel("Your email address")).toBeVisible();
});

test("an emailed link that is no longer valid offers a new link on the log-in page", async ({ page }) => {
  await page.goto(`/login#${"a".repeat(43)}`);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("link", { name: "Ask for a new link" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { level: 1, name: "Log in", exact: true })).toBeVisible();
});
