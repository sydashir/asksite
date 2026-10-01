import { expect, test } from "@playwright/test";
import { APP, tabTo, uniqueEmail } from "./support.ts";

test("keyboard only: skip link, accept the invite, answer the first step and fix an error", async ({ page }) => {
  const res = await page.request.post(`${APP}/__test/invites`, { data: { email: uniqueEmail("keys") } });
  const { token } = (await res.json()) as { token: string };
  await page.goto(`/invite#${token}`);

  const skip = page.getByRole("link", { name: "Skip to main content" });
  await tabTo(page, skip);
  await expect(skip).toBeVisible();

  await tabTo(page, page.getByRole("button", { name: "Set up my website" }));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Your business" })).toBeFocused();

  await tabTo(page, page.getByLabel("Business name"));
  await page.keyboard.type("Keyboard Plumbing");
  await tabTo(page, page.getByLabel("What kind of work do you do?"));
  await page.keyboard.type("Plumbing");
  await expect(page.getByLabel("What kind of work do you do?")).toHaveValue("plumbing");

  await tabTo(page, page.getByRole("button", { name: "Save and continue" }));
  await page.keyboard.press("Enter");
  const summary = page.getByRole("heading", { name: /things? to fix/ }).locator("..");
  await expect(summary).toBeFocused();
  await tabTo(page, summary.getByRole("link").first());
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Business phone number")).toBeFocused();
  await page.keyboard.type("512 555 0142");
  await expect(page.getByLabel("Business phone number")).toHaveValue("(512) 555-0142");
});
