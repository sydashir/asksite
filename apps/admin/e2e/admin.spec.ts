import { expect, test, type Page } from "@playwright/test";
import { ADMIN, expectAccessible, expectNoSidewaysScroll, FACTS, pendingSite, tabTo, watchCsp } from "./support.ts";

const FRAME = 'iframe[title="Page under review"]';

/** A site that was approved, so it is live: its detail page is /sites/<siteId>. */
async function liveSite(page: Page, options: { emailDomain?: string } = {}) {
  const site = await pendingSite(page.request, FACTS, options);
  await page.goto(`/reviews/${site.versionId}`);
  await page.getByRole("button", { name: "Approve and publish" }).click();
  await expect(page.getByText("Approved.", { exact: false })).toBeVisible();
  return site;
}

test("review a site: the stored page shows in a sandboxed frame, flags are listed, and approving publishes it", async ({ page }) => {
  const csp = watchCsp(page);
  const site = await pendingSite(page.request, { ...FACTS, testimonials: [{ quote: "Pay at paypa1-help.com", name: "A" }] });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Waiting for review" })).toBeFocused();
  await page.getByRole("link", { name: `Review ${site.slug} version 1` }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Review Joe's Plumbing (version 1)" })).toBeFocused();

  const frame = page.frameLocator(FRAME);
  await expect(frame.getByRole("link", { name: "Call Joe today" }).first()).toBeAttached();
  await expect(page.locator(FRAME)).toHaveAttribute("sandbox", "");
  await expect(page.getByText("Links are turned off in the preview.")).toBeVisible();
  await expect(page.getByText("facts.testimonials.0.quote contains a web address", { exact: false })).toBeVisible();
  await expect(page.getByText("copy.ctaText", { exact: false })).toBeVisible();
  await expectAccessible(page);
  await expectNoSidewaysScroll(page);

  await page.getByLabel("Allow search engines to list this site").uncheck();
  await page.getByRole("button", { name: "Approve and publish" }).click();
  await expect(page.getByText("Approved. We'll email the owner. The site goes live within about a minute:")).toBeVisible();
  await expect(page.getByRole("link", { name: `https://${site.slug}.localhost:8789/` })).toBeVisible();
  expect(csp).toEqual([]);
});

test("the preview shows the stored page without leaving it: its links are off, and the stored bytes are untouched", async ({ page }) => {
  const site = await pendingSite(page.request);
  const adminRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/admin/")) adminRequests.push(request.url());
  });
  await page.goto(`/reviews/${site.versionId}`);
  const cta = page.frameLocator(FRAME).getByRole("link", { name: "Call Joe today" }).first();
  await expect(cta).toBeAttached();
  const stored = await (await page.request.get(`${ADMIN}/api/admin/versions/${site.versionId}/page`)).text();
  expect(stored).not.toContain("a[href]{pointer-events:none;cursor:default}");
  await expect(cta).toHaveCSS("pointer-events", "none");
  const before = adminRequests.length;
  await cta.click({ force: true });
  const frame = page.frames().find((f) => f.parentFrame() !== null);
  expect(frame?.url()).toBe("about:srcdoc");
  await expect(cta).toBeAttached();
  expect(adminRequests.length).toBe(before);
});

test("the review page says when the stored page could not load, and loads it on Try again", async ({ page }) => {
  const site = await pendingSite(page.request);
  await page.route("**/api/admin/versions/*/page", (route) => route.fulfill({ status: 500, json: { error: { code: "internal", message: "Something went wrong." } } }));
  await page.goto(`/reviews/${site.versionId}`);
  await expect(page.getByText("The page couldn't load.")).toBeVisible();
  await page.unroute("**/api/admin/versions/*/page");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.frameLocator(FRAME).getByRole("link", { name: "Call Joe today" }).first()).toBeAttached();
});

test("rejecting needs a note, which is then sent", async ({ page }) => {
  const site = await pendingSite(page.request);
  await page.goto(`/reviews/${site.versionId}`);
  await page.getByRole("button", { name: "Reject and email the owner" }).click();
  await expect(page.getByLabel("Reason (the owner sees this)")).toBeFocused();
  await expect(page.getByText("Write a note for the owner.")).toBeVisible();
  await page.getByLabel("Reason (the owner sees this)").fill("Please use photos of your own work.");
  await page.getByRole("button", { name: "Reject and email the owner" }).click();
  await expect(page.getByText("Rejected. We'll email the owner your note.")).toBeVisible();
});

