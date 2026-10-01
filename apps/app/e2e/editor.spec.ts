import { PALETTES } from "@asksite/renderer";
import { expect, test, type Page } from "@playwright/test";
import { sheetsChunk } from "./dist-assets.ts";
import { acceptInvite, apiCall, APP, BRIEF, builtSite, expectAccessible, expectNoSidewaysScroll, FACTS, finishGeneration, showPreview, watchCsp } from "./support.ts";

const FRAME = 'iframe[title="Preview of your website"]';
const previewHtml = (page: Page) => page.locator(FRAME).getAttribute("srcdoc");
const pageButton = (page: Page, name: string) => page.getByRole("group", { name: "Page", exact: true }).getByRole("button", { name });
const savedStatus = (page: Page) => page.getByRole("status").filter({ hasText: "All changes saved." });
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 768;
/** Phones show the editor and the preview one at a time: back to the editor. */
async function showEditor(page: Page) {
  if (isPhone(page)) await page.getByRole("button", { name: "Edit", exact: true }).click();
}
const savedEdits = async (page: Page, siteId: string) => (await apiCall(page, "GET", `/api/sites/${siteId}`)).json?.["edits"] as { copy: { heroHeadline?: string }; theme: unknown };

async function openEditor(page: Page) {
  const siteId = await builtSite(page);
  await page.goto(`/sites/${siteId}/edit`);
  await expect(page.getByRole("heading", { level: 1, name: "Edit your website" })).toBeFocused();
  return siteId;
}

test("when the first draft is ready, the build page opens the editor with the page in the preview", async ({ page }) => {
  const siteId = await acceptInvite(page);
  await apiCall(page, "PATCH", `/api/sites/${siteId}/draft`, { rev: 1, facts: FACTS, brief: BRIEF });
  const started = await apiCall(page, "POST", `/api/sites/${siteId}/generations`, {});
  await page.goto(`/sites/${siteId}/build`);
  await expect(page.getByRole("heading", { level: 1, name: "Building your website" })).toBeFocused();
  await finishGeneration(page.request, (started.json?.["generation"] as { id: string }).id);
  await page.waitForURL(`${APP}/sites/${siteId}/edit`);
  await showPreview(page);
  const preview = page.frameLocator(FRAME);
  await expect(preview.getByRole("heading", { level: 1 })).toHaveText("Plumbing done right");
  await expect(preview.getByText("Joe's Plumbing").first()).toBeVisible();
});

