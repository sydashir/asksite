import { expect, test, type Page } from "@playwright/test";
import { builtSite } from "./support.ts";

const LOGOUT = "**/api/auth/logout";

/** Every request and answer for the draft and the logout, in the order the browser saw them. */
function watchSaves(page: Page) {
  const events: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "PATCH" && r.url().includes("/draft")) events.push("patch-sent");
    if (r.method() === "POST" && r.url().endsWith("/api/auth/logout")) events.push("logout-sent");
  });
  page.on("response", (r) => {
    if (r.request().method() === "PATCH" && r.url().includes("/draft")) events.push(`patch-answered-${r.status()}`);
  });
  return events;
}

// STRICT (customer data): "Sign out" saves what the owner just typed BEFORE it ends the session, and never after (the session is gone then).
test("Sign out saves an edit still inside the autosave delay, and the save finishes before the logout is sent", async ({ page }) => {
  const siteId = await builtSite(page);
  await page.goto(`/sites/${siteId}/edit`);
  const events = watchSaves(page);
  await page.getByLabel("Headline", { exact: true }).fill("Plumbers who answer the phone");
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL((url) => url.pathname === "/" && !url.pathname.includes("/sites/"));
  await expect.poll(() => events).toContain("logout-sent");
  expect(events).toEqual(["patch-sent", "patch-answered-200", "logout-sent"]);
});

test("Sign out stays and says so while the changes are not saved", async ({ page }) => {
  const siteId = await builtSite(page);
  await page.goto(`/sites/${siteId}/edit`);
  await page.route(`**/api/sites/${siteId}/draft`, (route) => (route.request().method() === "PATCH" ? route.fulfill({ status: 500, json: { error: { code: "internal", message: "Something went wrong. Please try again." } } }) : route.fallback()));
  const events = watchSaves(page);
  await page.getByLabel("Headline", { exact: true }).fill("Plumbers who answer the phone");
  await expect(page.getByText("Your changes are not saved yet", { exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByText("Your latest changes are not saved yet. Please try again in a moment.")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(`/sites/${siteId}/edit`);
  await expect(page.getByLabel("Headline", { exact: true })).toHaveValue("Plumbers who answer the phone");
  expect(events).not.toContain("logout-sent");
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
});
