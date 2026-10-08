import { expect, test } from "@playwright/test";
import { APP, builtSite, expectAccessible } from "./support.ts";

test("messages from the contact form are listed with safe phone and email links", async ({ page }) => {
  const siteId = await builtSite(page);
  await page.request.post(`${APP}/__test/sites/${siteId}/leads`, { data: { name: "Maria G.", phone: "(512) 555-0199", email: "maria@example.com", message: "Kitchen sink\nis slow", createdAt: Date.now() } });
  await page.request.post(`${APP}/__test/sites/${siteId}/leads`, { data: { name: "<img src=x onerror=alert(1)>", phone: "javascript:alert(1)", createdAt: Date.now() - 1000 } });
  await page.goto(`/sites/${siteId}/leads`);
  await expect(page.getByRole("heading", { level: 2, name: "Maria G." })).toBeVisible();
  await expect(page.getByRole("link", { name: "(512) 555-0199" })).toHaveAttribute("href", "tel:5125550199");
  await expect(page.getByRole("link", { name: "maria@example.com" })).toHaveAttribute("href", "mailto:maria@example.com");
  await expect(page.getByRole("heading", { level: 2, name: "<img src=x onerror=alert(1)>" })).toBeVisible();
  await expect(page.getByRole("link", { name: "javascript:alert(1)" })).toHaveCount(0);
  await expectAccessible(page);
});

test("the messages page tells owners about the form's daily limits", async ({ page }) => {
  const siteId = await builtSite(page);
  await page.goto(`/sites/${siteId}/leads`);
  await expect(page.getByText("To stop spam, one visitor can send up to 3 messages a day through your form")).toBeVisible();
});

test("a message shows its line break, its service and the email-failed notice", async ({ page }) => {
  const siteId = await builtSite(page);
  await page.request.post(`${APP}/__test/sites/${siteId}/leads`, { data: { name: "Maria G.", phone: "(512) 555-0199", service: "Plumbing repair", message: "Kitchen sink\nis slow", emailStatus: "failed", createdAt: Date.now() } });
  await page.request.post(`${APP}/__test/sites/${siteId}/leads`, { data: { name: "Sam T.", phone: "(512) 555-0100", createdAt: Date.now() - 1000 } });
  await page.goto(`/sites/${siteId}/leads`);
  const maria = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Maria G." }) });
  await expect(maria.locator("dd").filter({ hasText: "Kitchen sink" })).toBeVisible();
  expect(await maria.locator("dd").filter({ hasText: "Kitchen sink" }).evaluate((el) => (el as HTMLElement).innerText)).toBe("Kitchen sink\nis slow");
  await expect(maria.getByText("Service", { exact: true })).toBeVisible();
  await expect(maria.getByText("Plumbing repair", { exact: true })).toBeVisible();
  await expect(maria.getByText("We could not email you this message, so it is only here.")).toBeVisible();
  const sam = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Sam T." }) });
  // Sam's card must be there before its missing notice means anything.
  await expect(sam.getByRole("heading", { level: 2, name: "Sam T." })).toBeVisible();
  await expect(sam.getByText("We could not email you this message, so it is only here.")).toHaveCount(0);
});

test("a double-click on Show older messages lists every message exactly once", async ({ page }) => {
  const siteId = await builtSite(page);
  const now = Date.now();
  for (let i = 0; i < 51; i++) {
    await page.request.post(`${APP}/__test/sites/${siteId}/leads`, { data: { name: `Visitor ${i}`, phone: "(512) 555-0100", createdAt: now - i * 1000 } });
  }
  // A slow network: the older page answers after the second click of the double-click.
  await page.route("**/leads?*before=*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  await page.goto(`/sites/${siteId}/leads`);
  const older = page.getByRole("button", { name: "Show older messages" });
  await expect(page.getByRole("heading", { level: 2 })).toHaveCount(50);
  await older.dblclick();
  await expect(page.getByRole("heading", { level: 2 })).toHaveCount(51);
  await expect(older).toHaveCount(0);
});

test("pressing Enter on Show older messages keeps keyboard focus on the button while pages are left, then moves it to the first new message", async ({ page }) => {
  const siteId = await builtSite(page);
  const now = Date.now();
  // 102 leads: the last page holds two, so a focus on the last card instead of the first new one is caught.
  for (let i = 0; i < 102; i++) {
    await page.request.post(`${APP}/__test/sites/${siteId}/leads`, { data: { name: `Visitor ${i}`, phone: "(512) 555-0100", createdAt: now - i * 1000 } });
  }
  // Each older-page request waits at this gate until the test lets it through.
  let olderRequests = 0;
  let release: () => void = () => {};
  await page.route("**/leads?*before=*", async (route) => {
    olderRequests++;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.continue();
  });
  await page.goto(`/sites/${siteId}/leads`);
  const older = page.getByRole("button", { name: /older messages/ });
  const cards = page.getByRole("heading", { level: 2 });
  await expect(cards).toHaveCount(50);
  await older.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => olderRequests).toBe(1);
  await expect(older).toHaveAttribute("aria-busy", "true");
  await expect(older).toBeFocused();
  await expect(older).toHaveText("Loading older messages…");
  await expect(older).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Enter");
  release();
  // Page 2 of 3: more pages are left, so focus stays on the re-enabled button.
  await expect(cards).toHaveCount(100);
  await expect(older).toHaveText("Show older messages");
  await expect(older).toHaveAttribute("aria-disabled", "false");
  await expect(older).toBeFocused();
  expect(olderRequests).toBe(1);
  await page.keyboard.press("Enter");
  await expect.poll(() => olderRequests).toBe(2);
  release();
  // The last page: the button is gone and focus moves to the first new message.
  await expect(cards).toHaveCount(102);
  await expect(older).toHaveCount(0);
  await expect(page.getByRole("listitem").filter({ hasText: "Visitor 100" })).toBeFocused();
  expect(olderRequests).toBe(2);
});

test("a failed Show older messages is announced as an alert", async ({ page }) => {
  const siteId = await builtSite(page);
  const now = Date.now();
  for (let i = 0; i < 51; i++) {
    await page.request.post(`${APP}/__test/sites/${siteId}/leads`, { data: { name: `Visitor ${i}`, phone: "(512) 555-0100", createdAt: now - i * 1000 } });
  }
  await page.route("**/leads?*before=*", (route) => route.fulfill({ status: 500, json: { error: { code: "internal", message: "Something went wrong. Please try again." } } }));
  await page.goto(`/sites/${siteId}/leads`);
  await expect(page.getByRole("heading", { level: 2 })).toHaveCount(50);
  await page.getByRole("button", { name: "Show older messages" }).click();
  await expect(page.getByRole("alert")).toContainText("Something went wrong. Please try again.");
});
