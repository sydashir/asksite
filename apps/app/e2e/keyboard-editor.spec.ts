import { PALETTES } from "@asksite/renderer";
import { expect, test, type Page } from "@playwright/test";
import { builtSite, tabTo } from "./support.ts";

const previewHtml = (page: Page) => page.locator('iframe[title="Preview of your website"]').getAttribute("srcdoc");

test("keyboard only: the editor's tabs, look, sections, wording and the rewrite dialog", async ({ page }) => {
  test.slow(); // dozens of single key presses: triple the 60 s timeout so a busy machine does not fail it
  const siteId = await builtSite(page);
  await page.goto(`/sites/${siteId}/edit`);
  await expect(page.getByRole("heading", { level: 1, name: "Edit your website" })).toBeFocused();
  const tab = (name: string) => page.getByRole("tab", { name });

  // The tab list is one Tab stop; arrow keys choose the tab.
  await tabTo(page, tab("Words"));
  await page.keyboard.press("ArrowRight");
  await expect(tab("Look")).toBeFocused();
  await expect(tab("Look")).toHaveAttribute("aria-selected", "true");

  // Look: the colors are a radio group, so arrow keys move through them (the page designs are another group).
  const colors = page.getByRole("group", { name: "Colors and lettering" });
  await tabTo(page, colors.getByRole("radio", { checked: true }));
  await page.keyboard.press("ArrowDown");
  await expect(colors.getByLabel(/Blue & yellow/)).toBeChecked();
  await expect.poll(() => previewHtml(page)).toContain(PALETTES["blue-yellow"].primary);

  // Sections: Move up with Enter, Hide with Space. Each is on its own page, which the preview follows to.
  await tabTo(page, tab("Look"), { back: true });
  await page.keyboard.press("ArrowRight");
  await expect(tab("Sections")).toHaveAttribute("aria-selected", "true");
  await tabTo(page, page.getByRole("button", { name: "Move Service area and hours up" }));
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => {
      const html = (await previewHtml(page)) ?? "";
      return html.includes('id="service-area"') && html.indexOf('id="service-area"') < html.indexOf('id="contact"');
    })
    .toBe(true);
  const hideFaq = page.getByLabel("Hide Questions and answers");
  await tabTo(page, hideFaq);
  await page.keyboard.press("Space");
  await expect(hideFaq).toBeChecked();
  await expect
    .poll(async () => {
      const html = (await previewHtml(page)) ?? "";
      return html.includes('<section id="services"') && !html.includes('<section id="faq"');
    })
    .toBe(true);

  // Words: select the headline's text and type over it.
  await tabTo(page, tab("Sections"), { back: true });
  await page.keyboard.press("Home");
  await expect(tab("Words")).toHaveAttribute("aria-selected", "true");
  await tabTo(page, page.getByLabel("Headline", { exact: true }));
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Plumbers you can trust");
  await expect.poll(() => previewHtml(page)).toContain("Plumbers you can trust");

  // The rewrite dialog: focus starts on Cancel, Escape closes it and returns focus, and the confirm
  // button is reached with Shift+Tab (Option+Shift+Tab in WebKit, which skips buttons on plain Tab).
  const rewrite = page.getByRole("button", { name: "Write new wording" });
  await tabTo(page, rewrite);
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Write new wording?" });
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(rewrite).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await tabTo(page, dialog.getByRole("button", { name: "Write new wording" }), { back: true });
  const [started] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/api/sites/${siteId}/generations`) && r.request().method() === "POST"),
    page.keyboard.press("Enter"),
  ]);
  expect(started.status()).toBe(202);

  // Phones show the editor and the preview one at a time; the switch works from the keyboard.
  if ((page.viewportSize()?.width ?? 1280) < 768) {
    const preview = page.getByRole("button", { name: "Preview", exact: true });
    await tabTo(page, preview, { back: true });
    await page.keyboard.press("Enter");
    await expect(preview).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('iframe[title="Preview of your website"]')).toBeVisible();
  }
});
