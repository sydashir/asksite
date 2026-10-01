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

test("pressing Enter on Show older messages keeps keyboard focus, then moves it to the first new message", async ({ page }) => {
  const siteId = await builtSite(page);
  const now = Date.now();
  for (let i = 0; i < 51; i++) {
    await page.request.post(`${APP}/__test/sites/${siteId}/leads`, { data: { name: `Visitor ${i}`, phone: "(512) 555-0100", createdAt: now - i * 1000 } });
  }
  await page.route("**/leads?*before=*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  await page.goto(`/sites/${siteId}/leads`);
  const older = page.getByRole("button", { name: /older messages/ });
  await expect(page.getByRole("heading", { level: 2 })).toHaveCount(50);
  await older.focus();
  await page.keyboard.press("Enter");
  await expect(older).toHaveAttribute("aria-busy", "true");
  await expect(older).toBeFocused();
  await expect(older).toHaveText("Loading older messages…");
  await expect(older).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByRole("heading", { level: 2 })).toHaveCount(51);
  await expect(older).toHaveCount(0);
  await expect(page.getByRole("listitem").filter({ hasText: "Visitor 50" })).toBeFocused();
});