test("the internal note is labelled as not shown to the owner", async ({ page }) => {
  const site = await pendingSite(page.request);
  await page.goto(`/reviews/${site.versionId}`);
  await expect(page.getByLabel("Internal note (optional, not shown to the owner)")).toBeVisible();
});

test("a live address that is not safe to link shows as plain text", async ({ page }) => {
  const site = await pendingSite(page.request);
  await page.route("**/api/admin/versions/*/approve", (route) => route.fulfill({ json: { siteId: site.siteId, liveUrl: "javascript:alert(1)" } }));
  await page.goto(`/reviews/${site.versionId}`);
  await page.getByRole("button", { name: "Approve and publish" }).click();
  await expect(page.getByText("javascript:alert(1)", { exact: false })).toBeVisible();
  await expect(page.locator('a[href^="javascript"]')).toHaveCount(0);
});

test("when approving fails with a server error, Approve stays available to try again", async ({ page }) => {
  const site = await pendingSite(page.request);
  await page.route("**/api/admin/versions/*/approve", (route) => route.fulfill({ status: 500, json: { error: { code: "internal", message: "Something went wrong. Please try again." } } }));
  await page.goto(`/reviews/${site.versionId}`);
  await page.getByRole("button", { name: "Approve and publish" }).click();
  await expect(page.getByText("Something went wrong. Please try again.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve and publish" })).toBeEnabled();
});

test("send and revoke an invite; the link is never shown", async ({ page }) => {
  const email = `invitee-${Date.now()}@example.com`;
  await page.goto("/invites");
  await expect(page.getByRole("heading", { level: 1, name: "Invites" })).toBeFocused();
  await expectAccessible(page);
  await page.getByLabel("Owner's email address").fill(email);
  await page.getByRole("button", { name: "Send invite" }).click();
  await expect(page.getByText(`Invite emailed to ${email}.`)).toBeVisible();
  await expect(page.locator("body")).not.toContainText("/invite#");
  await page.getByRole("button", { name: `Revoke invite for ${email}` }).click();
  await expect(page.getByText(`Invite for ${email} revoked.`)).toBeVisible();
});

