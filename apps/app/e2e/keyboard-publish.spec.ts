import { expect, test } from "@playwright/test";
import { builtSite, tabTo } from "./support.ts";

test("keyboard only: send for review, then withdraw after confirming", async ({ page }) => {
  const siteId = await builtSite(page);
  await page.goto(`/sites/${siteId}/publish`);
  await expect(page.getByRole("heading", { level: 1, name: "Publish your website" })).toBeFocused();
  await tabTo(page, page.getByRole("button", { name: "Send for review" }));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Sent for review." })).toBeFocused();

  // The request's card is above the result: Shift+Tab reaches Withdraw. Focus starts on Cancel.
  await tabTo(page, page.getByRole("button", { name: "Withdraw this request" }), { back: true });
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Withdraw your request?" });
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await tabTo(page, dialog.getByRole("button", { name: "Withdraw" }), { back: true });
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Your request was withdrawn. Nothing was published." })).toBeFocused();
});