// STRICT (the honesty rules): the editor says why wording is refused, and names the fact that makes it allowed.
test("wording edits update the preview; an unbacked claim is explained with a link to its fix", async ({ page }) => {
  const csp = await watchCsp(page);
  const siteId = await openEditor(page);
  const headline = page.getByLabel("Headline", { exact: true });
  await expect(headline).toHaveValue("Plumbing done right");

  await headline.fill("Licensed plumbers you can trust");
  await expect(page.getByText("To say “licensed”, add your license.")).toBeVisible();
  await expect(page.getByText("Fix 1 issue to update the preview.")).toBeVisible();
  expect(await previewHtml(page)).toContain("Plumbing done right");
  await page.getByRole("button", { name: "Add a license" }).click();
  await expect(page.getByRole("tab", { name: "Details" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("group", { name: "Licenses" })).toBeFocused();
  await page.getByRole("tab", { name: "Words" }).click();

  await headline.fill("Plumbers you can trust");
  await expect(page.getByText("Fix 1 issue to update the preview.")).toBeHidden();
  await expect.poll(() => previewHtml(page)).toContain("Plumbers you can trust");
  await expect(savedStatus(page)).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Headline", { exact: true })).toHaveValue("Plumbers you can trust");
  expect((await savedEdits(page, siteId)).copy.heroHeadline).toBe("Plumbers you can trust");
  await showPreview(page);
  expect(await csp()).toEqual([]);
});

test("one empty closing time is counted once, and Show me goes to that field", async ({ page }) => {
  const siteId = await openEditor(page);
  const rev = (await apiCall(page, "GET", `/api/sites/${siteId}`)).json?.["rev"] as number;
  await apiCall(page, "PATCH", `/api/sites/${siteId}/draft`, { rev, facts: { ...FACTS, hours: [{ days: ["Monday"], opens: "08:00", closes: "" }] } });
  await page.reload();
  await expect(page.getByText("Fix 1 issue to update the preview.")).toBeVisible();
  await expect(page.getByText(/Fix \d+ issues/)).toHaveCount(0);
  // "Show me" goes to the closing time's own field, and that one message is shown once.
  await page.getByRole("button", { name: "Show me" }).click();
  await expect(page.getByLabel("Monday closes at")).toBeFocused();
  await expect(page.getByText("Please enter a time.")).toHaveCount(1);
});

test("switching the page design and the colors re-draws the preview, each keeping the other @mobile", async ({ page }) => {
  const siteId = await openEditor(page);
  await page.getByRole("tab", { name: "Look" }).click();
  const design = page.getByRole("group", { name: "Page design" });
  const colors = page.getByRole("group", { name: "Colors and lettering" });
  // Plumbing's own design is Bold, and the AI's colors are navy and orange.
  await expect(design.getByLabel(/Bold/)).toBeChecked();
  await expect(design.locator("label", { hasText: "Bold" })).toContainText("(recommended for you)");
  await expect(colors.getByLabel(/Navy & orange/)).toBeChecked();

  await colors.getByLabel(/Charcoal & red/).check();
  await expect.poll(() => previewHtml(page)).toContain(PALETTES["charcoal-red"].primary);
  await design.getByLabel(/Modern/).check();
  await expect.poll(() => previewHtml(page)).toContain('data-design="modern"');
  expect(await previewHtml(page)).toContain(PALETTES["charcoal-red"].primary);
  await expect(savedStatus(page)).toBeVisible();
  expect((await savedEdits(page, siteId)).theme).toEqual({ palette: "charcoal-red", font: "sturdy", design: "modern" });
  await expectAccessible(page);
});

test("sections are grouped by page, move only within their page, and hiding says when it removes a page @mobile", async ({ page }) => {
  await openEditor(page);
  await page.getByRole("tab", { name: "Sections" }).click();
  await expect(page.getByRole("heading", { name: "Services page" })).toBeVisible();
  await expect(page.getByLabel("Hide Services")).toHaveCount(0);
  await expect(page.getByText("Always shown: visitors need to know what you do and how to reach you.").first()).toBeVisible();

  // The edge of a page: the first and last section cannot move, and a section alone on its page cannot move at all.
  await expect(page.getByRole("button", { name: "Move Services up" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Move Questions and answers down" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Move About you up" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Move About you down" })).toBeDisabled();

  // Move the FAQ above services: the preview follows to the Services page, where both sections live.
  await page.getByRole("button", { name: "Move Questions and answers up" }).click();
  await expect.poll(async () => {
    const html = (await previewHtml(page)) ?? "";
    return html.includes('<section id="faq"') && html.indexOf('<section id="faq"') < html.indexOf('<section id="services"');
  }).toBe(true);
  await expect(page.getByRole("button", { name: "Move Questions and answers up" })).toBeDisabled();

  // The Contact page keeps its own order.
  await page.getByRole("button", { name: "Move Service area and hours up" }).click();
  await expect.poll(async () => {
    const html = (await previewHtml(page)) ?? "";
    return html.includes('id="service-area"') && html.indexOf('id="service-area"') < html.indexOf('id="contact"');
  }).toBe(true);

  // Hiding the FAQ takes it off the Services page, which stays; hiding About takes the whole page out of the menu.
  await expect(page.getByText("Hiding this also removes the About page from your menu.")).toBeVisible();
  await expect(page.getByText(/Hiding this also removes the Services page/)).toHaveCount(0);
  await page.getByLabel("Hide Questions and answers").check();
  await expect.poll(async () => {
    const html = (await previewHtml(page)) ?? "";
    return html.includes('<section id="services"') && !html.includes('<section id="faq"');
  }).toBe(true);
  await page.getByLabel("Hide About you").check();
  await showPreview(page); // on a phone the page buttons are on the preview screen
  await expect(pageButton(page, "About")).toHaveCount(0);
  await expect(pageButton(page, "Services")).toHaveCount(1);
  await expectAccessible(page);
});

test("tabs follow the ARIA pattern: arrow keys move between them", async ({ page }) => {
  await openEditor(page);
  await page.getByRole("tab", { name: "Words" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Look" })).toBeFocused();
  await expect(page.getByRole("tab", { name: "Look" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: "Details" })).toBeFocused();
  await expect(page.getByLabel("Which answers?")).toBeVisible();
});

test("the preview follows the owner to the page of the field being edited, and says so", async ({ page }) => {
  await openEditor(page);
  const answer = page.getByLabel("Answer 1", { exact: true });
  await answer.fill("Yes, and we wipe down every surface.");
  await showPreview(page);
  await expect(pageButton(page, "Services")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Showing the Services page")).toBeVisible();
  await expect.poll(() => previewHtml(page)).toContain("Yes, and we wipe down every surface.");
  // The owner moves on to the headline, which is on Home; the viewer's own choice of page is respected until the next field.
  await showEditor(page);
  await page.getByLabel("Headline", { exact: true }).focus();
  await showPreview(page);
  await expect(pageButton(page, "Home")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Showing the Home page")).toBeVisible();
});

test("write new wording asks first, then replaces the wording but keeps the look", async ({ page }) => {
  const siteId = await openEditor(page);
  await page.getByRole("tab", { name: "Look" }).click();
  await page.getByRole("group", { name: "Colors and lettering" }).getByLabel(/Green & amber/).check();
  await page.getByRole("tab", { name: "Words" }).click();
  await page.getByLabel("Headline", { exact: true }).fill("My own headline");
  await expect(savedStatus(page)).toBeVisible();

  await page.getByRole("button", { name: "Write new wording" }).click();
  const dialog = page.getByRole("dialog", { name: "Write new wording?" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "Write new wording" }).click();
  const [started] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/api/sites/${siteId}/generations`) && r.request().method() === "POST"),
    dialog.getByRole("button", { name: "Write new wording" }).click(),
  ]);
  expect(started.status()).toBe(202);
  // The result is announced in the status line, so focus goes there once the dialog is closed.
  await expect(page.getByRole("status").filter({ hasText: /Writing new wording|New wording is ready/ })).toBeFocused();
  await finishGeneration(page.request, ((await started.json()) as { generation: { id: string } }).generation.id);
  // The editor polls every 2 s (§3.1 step 4); allow a busy machine a few polls.
  await expect(page.getByText("New wording is ready.")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel("Headline", { exact: true })).toHaveValue("Plumbing done right");
  await expect.poll(() => previewHtml(page)).toContain(PALETTES["green-amber"].primary);
});

test("the editor reflows at 320 px and passes axe on every tab and on the preview @mobile", async ({ page }) => {
  test.slow(); // six axe runs: triple the 60 s timeout so a busy machine does not fail it
  await page.setViewportSize({ width: 320, height: 800 });
  await openEditor(page);
  for (const tab of ["Words", "Look", "Sections", "Photos", "Details"]) {
    await page.getByRole("tab", { name: tab }).click();
    await expectNoSidewaysScroll(page);
    await expectAccessible(page);
  }
  await showPreview(page);
  await expect(pageButton(page, "Home")).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectAccessible(page);
});

test("service descriptions follow every service by position, keyed by the trimmed name", async ({ page }) => {
  const siteId = await builtSite(page, { ...FACTS, services: [{ name: "Drain cleaning " }, { name: "Water heaters" }] });
  await page.goto(`/sites/${siteId}/edit`);
  const first = page.getByLabel("Description of “Drain cleaning”");
  await first.fill("We clear blocked drains without mess.");
  await expect(first).toHaveValue("We clear blocked drains without mess.");
  await expect.poll(() => previewHtml(page)).toContain("We clear blocked drains without mess.");
  await expect(savedStatus(page)).toBeVisible();

  // A service without a name keeps its place, so the next description is still that service's own.
  const rev = (await apiCall(page, "GET", `/api/sites/${siteId}`)).json?.["rev"] as number;
  await apiCall(page, "PATCH", `/api/sites/${siteId}/draft`, { rev, facts: { ...FACTS, services: [{ name: "" }, { name: "Water heaters" }] } });
  await page.reload();
  await expect(page.getByText("Service 1 has no name yet.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Description of “Water heaters”")).toHaveValue("Done carefully by our team.");
});

// STRICT (customer data): a description under a name OwnerEdits refuses as a key would fail every later save, so none is offered.
test("a service name too long to be a description key asks for a shorter name instead of a field; 40 emoji still get one", async ({ page }) => {
  const siteId = await openEditor(page);
  const rev = (await apiCall(page, "GET", `/api/sites/${siteId}`)).json?.["rev"] as number;
  const tooLong = "a".repeat(41);
  const emoji = "\u{1F527}".repeat(40);
  await apiCall(page, "PATCH", `/api/sites/${siteId}/draft`, { rev, facts: { ...FACTS, services: [{ name: tooLong }, { name: emoji }] } });
  await page.reload();
  await expect(page.getByText("Shorten this service name to 40 characters or fewer in the Services step to add a description.")).toHaveCount(1);
  await expect(page.getByLabel(`Description of “${tooLong}”`)).toHaveCount(0);
  const field = page.getByLabel(`Description of “${emoji}”`);
  await field.fill("Done properly.");
  await expect(field).toHaveValue("Done properly.");
  await expect(savedStatus(page)).toBeVisible();
});

// STRICT (customer data): nothing the owner typed is lost, whichever way they leave.
test("a change typed just before leaving the editor is kept, whichever link is used", async ({ page }) => {
  const siteId = await openEditor(page);
  await page.getByLabel("Headline", { exact: true }).fill("Left in a hurry");
  await page.getByRole("link", { name: "Your website", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Your websites" })).toBeVisible();
  const headline = async () => (await savedEdits(page, siteId)).copy.heroHeadline;
  await expect.poll(headline).toBe("Left in a hurry");
});

test("Publish waits for the autosave, and stays with a message when it fails", async ({ page }) => {
  const siteId = await openEditor(page);
  await page.route(`**/api/sites/${siteId}/draft`, (route) =>
    route.fulfill({ status: 500, json: { error: { code: "internal", message: "Something went wrong. Please try again." } } }),
  );
  await page.getByLabel("Headline", { exact: true }).fill("Not saved yet");
  await page.getByRole("link", { name: "Publish", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Your latest changes are not saved yet.");
  await expect(page).toHaveURL(`${APP}/sites/${siteId}/edit`);
});

// The design sheets are one lazy chunk (P4-20): fetched when the preview first needs them, then kept.
test("the preview loads the sheets chunk exactly once, however often the design is switched", async ({ page }) => {
  const chunk = sheetsChunk().name;
  const requests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith(`/${chunk}`)) requests.push(request.url());
  });
  await openEditor(page);
  await page.getByRole("tab", { name: "Look" }).click();
  const design = page.getByRole("group", { name: "Page design" });
  await expect.poll(() => previewHtml(page)).toContain('data-design="impact"');
  for (const [name, id] of [["Classic", "refined"], ["Modern", "modern"], ["Bold", "impact"], ["Classic", "refined"]] as const) {
    await design.getByLabel(new RegExp(name)).check();
    await expect.poll(() => previewHtml(page)).toContain(`data-design="${id}"`);
  }
  expect(requests).toHaveLength(1);
});

// When the lazy chunk cannot load, the editing carries on, and nothing is lost to a reload.
test("when the preview cannot load it says so, editing and saving carry on, and Reload the page saves first", async ({ page }) => {
  let sheetsDown = true;
  const siteId = await builtSite(page);
  await page.route("**/assets/*.js", async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    if (sheetsDown && body.includes("tailwindcss v4.3.3")) return route.abort();
    return route.fulfill({ response, body });
  });
  await page.goto(`/sites/${siteId}/edit`);
  await expect(page.getByRole("heading", { level: 1, name: "Edit your website" })).toBeFocused();
  await page.evaluate(() => ((window as unknown as { __kept: boolean }).__kept = true));
  const kept = () => page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept === true);

  // First failure. Nothing reloads by itself.
  await showPreview(page);
  await expect(page.getByText("The preview couldn't load. Your changes are saved.")).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("The preview still can't load. Your changes are saved.")).toBeVisible();
  expect(await kept()).toBe(true);

  // The editor is still usable, and saves.
  await showEditor(page);
  await page.getByLabel("Headline", { exact: true }).fill("Typed while the preview is down");
  await expect(savedStatus(page)).toBeVisible();

  // A change that cannot be saved right now: Reload the page must not reload, and must say so.
  let saving = false;
  await page.route(`**/api/sites/${siteId}/draft`, (route) =>
    saving ? route.fallback() : route.fulfill({ status: 500, json: { error: { code: "internal", message: "Something went wrong. Please try again." } } }),
  );
  await page.getByLabel("Headline", { exact: true }).fill("Not saved yet");
  await showPreview(page);
  await page.getByRole("button", { name: "Reload the page" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Your latest changes are not saved yet." })).toBeVisible();
  expect(await kept()).toBe(true);

  // Saving works again: the click saves, then reloads. The page that comes back was itself a reload, so it says "still".
  saving = true;
  await page.getByRole("button", { name: "Reload the page" }).click();
  await expect.poll(kept).toBe(false);
  await showPreview(page);
  await expect(page.getByText("The preview still can't load. Your changes are saved.")).toBeVisible();
  await showEditor(page);
  await expect(page.getByLabel("Headline", { exact: true })).toHaveValue("Not saved yet");
  expect((await savedEdits(page, siteId)).copy.heroHeadline).toBe("Not saved yet");

  // The chunk is back: reloading brings the preview, with the saved headline.
  sheetsDown = false;
  await showPreview(page);
  await page.getByRole("button", { name: "Reload the page" }).click();
  await showPreview(page);
  await expect(page.frameLocator(FRAME).getByRole("heading", { level: 1 })).toHaveText("Not saved yet");
});