test("take a live site down after confirming, then restore it", async ({ page }) => {
  const site = await liveSite(page);

  await page.goto("/sites");
  await page.getByLabel("Show").selectOption("live");
  await page.getByLabel("Search").fill(site.slug);
  await expect(page.getByRole("link", { name: /^Open / })).toHaveCount(1);
  await page.getByRole("link", { name: `Open ${site.slug}` }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Joe's Plumbing" })).toBeFocused();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Take the site down" }).click();
  await expect(page.getByLabel("Reason for taking it down")).toBeFocused();
  await page.getByLabel("Reason for taking it down").fill("Phishing report");
  await page.getByRole("button", { name: "Take the site down" }).click();
  await page.getByRole("dialog", { name: "Take this site down?" }).getByRole("button", { name: "Take it down" }).click();
  const status = page.getByRole("status").filter({ hasText: "Site taken down. It stops being served within about a minute." });
  await expect(status).toBeVisible();
  await expect(status).not.toContainText("Owner not emailed");
  await expect(status).not.toContainText("Clean-up");
  await page.getByRole("button", { name: "Restore the site" }).click();
  await expect(page.getByText("Site restored.")).toBeVisible();
});

async function takeDown(page: Page, siteId: string) {
  await page.goto(`/sites/${siteId}`);
  await page.getByLabel("Reason for taking it down").fill("Phishing report");
  await page.getByRole("button", { name: "Take the site down" }).click();
  await page.getByRole("dialog", { name: "Take this site down?" }).getByRole("button", { name: "Take it down" }).click();
}

test("a takedown whose owner email failed says to contact the owner", async ({ page }) => {
  const site = await liveSite(page, { emailDomain: "mail-fails.example" });
  await takeDown(page, site.siteId);
  await expect(page.getByText("Site taken down. It stops being served within about a minute. Owner not emailed — contact them.")).toBeVisible();
});

test("a takedown whose clean-up failed says so, and Finish the takedown finishes it without a second notice", async ({ page }) => {
  const site = await liveSite(page);
  let faulted = false;
  await page.route("**/api/admin/sites/*/takedown", (route, request) => {
    if (faulted) return route.continue();
    faulted = true;
    return route.continue({ headers: { ...request.headers(), "x-test-takedown-fault": "live-delete" } });
  });
  await takeDown(page, site.siteId);
  await expect(page.getByText("Clean-up did not finish. The business name and phone may still show at its address until you finish it.")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("nothing from it is shown");
  await page.getByRole("button", { name: "Finish the takedown" }).click();
  await expect(page.getByText("Clean-up finished.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Finish the takedown" })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("Owner not emailed");
});

test("a takedown that answers with a server error says it may have partly happened", async ({ page }) => {
  const site = await liveSite(page);
  await page.route("**/api/admin/sites/*/takedown", (route) => route.fulfill({ status: 500, json: { error: { code: "internal", message: "Something went wrong. Please try again." } } }));
  await takeDown(page, site.siteId);
  await expect(page.getByText("The takedown may have partly happened. Try again.")).toBeVisible();
});

test("send an owner a sign-in link from their site; a disabled owner has no such button", async ({ page }) => {
  const site = await pendingSite(page.request);
  await page.goto(`/sites/${site.siteId}`);
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect(page.getByText(`Sign-in link emailed to ${site.email}.`)).toBeVisible();
  await expect(page.locator("body")).not.toContainText("/verify");

  await page.getByLabel("Reason for disabling the owner").fill("Abuse report");
  await page.getByRole("button", { name: "Disable the owner" }).click();
  await expect(page.getByText("Owner disabled and signed out everywhere.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send sign-in link" })).toHaveCount(0);
});

test("settings show today's sign-in emails against the cap, and a banner when the cap was reached", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByText("Sign-in emails today")).toBeVisible();
  await expect(page.getByText(/^\d+ of 40$/)).toBeVisible();
  await expect(page.getByText("Sign-in emails are paused", { exact: false })).toHaveCount(0);

  await page.route("**/api/admin/sign-in-emails", (route) => route.fulfill({ json: { sentToday: 40, dailyCap: 40, capReachedAt: Date.UTC(2026, 9, 1, 13, 5) } }));
  await page.reload();
  await expect(page.getByText("Sign-in emails are paused until midnight UTC (daily limit reached at 13:05 UTC)")).toBeVisible();
  await expect(page.getByText("40 of 40")).toBeVisible();
});

test("settings, by keyboard only: switch AI writing off and lower the daily limit", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-1280", "Changes a setting shared by every test: one project is enough.");
  await page.goto("/settings");
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeFocused();
  await expectAccessible(page);
  const enabled = page.getByLabel("AI writing is on");
  const limit = page.getByLabel("Most AI writing jobs per day, for all owners");
  await tabTo(page, enabled);
  await page.keyboard.press("Space");
  await expect(enabled).not.toBeChecked();
  await tabTo(page, limit);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("abc");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Enter a whole number from 0 to 1000.")).toBeVisible();
  await expect(limit).toBeFocused();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("5");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Settings saved.")).toBeVisible();
  await page.reload();
  await expect(enabled).not.toBeChecked();
  await expect(limit).toHaveValue("5");
  await tabTo(page, enabled);
  await page.keyboard.press("Space");
  await tabTo(page, page.getByRole("button", { name: "Save settings" }));
  await page.keyboard.press("Enter");
  await expect(page.getByText("Settings saved.")).toBeVisible();
});

test("every admin screen passes axe and reflows at 320 px", async ({ page }) => {
  test.slow(); // seven axe runs: triple the 60 s timeout so a busy machine does not fail it
  const site = await pendingSite(page.request);
  await page.setViewportSize({ width: 320, height: 700 });
  for (const path of ["/", `/reviews/${site.versionId}`, "/invites", "/sites", `/sites/${site.siteId}`, "/settings", "/nope"]) {
    await page.goto(`${ADMIN}${path}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectAccessible(page);
    await expectNoSidewaysScroll(page);
  }
});
