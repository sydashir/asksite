import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import { builtSite, showPreview } from "./support.ts";

const pageButton = (page: Page, name: string) => page.getByRole("group", { name: "Page", exact: true }).getByRole("button", { name });
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 768;
async function showEditor(page: Page) {
  if (isPhone(page)) await page.getByRole("button", { name: "Edit", exact: true }).click();
}
async function openEditor(page: Page) {
  const siteId = await builtSite(page);
  await page.goto(`/sites/${siteId}/edit`);
  await expect(page.getByRole("heading", { level: 1, name: "Edit your website" })).toBeFocused();
}

// UX-8 (task-17-extra.md:157, "any field"): the preview follows an edit in Details and Photos, and an un-hidden page, to the page that draws it.
test("a Details field change shows the page that draws that field", async ({ page }) => {
  await openEditor(page);
  await page.getByRole("tab", { name: "Details" }).click();
  await page.getByLabel("Which answers?").selectOption({ label: "Where you work and when" });
  await page.getByLabel("Place 1", { exact: true }).fill("Georgetown");
  await showPreview(page);
  await expect(pageButton(page, "Contact")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Showing the Contact page")).toBeVisible();
  // The owner's own choice of page stays until the next change.
  await pageButton(page, "Home").click();
  await expect(pageButton(page, "Home")).toHaveAttribute("aria-pressed", "true");
  await showEditor(page);
  await page.getByLabel("Place 1", { exact: true }).fill("Georgetown TX");
  await showPreview(page);
  await expect(pageButton(page, "Contact")).toHaveAttribute("aria-pressed", "true");
});

test("a photo change shows the Gallery page", async ({ page }) => {
  await openEditor(page);
  await page.getByRole("tab", { name: "Photos" }).click();
  const jpeg = await sharp({ create: { width: 800, height: 400, channels: 3, background: { r: 20, g: 160, b: 90 } } }).jpeg().toBuffer();
  await page.getByLabel("Upload a photo").setInputFiles({ name: "work.jpg", mimeType: "image/jpeg", buffer: jpeg });
  await expect(page.getByText("Photo uploaded. Choose where to use it below.")).toBeVisible();
  await page.getByRole("button", { name: "Add uploaded photo 1 to your work photos" }).click();
  await page.getByLabel(/^Describe /).first().fill("A new water heater in a garage");
  await showPreview(page);
  await expect(pageButton(page, "Gallery")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Showing the Gallery page")).toBeVisible();
});

test("bringing a hidden page back shows that page", async ({ page }) => {
  await openEditor(page);
  await page.getByRole("tab", { name: "Sections" }).click();
  await page.getByLabel("Hide About you").check();
  await showPreview(page);
  await expect(pageButton(page, "About")).toHaveCount(0);
  await showEditor(page);
  await page.getByLabel("Hide About you").uncheck();
  await showPreview(page);
  await expect(pageButton(page, "About")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Showing the About page")).toBeVisible();
});
