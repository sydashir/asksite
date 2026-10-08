import { expect, test } from "@playwright/test";
import { acceptInvite, APP, expectAccessible, expectNoSidewaysScroll, stubTurnstile, turnstileRenders, uniqueEmail, waitForSecurityCheck, watchCsp } from "./support.ts";

test("sign in with an emailed link; the button, not the page load, uses the token @mobile @firefox", async ({ page }) => {
  const email = uniqueEmail("signin");
  await acceptInvite(page, email);

  // The same page, now a stranger: no cookies, so the app shows the sign-in form.
  await page.context().clearCookies();
  await stubTurnstile(page);
  const violations = await watchCsp(page);
  await page.goto("/login");
  // Open self sign-up (DECIDED 2026-10-07): the same form on /login and /signup, with the decided heading, helper, button and answer.
  await expect(page.getByRole("heading", { level: 1, name: "Log in", exact: true })).toBeVisible();
  await expect(page.getByText("Enter your email and we'll send you a link.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  await expect(page.getByRole("contentinfo").getByRole("link", { name: "help@example.com" })).toHaveAttribute("href", "mailto:help@example.com");
  await waitForSecurityCheck(page);
  await expectAccessible(page);
  await page.getByLabel("Your email address", { exact: true }).fill(` ${email.toUpperCase()} `);
  await page.getByRole("button", { name: "Email me a link", exact: true }).click();
  // {email} is the address as the server uses it: trimmed and lower-cased.
  await expect(page.getByRole("status")).toHaveText(`If we can send a link to ${email} right now, it's on its way. It can take a few minutes. Didn't get it? Email help@example.com.`);
  await expect(page.getByRole("status").getByRole("link", { name: "help@example.com" })).toHaveAttribute("href", "mailto:help@example.com");
  await expectAccessible(page);
  expect(await violations()).toEqual([]);

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

// Open self sign-up (DECIDED 2026-10-07): an unknown email on the same form gets a sign-up link; the existing invite page
// sets up the owner and the site and opens the questionnaire. Each run uses its own visitor network (CF-Connecting-IP on
// the sign-in request), so the limit of 3 sign-ups per network a day never mixes projects or tests.
test("an unknown email signs up on the same form: the emailed link sets up the website and opens the questionnaire", async ({ page }) => {
  const email = uniqueEmail("signup");
  const network = `198.18.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 254) + 1}`;
  await page.route("**/api/auth/login", (route) => route.continue({ headers: { ...route.request().headers(), "cf-connecting-ip": network } }));
  await stubTurnstile(page);
  await page.goto("/signup");
  await expect(page.getByRole("heading", { level: 1, name: "Create your account", exact: true })).toBeVisible();
  await waitForSecurityCheck(page);
  await page.getByLabel("Your email address").fill(email);
  await page.getByRole("button", { name: "Email me a link" }).click();
  await expect(page.getByRole("status")).toHaveText(`If we can send a link to ${email} right now, it's on its way. It can take a few minutes. Didn't get it? Email help@example.com.`);

  let message = { subject: "", text: "", tag: "" };
  await expect
    .poll(async () => {
      const res = await page.request.get(`${APP}/api/dev/outbox?to=${encodeURIComponent(email)}`);
      message = ((await res.json()) as { messages: Array<typeof message> }).messages[0] ?? message;
      return message.text;
    })
    .toContain(`${APP}/invite#`);
  expect(message.subject).toBe("Set up your business website");
  expect(message.tag).toBe("signup_invite");
  const link = /https:\/\/app\.localhost:8787\/invite#[A-Za-z0-9_-]{43}/.exec(message.text)![0];

  await page.goto(link);
  // RULED 2026-10-07: one neutral text on the invite page for admin invites and sign-up links alike.
  await expect(page.getByText("Build a website for your business. It takes about 15 minutes, and you can stop and come back at any time.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Set up my website" }).click();
  await page.waitForURL(/\/sites\/[0-9a-f-]{36}\/setup\/business$/);
  await expect(page.getByRole("heading", { level: 1, name: "Your business" })).toBeVisible();
  expect((await page.request.get(`${APP}/api/me`)).status()).toBe(200);
});

// Decision 31 on the invite page: the token leaves the address bar on open, and only the button spends it.
test("the invite page removes the token from the address on open, sends nothing until the button, and the button spends it @mobile", async ({ page }) => {
  const email = uniqueEmail("invite31");
  const res = await page.request.post(`${APP}/__test/invites`, { data: { email } });
  const { token } = (await res.json()) as { token: string };
  const claims: string[] = [];
  page.on("request", (request) => request.url().includes("/api/auth/invite/accept") && claims.push(request.method()));

  await page.goto(`/invite#${token}`);
  const accept = page.getByRole("button", { name: "Set up my website" });
  await expect(accept).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash).toBe("");
  expect(page.url()).not.toContain(token);
  await page.waitForLoadState("networkidle");
  expect(claims).toEqual([]); // opening the link (a mail scanner does this) spends nothing
  expect((await page.request.get(`${APP}/api/me`)).status()).toBe(401); // and signs nobody in

  await accept.click(); // the token was read before the address was cleaned, so the button still has it
  await page.waitForURL(/\/sites\/[0-9a-f-]{36}\/setup\/business$/);
  expect(claims).toEqual(["POST"]);
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
  await page.goto("/login");
  await waitForSecurityCheck(page);
  expect(requested).toHaveLength(1);
  expect(await turnstileRenders(page)).toMatchObject([{ sitekey: "1x00000000000000000000AA", action: "login" }]);
});

test("the sign-in link page (/login#token) loads no security check, and Cloudflare's script is still requested only once @mobile", async ({ page }) => {
  const requested = await stubTurnstile(page);
  await page.goto("/login");
  await waitForSecurityCheck(page);
  expect(requested).toHaveLength(1);

  await page.goto(`/login#${"a".repeat(43)}`);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(requested).toHaveLength(1);
  expect(await turnstileRenders(page)).toEqual([]);
});

test("the security check fits at 320 px (compact) and 390 px (normal) without sideways scrolling @mobile", async ({ page }) => {
  await stubTurnstile(page);
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/login");
  await waitForSecurityCheck(page);
  expect(await turnstileRenders(page)).toMatchObject([{ size: "compact" }]);
  await expectNoSidewaysScroll(page);

  await page.setViewportSize({ width: 390, height: 700 });
  await page.reload();
  await waitForSecurityCheck(page);
  expect(await turnstileRenders(page)).toMatchObject([{ size: "normal" }]);
  await expectNoSidewaysScroll(page);
});

// STRICT (honesty): when Cloudflare's script cannot load, the owner is told so and can try again; never "complete the check" with no check on screen.
test("if the security check cannot load, the owner is told and Try again brings it back @mobile", async ({ page }) => {
  await page.route("https://challenges.cloudflare.com/turnstile/v0/api.js*", (route) => route.abort());
  await page.goto("/login");
  await expect(page.getByText("The security check didn't load. If you use an ad blocker, allow this page, then press Try again.")).toBeVisible();
  await expectAccessible(page);
  await expect(page.locator("[data-stub-turnstile]")).toHaveCount(0);

  await page.unroute("https://challenges.cloudflare.com/turnstile/v0/api.js*");
  await stubTurnstile(page);
  await page.getByRole("button", { name: "Try again" }).click();
  await waitForSecurityCheck(page);
  await expect(page.getByText("The security check didn't load.")).toHaveCount(0);
  const retry = uniqueEmail("retry");
  await page.getByLabel("Your email address").fill(retry);
  await page.getByRole("button", { name: "Email me a link" }).click();
  await expect(page.getByRole("status")).toHaveText(`If we can send a link to ${retry} right now, it's on its way. It can take a few minutes. Didn't get it? Email help@example.com.`);
});

test("the app's policy lets Cloudflare's widget script and frame in, and nothing else new", async ({ request }) => {
  const res = await request.get(`${APP}/`);
  const csp = res.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com");
  expect(csp).toContain("frame-src 'self' https://challenges.cloudflare.com");
  expect(csp).toContain("connect-src 'self'");
});
