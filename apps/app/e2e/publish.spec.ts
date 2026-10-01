import { expect, test } from "@playwright/test";
import { APP, apiCall, builtSite, expectAccessible, FACTS } from "./support.ts";

test("send for review, see what is reviewed, withdraw, send again, then see it live", async ({ page }) => {
  const siteId = await builtSite(page);
  await page.goto(`/sites/${siteId}/publish`);
  await expect(page.getByRole("heading", { level: 1, name: "Publish your website" })).toBeFocused();
  await expectAccessible(page);

  await page.getByRole("button", { name: "Send for review" }).click();
  await expect(page.getByRole("heading", { name: "Waiting for approval" })).toBeVisible();
  await expect(page.getByText(/^Version 1, sent/)).toBeVisible();
  const link = page.getByRole("link", { name: "See what we are reviewing (opens in a new tab)" });
  const href = await link.getAttribute("href");
  expect(href).toMatch(new RegExp(`^/api/sites/${siteId}/versions/[0-9a-f-]{36}/page$`));
  const stored = await page.request.get(`${APP}${href}`);
  expect(stored.headers()["content-security-policy"]).toContain("sandbox");
  expect(await stored.text()).toContain("Plumbing done right");
  await expectAccessible(page);

  await page.getByRole("button", { name: "Withdraw this request" }).click();
  await page.getByRole("dialog", { name: "Withdraw your request?" }).getByRole("button", { name: "Withdraw" }).click();
  await expect(page.getByText("Your request was withdrawn. Nothing was published.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Waiting for approval" })).toBeHidden();

  await page.getByRole("button", { name: "Send for review" }).click();
  await expect(page.getByText(/^Version 2, sent/)).toBeVisible();
  const view = await apiCall(page, "GET", `/api/sites/${siteId}`);
  const pending = view.json?.["pendingVersion"] as { id: string };
  await page.request.post(`${APP}/__test/versions/${pending.id}/approve`, { data: {} });
  await page.reload();
  await expect(page.getByText("Your website is live at")).toBeVisible();
  await expect(page.getByRole("link", { name: /^https:\/\/joes-[a-z0-9]+\.localhost:8789\/$/ })).toBeVisible();
});

test("publishing with reviews but no attestation lists the fix, with a link to it", async ({ page }) => {
  const siteId = await builtSite(page, { ...FACTS, testimonials: [{ quote: "Fixed our leak the same afternoon.", name: "Ana P." }] });
  await page.goto(`/sites/${siteId}/publish`);
  await page.getByRole("button", { name: "Send for review" }).click();
  const fix = page.getByRole("link", { name: "Why customers can trust you: Check the box to confirm these reviews are from real customers." });
  await expect(fix).toBeVisible();
  await fix.click();
  await page.waitForURL(`${APP}/sites/${siteId}/setup/trust#f-brief-reviewsAreReal`);
  await expect(page.getByLabel("These reviews are from real customers, copied word for word")).toBeFocused();
});

test("an empty closing time is listed once, and its link opens that day's closing field", async ({ page }) => {
  const siteId = await builtSite(page);
  const before = await apiCall(page, "GET", `/api/sites/${siteId}`);
  await apiCall(page, "PATCH", `/api/sites/${siteId}/draft`, { rev: before.json?.["rev"], facts: { ...FACTS, hours: [{ days: ["Monday"], opens: "09:00", closes: "" }] } });
  await page.goto(`/sites/${siteId}/publish`);
  await page.getByRole("button", { name: "Send for review" }).click();
  await expect(page.getByRole("heading", { name: "There is 1 thing to fix" })).toBeVisible();
  await page.getByRole("link", { name: /Please enter a time\./ }).click();
  await page.waitForURL(`${APP}/sites/${siteId}/setup/area#hours-Monday-closes`);
  await expect(page.getByLabel("Monday closes at")).toBeFocused();
});

test("a request approved in another tab is not reported as withdrawn", async ({ page }) => {
  const siteId = await builtSite(page);
  await page.goto(`/sites/${siteId}/publish`);
  await page.getByRole("button", { name: "Send for review" }).click();
  await expect(page.getByRole("heading", { name: "Waiting for approval" })).toBeVisible();
  const view = await apiCall(page, "GET", `/api/sites/${siteId}`);
  const pending = view.json?.["pendingVersion"] as { id: string };
  await page.request.post(`${APP}/__test/versions/${pending.id}/approve`, { data: {} });
  // No reload: the page still shows "Waiting for approval" when the owner withdraws.
  await page.getByRole("button", { name: "Withdraw this request" }).click();
  await page.getByRole("dialog", { name: "Withdraw your request?" }).getByRole("button", { name: "Withdraw" }).click();
  await expect(page.getByText("Your website is live at")).toBeVisible();
  await expect(page.getByText("There was no request waiting to withdraw. Its latest status is below.")).toBeVisible();
  await expect(page.getByText(/Nothing was published/)).toBeHidden();
});

test("a rejected request shows the reviewer's note", async ({ page }) => {
  const siteId = await builtSite(page);
  await page.goto(`/sites/${siteId}/publish`);
  await page.getByRole("button", { name: "Send for review" }).click();
  await expect(page.getByRole("heading", { name: "Waiting for approval" })).toBeVisible();
  const view = await apiCall(page, "GET", `/api/sites/${siteId}`);
  const pending = view.json?.["pendingVersion"] as { id: string };
  await page.request.post(`${APP}/__test/versions/${pending.id}/reject`, { data: { note: "Please add your license number." } });
  await page.reload();
  await expect(page.getByText("We asked for a change before your website goes live:")).toBeVisible();
  await expect(page.getByText("Please add your license number.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Waiting for approval" })).toBeHidden();
});

test("after going live, a changed draft says it is not published yet", async ({ page }) => {
  const siteId = await builtSite(page);
  await page.goto(`/sites/${siteId}/publish`);
  await page.getByRole("button", { name: "Send for review" }).click();
  await expect(page.getByRole("heading", { name: "Waiting for approval" })).toBeVisible();
  const view = await apiCall(page, "GET", `/api/sites/${siteId}`);
  const pending = view.json?.["pendingVersion"] as { id: string };
  await page.request.post(`${APP}/__test/versions/${pending.id}/approve`, { data: {} });
  await page.reload();
  await expect(page.getByText("Your website is live at")).toBeVisible();
  await expect(page.getByText("You have changes that are not published yet.")).toBeHidden();
  const live = await apiCall(page, "GET", `/api/sites/${siteId}`);
  await apiCall(page, "PATCH", `/api/sites/${siteId}/draft`, { rev: live.json?.["rev"], facts: { ...FACTS, businessName: "Joe's Plumbing and Heating" } });
  await page.reload();
  await expect(page.getByText("You have changes that are not published yet.")).toBeVisible();
});

for (const path of ["setup/business", "publish"]) {
  test(`a site that cannot be loaded shows an error, not a spinner (/${path})`, async ({ page }) => {
    await builtSite(page);
    await page.goto(`/sites/00000000-0000-4000-8000-000000000000/${path}`);
    await expect(page.getByText(/not found|could not|cannot/i)).toBeVisible();
    await expect(page.getByText(/^Loading/)).toBeHidden();
  });
}

test("a taken-down site shows the notice and no way to send for review", async ({ page }) => {
  const siteId = await builtSite(page);
  await page.request.post(`${APP}/__test/sites/${siteId}/take-down`, { data: {} });
  await page.goto(`/sites/${siteId}/publish`);
  await expect(page.getByText("Your website has been taken offline, so visitors cannot see it.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send for review" })).toBeHidden();
});
