import { expect, test, type Page } from "@playwright/test";
import { acceptInvite, apiCall, askNewWording, builtSite, expectAccessible, expectNoSidewaysScroll, failSiteGets, finishGeneration, seedDraft, showPreview, watchCsp } from "./support.ts";

const STEPS = ["business", "services", "area", "trust", "photos", "words", "address"];
const TABS = ["Words", "Look", "Sections", "Photos", "Details"];
const pageGroup = (page: Page) => page.getByRole("group", { name: "Page", exact: true });
const WRITING_LOCK = "Writing new wording. You can edit again when it is ready.";
const NOT_LOADED_LOCK = "The new wording is ready, but we couldn't load it. Reload the page to see it. You can edit again when it shows.";

async function openEditor(page: Page, siteId: string) {
  await page.goto(`/sites/${siteId}/edit`);
  await expect(page.getByRole("heading", { level: 1, name: "Edit your website" })).toBeFocused();
}

test("every questionnaire step, before and after a failed Continue, passes axe with no CSP violations", async ({ page }) => {
  test.slow(); // fourteen axe runs: triple the 60 s timeout so a busy machine does not fail it
  const readCsp = await watchCsp(page);
  const siteId = await acceptInvite(page);
  for (const step of STEPS) {
    await page.goto(`/sites/${siteId}/setup/${step}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expectAccessible(page);
    await page.getByRole("button", { name: /Save and continue|Build my website/ }).click();
    await expectAccessible(page);
  }
  expect(await readCsp()).toEqual([]);
});

test("every screen, and every editor tab, reflows at 320 px without sideways scrolling", async ({ page }) => {
  test.slow(); // many pages in one test
  await page.setViewportSize({ width: 320, height: 700 });
  const readCsp = await watchCsp(page);
  const siteId = await builtSite(page);
  for (const path of [...STEPS.map((s) => `/sites/${siteId}/setup/${s}`), `/sites/${siteId}/publish`, `/sites/${siteId}/leads`, "/", "/nope"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoSidewaysScroll(page);
  }
  await openEditor(page, siteId);
  for (const tab of TABS) {
    await page.getByRole("tab", { name: tab }).click();
    await expectNoSidewaysScroll(page);
  }
  await showPreview(page);
  await expect(pageGroup(page).getByRole("button", { name: "Home" })).toBeVisible();
  await expectNoSidewaysScroll(page);
  expect(await readCsp()).toEqual([]);
});

test("the build page announces progress politely and passes axe", async ({ page }) => {
  const siteId = await acceptInvite(page);
  await seedDraft(page, siteId, "progress", {
    businessName: "Joe's",
    trade: "plumbing",
    phone: "+15125550142",
    email: "a@example.com",
    location: { city: "Austin", state: "TX" },
    serviceArea: { places: ["Austin"] },
    services: [{ name: "Drains" }],
  });
  await apiCall(page, "POST", `/api/sites/${siteId}/generations`, {});
  await page.goto(`/sites/${siteId}/build`);
  await expect(page.getByRole("status")).toHaveText("We are writing your website. This usually takes under a minute.");
  await expectAccessible(page);
});

test("the home page lists the owner's websites and the not-found page passes axe", async ({ page }) => {
  await builtSite(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Your websites" })).toBeFocused();
  await expectAccessible(page);
  await page.goto("/nope");
  await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeFocused();
  await expectAccessible(page);
});

test("the editor's page switcher, the width toggle and the grouped Sections tab pass axe with no CSP violations", async ({ page }) => {
  test.slow(); // several axe runs
  const readCsp = await watchCsp(page);
  const siteId = await builtSite(page);
  await openEditor(page, siteId);
  await page.getByRole("tab", { name: "Sections" }).click();
  await expect(page.getByRole("heading", { name: "Services page" })).toBeVisible();
  await expect(page.getByText("Hiding this also removes the About page from your menu.")).toBeVisible();
  await expectAccessible(page);

  await showPreview(page);
  await pageGroup(page).getByRole("button", { name: "Services" }).click();
  await expect(pageGroup(page).getByRole("button", { name: "Services" })).toHaveAttribute("aria-pressed", "true");
  await expectAccessible(page);
  const width = page.getByRole("group", { name: "Page width", exact: true });
  await width.getByRole("button", { name: "Phone width" }).click();
  await expect(width.getByRole("button", { name: "Phone width" })).toHaveAttribute("aria-pressed", "true");
  await expectAccessible(page);
  expect(await readCsp()).toEqual([]);
});

test("the Publish page's inline preview of what we are reviewing passes axe with no CSP violations", async ({ page }) => {
  const readCsp = await watchCsp(page);
  const siteId = await builtSite(page);
  await page.goto(`/sites/${siteId}/publish`);
  await page.getByRole("button", { name: "Send for review" }).click();
  await expect(page.getByRole("heading", { name: "See what we are reviewing" })).toBeVisible();
  await expect(pageGroup(page).getByRole("button")).toHaveText(["Home", "Services", "About", "Contact"]);
  await pageGroup(page).getByRole("button", { name: "About" }).click();
  await expect(pageGroup(page).getByRole("button", { name: "About" })).toHaveAttribute("aria-pressed", "true");
  await expectAccessible(page);
  expect(await readCsp()).toEqual([]);
});

test("the editor while new wording is written, and when it could not be loaded, passes axe", async ({ page }) => {
  test.slow(); // the unloaded state waits for one try and one retry
  const readCsp = await watchCsp(page);
  const siteId = await builtSite(page);
  await openEditor(page, siteId);
  const gate = await failSiteGets(page, siteId, Infinity);
  const id = await askNewWording(page, siteId);

  // Frozen while the wording is written: the lock notice, controls aria-disabled.
  await expect(page.getByText(WRITING_LOCK)).toHaveCount(1);
  await expectAccessible(page);

  // Written, but the owner's tab cannot load it: the top line, the status line and Reload.
  gate.armed = true;
  await finishGeneration(page.request, id);
  await expect(page.getByText(NOT_LOADED_LOCK, { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Reload the page" })).toBeVisible();
  await expectAccessible(page);
  expect(await readCsp()).toEqual([]);
});
