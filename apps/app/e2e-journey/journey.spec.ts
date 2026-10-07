import { expect, test, type Page } from "@playwright/test";
import { adminApi, APP, expectAccessible, expectLive, latestEmail, LIVE_PORT, pageUrl, reviewVersion } from "./support.ts";

/** Saves the current questionnaire step and waits for the next one: every step has the same button. */
async function continueTo(page: Page, heading: string) {
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByRole("heading", { level: 1, name: heading })).toBeFocused();
}

test("invite, questionnaire, AI draft, edit, publish, approve, live pages, contact form, lead", async ({ browser }, testInfo) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: testInfo.project.use.viewport ?? null });
  const owner = await context.newPage();
  const adminContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const admin = adminContext.request;
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const email = `journey-${stamp}@example.com`;
  const slug = `journey-${stamp}`;

  // 1. The admin invites the owner by email; the link arrives only in the email.
  await adminApi(admin, "POST", "/api/admin/invites", { email });
  const invite = /https:\/\/app\.localhost:8789\/invite#[A-Za-z0-9_-]{43}/.exec(await latestEmail(owner.request, email, /invited/))![0];

  // 2. The owner accepts and answers the questionnaire.
  await owner.goto(invite);
  await owner.getByRole("button", { name: "Set up my website" }).click();
  await expect(owner.getByRole("heading", { level: 1, name: "Your business" })).toBeFocused();
  await owner.getByLabel("Business name").fill("Journey Plumbing");
  await owner.getByLabel("What kind of work do you do?").selectOption("plumbing");
  await owner.getByLabel("Business phone number").fill("(512) 555-0142");
  await owner.getByLabel("City").fill("Austin");
  await owner.getByLabel("State", { exact: true }).selectOption("TX");
  await continueTo(owner, "Your services");
  await owner.getByLabel("Service 1", { exact: true }).fill("Drain cleaning");
  await continueTo(owner, "Where you work and when");
  await owner.getByLabel("Place 1").fill("Austin");
  await continueTo(owner, "Why customers can trust you");
  await continueTo(owner, "Photos and links");
  await continueTo(owner, "In your own words");
  await owner.getByLabel("Friendly").check();
  await owner.getByLabel("Call us").check();
  await continueTo(owner, "Your web address");
  await owner.getByLabel("Web address").fill(slug);
  await expect(owner.getByText("This address is free. Save it to keep it.")).toBeVisible();
  await owner.getByRole("button", { name: "Save this web address" }).click();
  await expect(owner.getByText("This is your web address.")).toBeVisible();
  const siteId = new URL(owner.url()).pathname.split("/")[2]!;
  await owner.getByRole("button", { name: "Build my website" }).click();

  // 3. The generator (fake provider) writes the first draft; the editor opens.
  await owner.waitForURL(/\/edit$/, { timeout: 120_000 });
  await expectAccessible(owner);
  const headline = owner.getByLabel("Headline", { exact: true });
  await headline.fill("Journey Plumbing keeps Austin flowing");
  await expect(owner.getByRole("status").filter({ hasText: "All changes saved." })).toBeVisible();

  // 4. Publish: a version waits for approval.
  await owner.getByRole("link", { name: "Publish" }).click();
  await owner.getByRole("button", { name: "Send for review" }).click();
  await expect(owner.getByRole("heading", { name: "Waiting for approval" })).toBeVisible();

  // 5. The admin reviews the exact stored pages (each served sandboxed, each hashing to its listed sha256)
  // and approves the digest of all of them. This site has no photos, so it has no Gallery.
  const queue = (await (await adminApi(admin, "GET", "/api/admin/reviews")).json()) as { items: Array<{ version: { id: string; number: number }; site: { slug: string | null } }> };
  const item = queue.items.find((i) => i.site.slug === slug)!;
  expect(item.version.number).toBe(1);
  const reviewed = await reviewVersion(admin, item.version.id, { gallery: false });
  expect(reviewed.html["home"]).toContain("Journey Plumbing keeps Austin flowing");
  const approved = (await (await adminApi(admin, "POST", `/api/admin/versions/${item.version.id}/approve`, { htmlSha256: reviewed.htmlSha256 })).json()) as { liveUrl: string };
  await latestEmail(owner.request, email, /Your website is live/);

  // 6. Every page is served on the customer's subdomain by the sites Worker, straight after the approval.
  const live = pageUrl(slug, "home");
  expect(live).toBe(`https://${slug}.localhost:${LIVE_PORT}/`);
  expect(approved.liveUrl).toBe(live);
  const visitor = await context.newPage();
  await expectLive(visitor.request, slug, reviewed.pages);
  await visitor.goto(live);
  await expect(visitor.getByRole("heading", { level: 1 })).toHaveText("Journey Plumbing keeps Austin flowing");

  // 7. A visitor opens the form on the Contact page and sends it; the owner gets the lead by email and in the app.
  // The first visible link to the form: the hero button at every width (the call bar's "Get a quote" is phone-only).
  await visitor.locator('a[href="/contact#quote"]:visible').first().click();
  await expect(visitor).toHaveURL(`${pageUrl(slug, "contact")}#quote`);
  await expect(visitor.locator("form#quote")).toHaveAttribute("action", `https://${slug}.localhost:${LIVE_PORT}/_f/${siteId}`);
  await visitor.getByLabel("Name").fill("Maria Visitor");
  await visitor.getByLabel("Phone").fill("(512) 555-0199");
  await visitor.getByLabel("How can we help? (optional)").fill("Kitchen sink is slow");
  await visitor.getByRole("button", { name: "Send request" }).click();
  await expect(visitor.getByRole("heading", { level: 1, name: "Thanks! Your message was sent to Journey Plumbing." })).toBeVisible();
  await latestEmail(owner.request, email, /New request from your website: Maria Visitor/);
  await owner.goto(`${APP}/`);
  await owner.getByRole("link", { name: "Messages" }).click();
  await expect(owner.getByRole("heading", { level: 2, name: "Maria Visitor" })).toBeVisible();
  await expectAccessible(owner);

  await context.close();
  await adminContext.close();
});
