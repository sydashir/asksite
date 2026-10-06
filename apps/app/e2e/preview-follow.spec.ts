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

/**
 * Which page a change lands on depends on what the design draws where, so these tests pin Bold (design id "impact", the design Joe's
 * Plumbing is drawn in): Bold's hero card shows the service area, and its About section shows an owner photo. If the trade's design
 * changes, this fails here and says so, instead of failing as a wrong page.
 */
async function expectBold(page: Page) {
  await expect
    .poll(() => page.locator('iframe[title="Preview of your website"]').getAttribute("srcdoc"), {
      message: 'these tests pin the Bold design (id "impact") for Joe\'s Plumbing; the preview is drawn in another design now, so update the expected pages',
    })
    .toContain('data-design="impact"');
}

// UX-8 (task-17-extra.md:157, "any field"): the preview follows an edit in Details and Photos, and an un-hidden page, to the page that draws it.
test("a Details field change shows the page that draws that field", async ({ page }) => {
  await openEditor(page);
  await page.getByRole("tab", { name: "Details" }).click();
  await page.getByLabel("Which answers?").selectOption({ label: "Where you work and when" });
  // Home is the page the preview opens on, so first move off it: the follow back to Home is then a real move.
  await showPreview(page);
  await expectBold(page);
  await pageButton(page, "Services").click();
  await expect(pageButton(page, "Services")).toHaveAttribute("aria-pressed", "true");
  await showEditor(page);
  await page.getByLabel("Place 1", { exact: true }).fill("Georgetown");
  await showPreview(page);
  await expect(pageButton(page, "Home")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Showing the Home page")).toBeVisible();
  // The owner's own choice of page stays until the next change.
  await pageButton(page, "Services").click();
  await expect(pageButton(page, "Services")).toHaveAttribute("aria-pressed", "true");
  await showEditor(page);
  await page.getByLabel("Place 1", { exact: true }).fill("Georgetown TX");
  await showPreview(page);
  await expect(pageButton(page, "Home")).toHaveAttribute("aria-pressed", "true");
});

test("a photo change shows the About page, where Bold draws the owner's photo", async ({ page }) => {
  await openEditor(page);
  await page.getByRole("tab", { name: "Photos" }).click();
  const jpeg = await sharp({ create: { width: 800, height: 400, channels: 3, background: { r: 20, g: 160, b: 90 } } }).jpeg().toBuffer();
  await page.getByLabel("Upload a photo").setInputFiles({ name: "work.jpg", mimeType: "image/jpeg", buffer: jpeg });
  await expect(page.getByText("Photo uploaded. Choose where to use it below.")).toBeVisible();
  await page.getByRole("button", { name: "Add uploaded photo 1 to your work photos" }).click();
  await page.getByLabel(/^Describe /).first().fill("A new water heater in a garage");
  await showPreview(page);
  await expectBold(page);
  await expect(pageButton(page, "About")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Showing the About page")).toBeVisible();
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
