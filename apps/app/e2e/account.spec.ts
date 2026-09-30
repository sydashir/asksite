import { expect, test } from "@playwright/test";
import { acceptInvite, APP, expectAccessible, expectNoSidewaysScroll, stubTurnstile, turnstileRenders, uniqueEmail, waitForSecurityCheck, watchCsp } from "./support.ts";

test("sign in with an emailed link; the button, not the page load, uses the token @mobile", async ({ page }) => {
  const email = uniqueEmail("signin");
  await acceptInvite(page, email);

  // The same page, now a stranger: no cookies, so the app shows the sign-in form.
  await page.context().clearCookies();
  await stubTurnstile(page);
  const violations = watchCsp(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  await expect(page.getByRole("contentinfo").getByRole("link", { name: "help@example.com" })).toHaveAttribute("href", "mailto:help@example.com");
  await waitForSecurityCheck(page);
  await expectAccessible(page);
  await page.getByLabel("Your email address").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByText("If that email has an account, we've sent a link. It can take a few minutes. Didn't get it? Email", { exact: false })).toBeVisible();
  await expect(page.getByRole("status").getByRole("link", { name: "help@example.com" })).toHaveAttribute("href", "mailto:help@example.com");
  expect(violations).toEqual([]);

  let text = "";
  await expect
    .poll(async () => {
      const res = await page.request.get(`${APP}/api/dev/outbox?to=${encodeURIComponent(email)}`);
      text = ((await res.json()) as { messages: Array<{ text: string }> }).messages[0]?.text ?? "";
      return text;
    })
    .toContain(`${APP}/login#`);
  const link = /https:\/\/app\.localhost:8787\/login#[A-Za-z0-9_-]{43}/.exec(text)![0];

  await page.goto(link);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash).toBe("");
  const unused = await page.request.get(`${APP}/api/me`);
  expect(unused.status()).toBe(401);
  await expectAccessible(page);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Your websites" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
});

test("an invite link without a token says so, and loads no security check @mobile", async ({ page }) => {
  const requested = await stubTurnstile(page);
  await page.goto("/invite");
  await expect(page.getByText("This link is not complete. Please open the link in your invite email again.")).toBeVisible();
  await expectAccessible(page);
  expect(requested).toEqual([]);
});

test("the security check loads only on the sign-in form, once, for the login action @mobile", async ({ page }) => {
  const requested = await stubTurnstile(page);
  await page.goto("/");
  await waitForSecurityCheck(page);
  expect(requested).toHaveLength(1);
  expect(await turnstileRenders(page)).toMatchObject([{ sitekey: "1x00000000000000000000AA", action: "login" }]);
});

test("the security check fits at 320 px (compact) and 390 px (normal) without sideways scrolling @mobile", async ({ page }) => {
  await stubTurnstile(page);
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/");
  await waitForSecurityCheck(page);
  expect(await turnstileRenders(page)).toMatchObject([{ size: "compact" }]);
  await expectNoSidewaysScroll(page);

  await page.setViewportSize({ width: 390, height: 700 });
  await page.reload();
  await waitForSecurityCheck(page);
  expect(await turnstileRenders(page)).toMatchObject([{ size: "normal" }]);
  await expectNoSidewaysScroll(page);
});

test("the app's policy lets Cloudflare's widget script and frame in, and nothing else new", async ({ request }) => {
  const res = await request.get(`${APP}/`);
  const csp = res.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com");
  expect(csp).toContain("frame-src 'self' https://challenges.cloudflare.com");
  expect(csp).toContain("connect-src 'self'");
});
