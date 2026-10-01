import { expect, test } from "@playwright/test";
import { pendingSite, tabTo } from "./support.ts";

// Keyboard only (design §9.2): nothing here clicks. The review page's frame holds the stored page, whose
// links are in the Tab order too, so those walks allow more presses.

test("keyboard only: open a review from the queue, and reject it with a note", async ({ page }) => {
  test.slow(); // many single key presses
  const site = await pendingSite(page.request);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Waiting for review" })).toBeFocused();
  await tabTo(page, page.getByRole("link", { name: `Review ${site.slug} version 1` }), { max: 150 });
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Review Joe's Plumbing (version 1)" })).toBeFocused();

  const reject = page.getByRole("button", { name: "Reject and email the owner" });
  await tabTo(page, reject, { max: 150 });
  await page.keyboard.press("Enter");
  const note = page.getByLabel("Reason (the owner sees this)");
  await expect(note).toBeFocused();
  await page.keyboard.type("Please use photos of your own work.");
  await tabTo(page, reject);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Rejected. We'll email the owner your note." })).toBeFocused();
});

test("keyboard only: approve with search engines off, take the site down after confirming, and restore it", async ({ page }) => {
  test.slow(); // many single key presses
  const site = await pendingSite(page.request);
  await page.goto(`/reviews/${site.versionId}`);
  await expect(page.getByRole("heading", { level: 1, name: "Review Joe's Plumbing (version 1)" })).toBeFocused();
  const allow = page.getByLabel("Allow search engines to list this site");
  await tabTo(page, allow, { max: 150 });
  await page.keyboard.press("Space");
  await expect(allow).not.toBeChecked();
  await tabTo(page, page.getByRole("button", { name: "Approve and publish" }));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Approved." })).toBeFocused();

  await page.goto(`/sites/${site.siteId}`);
  await expect(page.getByRole("heading", { level: 1, name: "Joe's Plumbing" })).toBeFocused();
  await tabTo(page, page.getByLabel("Reason for taking it down"));
  await page.keyboard.type("Phishing report");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Take this site down?" });
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await tabTo(page, dialog.getByRole("button", { name: "Take it down" }), { back: true });
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Site taken down." })).toBeFocused();
  await tabTo(page, page.getByRole("button", { name: "Restore the site" }));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Site restored." })).toBeFocused();
});
