import { PALETTES } from "@asksite/renderer";
import { expect, test, type Browser, type Page, type Request } from "@playwright/test";
import sharp from "sharp";
import { sheetsChunk } from "./dist-assets.ts";
import { acceptInvite, apiCall, APP, BRIEF, builtSite, expectAccessible, expectNoSidewaysScroll, FACTS, finishGeneration, showPreview, uniqueSlug, watchCsp } from "./support.ts";

const FRAME = 'iframe[title="Preview of your website"]';
const previewHtml = (page: Page) => page.locator(FRAME).getAttribute("srcdoc");
const pageButton = (page: Page, name: string) => page.getByRole("group", { name: "Page", exact: true }).getByRole("button", { name });
const savedStatus = (page: Page) => page.getByRole("status").filter({ hasText: "All changes saved." });
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 768;
/** Phones show the editor and the preview one at a time: back to the editor. */
async function showEditor(page: Page) {
  if (isPhone(page)) await page.getByRole("button", { name: "Edit", exact: true }).click();
}
const savedEdits = async (page: Page, siteId: string) =>
  (await apiCall(page, "GET", `/api/sites/${siteId}`)).json?.["edits"] as { copy: { heroHeadline?: string }; theme: unknown; order: string[] | null };

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
  // The button that reached the edge is disabled, so keyboard focus moves to its sibling instead of falling to the page.
  await expect(page.getByRole("button", { name: "Move Questions and answers down" })).toBeFocused();

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

test("moving a question to the top of the list keeps keyboard focus on a live button", async ({ page }) => {
  await openEditor(page);
  await page.getByRole("button", { name: "Add a question" }).click();
  await expect(page.getByLabel("Question 2")).toBeVisible();
  await page.getByRole("button", { name: "Move question 2 up" }).click();
  // The moved question is now first, so its Move up is disabled: focus goes to its Move down.
  await expect(page.getByRole("button", { name: "Move question 1 up" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Move question 1 down" })).toBeFocused();
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
  await expect(page.getByText("The preview couldn't load.")).toBeVisible();
  // By keyboard: WebKit does not focus a button on a mouse click.
  await page.getByRole("button", { name: "Try again" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("The preview still can't load.")).toBeVisible();
  // Retrying must not take the keyboard's place: the button that was pressed is still there and still focused.
  await expect(page.getByRole("button", { name: "Try again" })).toBeFocused();
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
  // Wait for the new document's load, not a poll of the old one: a page.evaluate that meets the navigation throws "Execution context was destroyed".
  const reloaded = page.waitForEvent("load");
  await page.getByRole("button", { name: "Reload the page" }).click();
  await reloaded;
  expect(await kept()).toBe(false);
  await showPreview(page);
  await expect(page.getByText("The preview still can't load.")).toBeVisible();
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

// STRICT (the honesty rules): the preview failure says "Your changes are saved." only while the editor really is saved.
test("when the preview cannot load, it says the changes are saved only while they are saved", async ({ page }) => {
  const siteId = await builtSite(page);
  await page.route("**/assets/*.js", async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    return body.includes("tailwindcss v4.3.3") ? route.abort() : route.fulfill({ response, body });
  });
  const claim = page.getByText("Your changes are saved.");
  let release: (() => void) | null = null;
  let mode: "hold" | "pass" | "fail" = "hold";
  await page.route(`**/api/sites/${siteId}/draft`, async (route) => {
    if (mode === "fail") return route.fulfill({ status: 500, json: { error: { code: "internal", message: "Something went wrong. Please try again." } } });
    if (mode === "hold") await new Promise<void>((resolve) => (release = resolve));
    return route.fallback();
  });
  await page.goto(`/sites/${siteId}/edit`);
  await expect(page.getByRole("heading", { level: 1, name: "Edit your website" })).toBeFocused();
  const headline = page.getByLabel("Headline", { exact: true });

  // Nothing was changed yet: the editor does not say saved, so the notice does not either.
  await showPreview(page);
  await expect(page.getByText("The preview couldn't load.")).toBeVisible();
  await expect(claim).toHaveCount(0);

  // Typed, and the save is still in flight: not saved.
  await showEditor(page);
  await headline.fill("First saving state");
  await expect(page.getByText("Saving…")).toBeVisible();
  await showPreview(page);
  await expect(claim).toHaveCount(0);
  await expect.poll(() => release !== null).toBe(true);

  // Saved: now it says so.
  mode = "pass";
  release!();
  await expect(savedStatus(page)).toBeVisible();
  await expect(claim).toBeVisible();

  // A save that fails: not saved again.
  mode = "fail";
  await showEditor(page);
  await headline.fill("Second failing state");
  await expect(page.getByRole("status").filter({ hasText: "Your changes are not saved yet." })).toBeVisible();
  await showPreview(page);
  await expect(page.getByText("The preview couldn't load.")).toBeVisible();
  await expect(claim).toHaveCount(0);
});

// STRICT (customer data): a move must build on the earlier moves, even while the wording has an issue to fix.
test("moves made while the wording has an issue are all kept, shown and saved", async ({ page }) => {
  const siteId = await openEditor(page);
  await page.getByLabel("Headline", { exact: true }).fill("Licensed plumbers you can trust");
  await expect(page.getByText("Fix 1 issue to update the preview.")).toBeVisible();
  await page.getByRole("tab", { name: "Sections" }).click();
  await page.getByRole("button", { name: "Move Questions and answers up" }).click();
  await page.getByRole("button", { name: "Move Service area and hours up" }).click();

  const names = (heading: string) => page.getByRole("region", { name: heading }).locator("p.font-medium").allTextContents();
  await expect.poll(() => names("Services page")).toEqual(["Questions and answers", "Services"]);
  await expect.poll(() => names("Contact page")).toEqual(["Service area and hours", "Contact form"]);
  await expect.poll(async () => (await savedEdits(page, siteId)).order).toEqual(["hero", "trust", "testimonials", "faq", "services", "about", "gallery", "serviceArea", "contact"]);
});

// STRICT (customer data): new wording refreshes only the AI's wording; nothing the owner did is replaced or lost (task-17 fix round 3, D1).
const NOT_SAVED = "Your changes are not saved yet.";
const green = (page: Page) => page.getByRole("group", { name: "Colors and lettering" }).getByLabel(/Green & amber/);
const other = (page: Page) => page.getByRole("group", { name: "Colors and lettering" }).getByLabel(/Charcoal & red/);
const savedTheme = async (page: Page, siteId: string) => ((await apiCall(page, "GET", `/api/sites/${siteId}`)).json?.["edits"] as { theme: { palette: string } | null }).theme?.palette ?? null;

/** Asks for new wording through the dialog. Returns the generation's id; finish it with finishGeneration. */
async function askNewWording(page: Page, siteId: string): Promise<string> {
  await page.getByRole("tab", { name: "Words" }).click();
  await page.getByRole("button", { name: "Write new wording" }).click();
  const [started] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/api/sites/${siteId}/generations`) && r.request().method() === "POST"),
    page.getByRole("dialog", { name: "Write new wording?" }).getByRole("button", { name: "Write new wording" }).click(),
  ]);
  return ((await started.json()) as { generation: { id: string } }).generation.id;
}

/** Holds the next GET of the site, answering with what the server said at that moment (so it can go stale while held). */
async function holdNextSiteGet(page: Page, siteId: string) {
  const gate: { armed: boolean; reached: boolean; release: () => void } = { armed: false, reached: false, release: () => undefined };
  await page.route(`**/api/sites/${siteId}`, async (route) => {
    if (!gate.armed || route.request().method() !== "GET") return route.fallback();
    gate.armed = false;
    const response = await route.fetch();
    gate.reached = true;
    await new Promise<void>((resolve) => (gate.release = resolve));
    return route.fulfill({ response });
  });
  return gate;
}

test("new wording does not start while a change could not be saved; once it is saved, it starts and the change stays", async ({ page }) => {
  const siteId = await openEditor(page);
  let failing = true;
  await page.route(`**/api/sites/${siteId}/draft`, (route) =>
    failing ? route.fulfill({ status: 500, json: { error: { code: "internal", message: "Something went wrong. Please try again." } } }) : route.fallback(),
  );
  const asked: string[] = [];
  page.on("request", (r) => r.method() === "POST" && r.url().endsWith(`/api/sites/${siteId}/generations`) && asked.push(r.url()));
  await page.getByRole("tab", { name: "Look" }).click();
  await green(page).check();
  await expect(page.getByRole("status").filter({ hasText: NOT_SAVED })).toBeVisible();

  // The rewrite flushes first: the change cannot be saved, so the rewrite does not start and the editor is not frozen.
  await page.getByRole("tab", { name: "Words" }).click();
  await page.getByRole("button", { name: "Write new wording" }).click();
  await page.getByRole("dialog", { name: "Write new wording?" }).getByRole("button", { name: "Write new wording" }).click();
  await expect(page.getByText("Your latest changes are not saved yet. Please try again in a moment.")).toBeVisible();
  await expect(page.getByText(WRITING_LOCK)).toHaveCount(0);
  expect(asked).toEqual([]);

  failing = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(savedStatus(page)).toBeVisible();
  expect(await savedTheme(page, siteId)).toBe("green-amber");

  const id = await askNewWording(page, siteId);
  await finishGeneration(page.request, id);
  await expect(page.getByText("New wording is ready.")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("tab", { name: "Look" }).click();
  await expect(green(page)).toBeChecked();
  expect(await savedTheme(page, siteId)).toBe("green-amber");
});

test("while new wording is being loaded the editor stays locked; a change made once it is ready is saved", async ({ page }) => {
  const siteId = await openEditor(page);
  const gate = await holdNextSiteGet(page, siteId);
  gate.armed = true;
  const id = await askNewWording(page, siteId);
  await finishGeneration(page.request, id);
  await expect.poll(() => gate.reached, { timeout: 15_000 }).toBe(true);

  // The rewrite has landed but its wording is not on screen yet: still read-only, on every tab.
  await expect(page.getByText(WRITING_LOCK)).toBeVisible();
  await page.getByRole("tab", { name: "Look" }).click();
  await expect(green(page)).toHaveAttribute("aria-disabled", "true");
  await green(page).click({ force: true });
  await expect(green(page)).not.toBeChecked();
  gate.release();
  await expect(page.getByText("New wording is ready.")).toBeVisible();
  await expect(page.getByText(WRITING_LOCK)).toHaveCount(0);
  expect(await savedTheme(page, siteId)).not.toBe("green-amber");

  await green(page).check();
  await expect(savedStatus(page)).toBeVisible();
  await expect.poll(() => savedTheme(page, siteId)).toBe("green-amber");
  await other(page).check();
  await expect(savedStatus(page)).toBeVisible();
  await expect(page.getByText("This site changed in another tab or window.")).toHaveCount(0);
  await expect.poll(() => savedTheme(page, siteId)).toBe("charcoal-red");
});

// Accessibility: the preview's alert is read out in full whenever its text changes, so a save must never change it.
test("the preview's alert keeps the same text through a save cycle; 'saved' is plain text beside it", async ({ page }) => {
  const siteId = await builtSite(page);
  await page.route("**/assets/*.js", async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    return body.includes("tailwindcss v4.3.3") ? route.abort() : route.fulfill({ response, body });
  });
  await page.goto(`/sites/${siteId}/edit`);
  await expect(page.getByRole("heading", { level: 1, name: "Edit your website" })).toBeFocused();
  await showPreview(page);
  const alert = page.getByRole("alert").filter({ hasText: "The preview couldn't load." });
  await expect(alert).toContainText("The preview couldn't load.");
  const before = await alert.innerText();
  expect(before).not.toContain("saved");
  // Record every change of the alert's text from here on.
  await alert.evaluate((el) => {
    const seen: string[] = [];
    (window as unknown as { __alertTexts: string[] }).__alertTexts = seen;
    new MutationObserver(() => seen.push(el.textContent ?? "")).observe(el, { subtree: true, childList: true, characterData: true });
  });
  await showEditor(page);
  await page.getByLabel("Headline", { exact: true }).fill("A save cycle");
  await expect(page.getByText("Saving…")).toBeVisible();
  await expect(savedStatus(page)).toBeVisible();
  await showPreview(page);
  const note = page.getByText("Your changes are saved.");
  await expect(note).toBeVisible();
  await expect(alert).toHaveText(before);
  expect(await page.evaluate(() => (window as unknown as { __alertTexts: string[] }).__alertTexts)).toEqual([]);
  // The note is plain text: not inside the alert, and not a live region itself.
  expect(await note.evaluate((el) => el.closest('[role="alert"], [role="status"], [aria-live]') === null)).toBe(true);
});

// STRICT (customer data): new wording is "ready" only once it is on screen; if it cannot be loaded, wording and order are
// read-only, so nothing is ever saved against the old generation (task-17 fix round 4, I-1).
const headlineField = (page: Page) => page.getByLabel("Headline", { exact: true });
const siteView = async (page: Page, siteId: string) => (await apiCall(page, "GET", `/api/sites/${siteId}`)).json!;
const aiGenerationId = async (page: Page, siteId: string) => ((await siteView(page, siteId))["ai"] as { generationId: string }).generationId;
const UNREADABLE = "The new wording is ready, but we couldn't load it. Reload the page to see it.";

/** Records the edits.baseGenerationId of every draft save the page sends. */
function watchDraftSaves(page: Page, siteId: string) {
  const bases: Array<string | null> = [];
  page.on("request", (request) => {
    if (request.method() !== "PATCH" || !request.url().endsWith(`/api/sites/${siteId}/draft`)) return;
    const body = request.postDataJSON() as { edits?: { baseGenerationId: string | null } };
    if (body.edits !== undefined) bases.push(body.edits.baseGenerationId);
  });
  return bases;
}

/** Answers the next `count` GETs of the site (or every one, with Infinity) with a 503, once armed. Returns how many it failed. */
async function failSiteGets(page: Page, siteId: string, count: number) {
  const gate = { armed: false, failed: 0 };
  await page.route(`**/api/sites/${siteId}`, (route) => {
    if (!gate.armed || route.request().method() !== "GET" || gate.failed >= count) return route.fallback();
    gate.failed += 1;
    return route.fulfill({ status: 503, json: { error: { code: "internal", message: "Something went wrong. Please try again." } } });
  });
  return gate;
}

test("when the new wording cannot be fetched at first, it is fetched again and later edits apply to it", async ({ page }) => {
  const siteId = await openEditor(page);
  const bases = watchDraftSaves(page, siteId);
  const before = await aiGenerationId(page, siteId);
  const gate = await failSiteGets(page, siteId, 1);
  const id = await askNewWording(page, siteId);
  gate.armed = true;
  await finishGeneration(page.request, id);
  await expect(page.getByText("New wording is ready.")).toBeVisible({ timeout: 15_000 });
  expect(gate.failed).toBe(1);
  await expect(page.getByText(UNREADABLE, { exact: true })).toHaveCount(0);

  const after = await aiGenerationId(page, siteId);
  expect(after).not.toBe(before);
  await headlineField(page).fill("Typed after the retry");
  await expect(savedStatus(page)).toBeVisible();
  expect(bases).toEqual([after]);
  expect(((await savedEdits(page, siteId)) as { copy: { heroHeadline?: string } }).copy.heroHeadline).toBe("Typed after the retry");
});

test("when the new wording cannot be loaded at all, it says so and wording and sections stay read-only; nothing is saved against the old wording", async ({ page }) => {
  const siteId = await openEditor(page);
  const bases = watchDraftSaves(page, siteId);
  const gate = await failSiteGets(page, siteId, Infinity);
  const id = await askNewWording(page, siteId);
  gate.armed = true;
  await finishGeneration(page.request, id);
  await expect(page.getByText(UNREADABLE, { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("New wording is ready.")).toHaveCount(0);
  expect(gate.failed).toBe(2); // one try and one retry, never more
  await expect(page.getByRole("button", { name: "Reload the page" })).toBeVisible();
  // The top line stands alone: it says what happened, what to do and when editing is back.
  await expect(page.getByText("The new wording is ready, but we couldn't load it. Reload the page to see it. You can edit again when it shows.", { exact: true })).toHaveCount(1);

  // Words: focus stays, typing changes nothing.
  const headline = headlineField(page);
  const shown = await headline.inputValue();
  await headline.focus();
  await page.keyboard.type("Lost");
  await expect(headline).toHaveValue(shown);
  await expect(headline).toBeFocused();
  await expect(page.getByRole("button", { name: "Add a question" })).toHaveAttribute("aria-disabled", "true");
  await page.getByRole("button", { name: "Add a question" }).click({ force: true }); // Playwright counts aria-disabled as not enabled
  await expect(page.getByLabel("Question 2")).toHaveCount(0);

  // Sections: a click changes nothing.
  await page.getByRole("tab", { name: "Sections" }).click();
  const move = page.getByRole("button", { name: "Move Questions and answers up" });
  await expect(move).toHaveAttribute("aria-disabled", "true");
  await move.click({ force: true });
  await page.getByLabel("Hide About you").click({ force: true });
  await expect(page.getByLabel("Hide About you")).not.toBeChecked();

  await noChangeQueued(page); // a change that got through the guards would show "Saving…" at once
  expect(bases).toEqual([]);
  expect((await savedEdits(page, siteId)).order).toBeNull();

  // R3: the WHOLE editor is frozen here, the Look tab too (nothing may change until the new wording is shown).
  await page.getByRole("tab", { name: "Look" }).click();
  await expect(green(page)).toHaveAttribute("aria-disabled", "true");
  const themeBefore = await savedTheme(page, siteId);
  await green(page).click({ force: true });
  await expect(green(page)).not.toBeChecked();
  await page.getByRole("tab", { name: "Details" }).click();
  const business = page.getByLabel("Business name");
  const name = await business.inputValue();
  await business.focus();
  await page.keyboard.type("Lost");
  await expect(business).toHaveValue(name);
  await page.getByRole("tab", { name: "Photos" }).click();
  await expect(page.getByRole("group", { name: "Main photo" })).toBeVisible();
  await expect(page.locator('[role="tabpanel"] [aria-disabled="true"]').first()).toBeVisible();
  await noChangeQueued(page);
  expect(bases).toEqual([]);
  expect(await savedTheme(page, siteId)).toBe(themeBefore);
  // The existing way out stays: Try again to load it.
  await expect(page.getByRole("button", { name: "Reload the page" })).toBeVisible();
});

test("new wording keeps the look the server pinned for an owner who chose none", async ({ page }) => {
  const siteId = await builtSite(page);
  const rev = (await siteView(page, siteId))["rev"] as number;
  expect((await apiCall(page, "PATCH", `/api/sites/${siteId}/draft`, { rev, facts: { ...FACTS, trade: "roofing" } })).status).toBe(200);
  await page.goto(`/sites/${siteId}/edit`);
  await expect(page.getByRole("heading", { level: 1, name: "Edit your website" })).toBeFocused();
  await expect(headlineField(page)).toHaveValue("Plumbing done right");

  const id = await askNewWording(page, siteId);
  await finishGeneration(page.request, id);
  await expect(page.getByText("New wording is ready.")).toBeVisible({ timeout: 15_000 });
  await expect(headlineField(page)).toHaveValue("Roofing done right");

  const pinned = ((await siteView(page, siteId))["edits"] as { theme: { design: string } | null }).theme;
  expect(pinned?.design).toBe("impact");
  await page.getByRole("tab", { name: "Look" }).click();
  await expect(page.locator("#design-impact")).toBeChecked();
});

// STRICT (customer data): the edit-binding guard. Wording is bound to the AI draft it was written on; the server refuses a wording
// change on any other (409 wording_changed), so the editor never says "All changes saved." for a change that would be dropped.
/** Nothing is queued for saving: the status shows "Saving…" the moment a change reaches the saver, so absence needs no clock. */
const noChangeQueued = (page: Page) => expect(page.getByText("Saving…")).toHaveCount(0);

const WRITING_LOCK = "Writing new wording. You can edit again when it is ready.";
const WRITING_DROPPED = "New wording is being written. Your last change was not saved. Make it again when the new wording is ready.";
const WORDING_DROPPED = "New wording arrived, so your last wording change wasn't applied. Make it again on the new wording if you still want it.";

/** Tab A shows the first wording (roofing is set so the new wording differs); tab B, the same owner, writes new wording and it lands. */
async function staleTab(page: Page, browser: Browser) {
  const siteId = await builtSite(page);
  const rev = (await siteView(page, siteId))["rev"] as number;
  expect((await apiCall(page, "PATCH", `/api/sites/${siteId}/draft`, { rev, facts: { ...FACTS, trade: "roofing" } })).status).toBe(200);
  const first = ((await siteView(page, siteId))["ai"] as { generationId: string }).generationId;
  await page.goto(`/sites/${siteId}/edit`);
  await expect(headlineField(page)).toHaveValue("Plumbing done right");

  // Tab B: the same owner in another browser context writes new wording, and it lands.
  const other = await browser.newContext({ baseURL: APP, ignoreHTTPSErrors: true, storageState: await page.context().storageState() });
  const tabB = await other.newPage();
  await tabB.goto(`/sites/${siteId}/edit`);
  await expect(headlineField(tabB)).toHaveValue("Plumbing done right");
  const id = await askNewWording(tabB, siteId);
  await finishGeneration(tabB.request, id);
  await expect(tabB.getByText("New wording is ready.")).toBeVisible({ timeout: 15_000 });
  await other.close();
  const second = ((await siteView(page, siteId))["ai"] as { generationId: string }).generationId;
  expect(second).not.toBe(first);
  return { siteId, first, second };
}

test("a wording change in a tab that missed new wording is refused, said so, and never stored", async ({ page, browser }) => {
  const { siteId, first, second } = await staleTab(page, browser);

  // Tab A still shows the first wording. Its owner changes the headline.
  await headlineField(page).fill("My own headline");
  await expect(page.getByRole("status").filter({ hasText: WORDING_DROPPED })).toBeVisible();
  await expect(savedStatus(page)).toHaveCount(0);
  // The server kept nothing built on the old wording, and tab A now shows the new wording.
  const stored = (await siteView(page, siteId))["edits"] as { baseGenerationId: string | null; copy: object };
  expect(stored.baseGenerationId).not.toBe(first);
  expect(stored.copy).toEqual({});
  await expect(headlineField(page)).toHaveValue("Roofing done right");

  // Making the change again on the new wording works and is saved as such (the owner dismisses the notice they have read).
  await page.getByRole("button", { name: "Dismiss" }).click();
  await headlineField(page).fill("My own headline");
  await expect(savedStatus(page)).toBeVisible();
  const again = (await siteView(page, siteId))["edits"] as { baseGenerationId: string | null; copy: { heroHeadline?: string } };
  expect(again.baseGenerationId).toBe(second);
  expect(again.copy.heroHeadline).toBe("My own headline");
});

test("an editor opened while new wording is being written follows it, and the next change lands on the new wording", async ({ page }) => {
  const siteId = await openEditor(page);
  const first = ((await siteView(page, siteId))["ai"] as { generationId: string }).generationId;
  const id = await askNewWording(page, siteId);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Edit your website" })).toBeFocused();
  await expect(page.getByRole("status").filter({ hasText: "Writing new wording…" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Write new wording" })).toBeDisabled();
  // The lock shows after a reload too: typing changes nothing until the new wording is shown.
  await expect(page.getByText(WRITING_LOCK)).toBeVisible();
  const typed = headlineField(page);
  const shown = await typed.inputValue();
  await typed.focus();
  await page.keyboard.type("Lost");
  await expect(typed).toHaveValue(shown);

  await finishGeneration(page.request, id);
  await expect(page.getByText("New wording is ready.")).toBeVisible({ timeout: 15_000 });
  const second = ((await siteView(page, siteId))["ai"] as { generationId: string }).generationId;
  expect(second).not.toBe(first);

  await headlineField(page).fill("My own headline");
  await expect(savedStatus(page)).toBeVisible();
  const stored = (await siteView(page, siteId))["edits"] as { baseGenerationId: string | null; copy: { heroHeadline?: string } };
  expect(stored.baseGenerationId).toBe(second);
  expect(stored.copy.heroHeadline).toBe("My own headline");
});

// STRICT (customer data): the notice is never lost, and nothing leaves the editor over a dropped change without the owner seeing it first.
test("a stale tab edits the headline and presses Publish at once: it stays here with the notice, and the second press goes on", async ({ page, browser }) => {
  const { siteId, first } = await staleTab(page, browser);
  const publish = page.getByRole("link", { name: "Publish" });

  await headlineField(page).fill("My own headline");
  await publish.click();
  const notice = page.getByRole("status").filter({ hasText: WORDING_DROPPED });
  await expect(notice).toBeVisible();
  await expect(notice).toBeFocused();
  await expect(page.getByRole("button", { name: "Dismiss" })).toBeVisible();
  await expect(savedStatus(page)).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe(`/sites/${siteId}/edit`);
  const stored = (await siteView(page, siteId))["edits"] as { baseGenerationId: string | null; copy: object };
  expect(stored.baseGenerationId).not.toBe(first);
  expect(stored.copy).toEqual({});

  await publish.click();
  await page.waitForURL(`${APP}/sites/${siteId}/publish`);
});

/** Every draft save the page sends: a rewrite freezes the editor, so none may go out while it runs. */
function watchEverySave(page: Page, siteId: string) {
  const sent: string[] = [];
  page.on("request", (request) => request.method() === "PATCH" && request.url().endsWith(`/api/sites/${siteId}/draft`) && sent.push(request.postData() ?? ""));
  return sent;
}

// STRICT (customer data, round 4): from the request for new wording until it is shown (or it fails) the WHOLE editor is read-only: every
// tab, aria-disabled and a guard, focus kept, one message. Nothing is saved while it runs.
test("while new wording is being written every tab is read-only, focus stays, and no save is sent", async ({ page }) => {
  const siteId = await openEditor(page);
  await headlineField(page).fill("My saved headline");
  await expect(savedStatus(page)).toBeVisible();
  const sent = watchEverySave(page, siteId);
  const id = await askNewWording(page, siteId);

  const lock = page.getByText(WRITING_LOCK);
  await expect(lock).toHaveCount(1);
  const headline = headlineField(page);
  await headline.focus();
  await page.keyboard.type("Lost");
  await expect(headline).toHaveValue("My saved headline");
  await expect(headline).toBeFocused();
  await expect(page.getByRole("button", { name: "Add a question" })).toHaveAttribute("aria-disabled", "true");

  await page.getByRole("tab", { name: "Sections" }).click();
  await expect(lock).toHaveCount(1);
  const move = page.getByRole("button", { name: "Move Questions and answers up" });
  await expect(move).toHaveAttribute("aria-disabled", "true");
  await move.click({ force: true });
  const hide = page.getByLabel("Hide About you");
  await expect(hide).toHaveAttribute("aria-disabled", "true");
  await hide.click({ force: true });
  await expect(hide).not.toBeChecked();

  await page.getByRole("tab", { name: "Look" }).click();
  await expect(lock).toHaveCount(1);
  await expect(green(page)).toHaveAttribute("aria-disabled", "true");
  await green(page).click({ force: true });
  await expect(green(page)).not.toBeChecked();

  await page.getByRole("tab", { name: "Details" }).click();
  await expect(lock).toHaveCount(1);
  const business = page.getByLabel("Business name");
  const name = await business.inputValue();
  await business.focus();
  await page.keyboard.type("Lost");
  await expect(business).toHaveValue(name);
  await expect(business).toBeFocused();

  await page.getByRole("tab", { name: "Photos" }).click();
  await expect(lock).toHaveCount(1);
  await expect(page.getByRole("group", { name: "Main photo" })).toBeVisible();
  await expect(page.locator('[role="tabpanel"] [aria-disabled="true"]').first()).toBeVisible();

  await noChangeQueued(page);
  expect(sent).toEqual([]);

  await finishGeneration(page.request, id);
  await expect(page.getByText("New wording is ready.")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("tab", { name: "Words" }).click();
  await expect(lock).toHaveCount(0);
  await headlineField(page).fill("Typed when it was ready");
  await expect(savedStatus(page)).toBeVisible();
  expect(((await savedEdits(page, siteId)) as { copy: { heroHeadline?: string } }).copy.heroHeadline).toBe("Typed when it was ready");
});

// STRICT (customer data, round 4): a failed rewrite lifts the lock with the existing text, and the stored edits were never touched.
test("a failed rewrite lifts the lock and says so; the stored edits are untouched and editing works again", async ({ page }) => {
  const siteId = await openEditor(page);
  await headlineField(page).fill("My saved headline");
  await expect(savedStatus(page)).toBeVisible();
  const before = await savedEdits(page, siteId);
  const sent = watchEverySave(page, siteId);
  const id = await askNewWording(page, siteId);
  await expect(page.getByText(WRITING_LOCK)).toBeVisible();
  await finishGeneration(page.request, id, "failed");
  await expect(page.getByText("We could not write new wording this time. Your current wording is unchanged.")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(WRITING_LOCK)).toHaveCount(0);
  expect(sent).toEqual([]);
  // Only the look the server pinned when the rewrite was asked for (A12 §3) may differ; wording, order and hidden are exactly as they were.
  const after = await savedEdits(page, siteId);
  expect({ copy: after.copy, order: after.order }).toEqual({ copy: before.copy, order: before.order });
  expect(after.theme).not.toBeNull();
  await expect(headlineField(page)).toHaveValue("My saved headline");

  await headlineField(page).fill("Typed after the failure");
  await expect(savedStatus(page)).toBeVisible();
  expect(((await savedEdits(page, siteId)) as { copy: { heroHeadline?: string } }).copy.heroHeadline).toBe("Typed after the failure");
});

// STRICT (customer data, guard round 3): one rule for a dropped wording change. Nothing leaves over it unseen, on any page, and no action
// says "not saved yet" for it.
const NOT_SAVED_YET = /not saved yet/;

/** Leaves the editor the way the browser's Back does (no leave guard), by the app's own route change. */
const goBackTo = (page: Page, path: string) =>
  page.evaluate((to) => {
    history.pushState(null, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);

/** Tab A's headline change is refused (tab B's new wording landed); its notice is up. */
async function staleTabDropped(page: Page, browser: Browser) {
  const stale = await staleTab(page, browser);
  await headlineField(page).fill("My own headline");
  await expect(page.getByRole("status").filter({ hasText: WORDING_DROPPED })).toBeVisible();
  return stale;
}

// STRICT (customer data, round 4, the other tab): a tab opened BEFORE the rewrite saves a change while it runs. The server refuses it, the tab
// never sends it again, says exactly why, locks, and nothing stored is erased. A failed rewrite then lifts the lock.
test("a tab opened before another tab's rewrite cannot save while it runs: it is told, locked, nothing is sent again and nothing is erased", async ({ page, browser }) => {
  const siteId = await openEditor(page);
  await headlineField(page).fill("My saved headline");
  await expect(savedStatus(page)).toBeVisible();
  const first = await aiGenerationId(page, siteId);
  const other = await browser.newContext({ baseURL: APP, ignoreHTTPSErrors: true, storageState: await page.context().storageState() });
  try {
    const tabB = await other.newPage();
    await tabB.goto(`/sites/${siteId}/edit`);
    const id = await askNewWording(tabB, siteId); // queued: the new wording has not landed

    const answers: number[] = [];
    page.on("response", (r) => r.request().method() === "PATCH" && r.url().endsWith(`/api/sites/${siteId}/draft`) && answers.push(r.status()));
    await headlineField(page).fill("Changed in the old tab");
    const notice = page.getByRole("status").filter({ hasText: WRITING_DROPPED });
    await expect(notice).toBeVisible();
    await expect(page.getByText(WRITING_LOCK)).toHaveCount(1);
    await expect(savedStatus(page)).toHaveCount(0);
    await noChangeQueued(page); // a second send would show "Saving…" at once
    expect(answers).toEqual([409]);
    // The stored wording is exactly what it was, and the screen shows it.
    const stored = (await siteView(page, siteId))["edits"] as { baseGenerationId: string | null; copy: { heroHeadline?: string } };
    expect(stored.baseGenerationId).toBe(first);
    expect(stored.copy.heroHeadline).toBe("My saved headline");
    await expect(headlineField(page)).toHaveValue("My saved headline");
    // Read-only now: typing changes nothing.
    await headlineField(page).focus();
    await page.keyboard.type("Lost");
    await expect(headlineField(page)).toHaveValue("My saved headline");

    await finishGeneration(tabB.request, id, "failed");
    await expect(page.getByText("We could not write new wording this time. Your current wording is unchanged.")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(WRITING_LOCK)).toHaveCount(0);
    expect(((await siteView(page, siteId))["edits"] as { copy: { heroHeadline?: string } }).copy.heroHeadline).toBe("My saved headline");
    await page.getByRole("button", { name: "Dismiss" }).click();
    await headlineField(page).fill("Typed when it was ready");
    await expect(savedStatus(page)).toBeVisible();
    expect(((await siteView(page, siteId))["edits"] as { copy: { heroHeadline?: string } }).copy.heroHeadline).toBe("Typed when it was ready");
    expect(answers).toEqual([409, 200]);
  } finally {
    await other.close();
  }
});

// R3: the Details tab's address Save is not a leave. It saves the address and never uses up the stop owed to the owner.
test("saving the web address after a dropped wording change saves it, keeps the notice, and Publish still stops once", async ({ page, browser }) => {
  const { siteId } = await staleTabDropped(page, browser);
  const slug = uniqueSlug("moved");
  await page.getByRole("tab", { name: "Details" }).click();
  await page.getByLabel("Which answers?").selectOption({ label: "Your web address" });
  await page.getByLabel("Web address").fill(slug);
  await expect(page.getByText("This address is free. Save it to keep it.")).toBeVisible();
  // Save PUTs the address, then reloads the site with a GET (the page's own request; apiCall below goes through page.request and is not seen here).
  // Press Publish only once that reload has ended and the button is back, or the first press can land on the saver the reload replaces.
  const reloaded = page.waitForResponse((res) => res.request().method() === "GET" && new URL(res.url()).pathname === `/api/sites/${siteId}`);
  await page.getByRole("button", { name: "Save this web address" }).click();
  await reloaded;
  await expect(page.getByRole("button", { name: "Save this web address" })).toBeVisible();
  await expect.poll(async () => (await siteView(page, siteId))["slug"]).toBe(slug);
  await expect(page.getByText(NOT_SAVED_YET)).toHaveCount(0);
  const notice = page.getByRole("status").filter({ hasText: WORDING_DROPPED });
  await expect(notice).toBeVisible();

  const publish = page.getByRole("link", { name: "Publish" });
  await publish.click();
  await expect(notice).toBeFocused();
  expect(new URL(page.url()).pathname).toBe(`/sites/${siteId}/edit`);
  await publish.click();
  await page.waitForURL(`${APP}/sites/${siteId}/publish`);
});

// R4 (Publish): a drop carried out of the editor is shown on the Publish page, which stops once and never says "not saved yet".
test("a dropped wording change carried to the Publish page is shown there with Dismiss, stops Publish once, and the second press goes on", async ({ page, browser }) => {
  const { siteId } = await staleTabDropped(page, browser);
  const posts: string[] = [];
  page.on("request", (r) => r.method() === "POST" && r.url().endsWith("/publish-requests") && posts.push(r.url()));
  await goBackTo(page, `/sites/${siteId}/publish`);
  const notice = page.getByRole("status").filter({ hasText: WORDING_DROPPED });
  await expect(notice).toBeVisible();
  await expect(page.getByRole("button", { name: "Dismiss" })).toBeVisible();

  const send = page.getByRole("button", { name: "Send for review" });
  await send.click();
  await expect(notice).toBeFocused();
  await expect(page.getByText(NOT_SAVED_YET)).toHaveCount(0);
  expect(posts).toEqual([]);

  await send.click();
  await expect(page.getByRole("status").filter({ hasText: "Sent for review." })).toBeVisible();
  expect(posts).toHaveLength(1);
});

// R4 (Questionnaire): the same on a questionnaire step, which had no Dismiss.
test("a dropped wording change carried to the questionnaire is shown there with Dismiss, and the first Save and continue stops", async ({ page, browser }) => {
  const { siteId } = await staleTabDropped(page, browser);
  await goBackTo(page, `/sites/${siteId}/setup/business`);
  const notice = page.getByRole("status").filter({ hasText: WORDING_DROPPED });
  await expect(notice).toBeVisible();
  await expect(page.getByRole("button", { name: "Dismiss" })).toBeVisible();

  const next = page.getByRole("button", { name: "Save and continue" });
  await next.click();
  await expect(notice).toBeFocused();
  await expect(page.getByText(NOT_SAVED_YET)).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe(`/sites/${siteId}/setup/business`);
  await next.click();
  await page.waitForURL(`${APP}/sites/${siteId}/setup/**`, { timeout: 15_000 });
  expect(new URL(page.url()).pathname).not.toBe(`/sites/${siteId}/setup/business`);
});

// R5 (decision 37): the header link leaves on an ordinary failed save. In a conflict it must not be stuck.
test("the header link home still works when saving has stopped on a conflict", async ({ page }) => {
  const siteId = await openEditor(page);
  const rev = (await siteView(page, siteId))["rev"] as number;
  expect((await apiCall(page, "PATCH", `/api/sites/${siteId}/draft`, { rev, brief: { tone: "professional", goal: "call" } })).status).toBe(200);
  await headlineField(page).fill("Typed in a stale tab");
  await expect(page.getByText("This site changed in another tab or window.")).toBeVisible();
  await page.getByRole("link", { name: "Your website", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Your websites" })).toBeVisible();
});

// STRICT (customer data, round 4, the probe): the editor is frozen while the AI writes, so a hide or a look change made then can never
// carry (or erase) the owner's saved wording. After a failed rewrite the stored wording is exactly what it was.
test("a hide or look change tried during a rewrite changes nothing, and after a failed rewrite the saved headline is intact", async ({ page }) => {
  const siteId = await openEditor(page);
  await headlineField(page).fill("My saved headline");
  await expect(savedStatus(page)).toBeVisible();
  expect((await savedEdits(page, siteId)).copy.heroHeadline).toBe("My saved headline");
  const id = await askNewWording(page, siteId); // queued: the rewrite is running
  const before = await savedEdits(page, siteId);

  await page.getByRole("tab", { name: "Sections" }).click();
  await page.getByLabel("Hide About you").click({ force: true });
  await page.getByRole("tab", { name: "Look" }).click();
  await green(page).click({ force: true });
  await noChangeQueued(page);
  const during = await savedEdits(page, siteId);
  expect(during).toEqual(before); // neither the hide nor the look was stored, and the headline is intact

  await finishGeneration(page.request, id, "failed");
  await expect(page.getByText("We could not write new wording this time. Your current wording is unchanged.")).toBeVisible({ timeout: 15_000 });
  expect((await savedEdits(page, siteId)).copy.heroHeadline).toBe("My saved headline");
  await page.reload();
  await expect(headlineField(page)).toHaveValue("My saved headline");
});

// R2 (the f4 review's E-1 probe): the Trust step's reviews go through the guarded setter. Text entered WITHOUT a key event (IME, dictation,
// autocorrect) must change nothing and send nothing while the editor is frozen.
test("while new wording is written, text entered into a review without a key event changes nothing and sends nothing", async ({ page }) => {
  const siteId = await builtSite(page, { ...FACTS, testimonials: [{ quote: "Fixed our leak the same afternoon.", name: "Ana P." }] });
  await page.goto(`/sites/${siteId}/edit`);
  await expect(page.getByRole("heading", { level: 1, name: "Edit your website" })).toBeFocused();
  await page.getByRole("tab", { name: "Details" }).click();
  await page.locator("#details-step").selectOption("trust"); // chosen before the freeze: the picker is aria-disabled while frozen
  const id = await askNewWording(page, siteId);
  const sent = watchEverySave(page, siteId);
  await expect(page.getByText(WRITING_LOCK)).toHaveCount(1);
  await page.getByRole("tab", { name: "Details" }).click();
  const review = page.getByLabel("Review 1", { exact: true });
  await expect(review).toHaveValue("Fixed our leak the same afternoon.");
  await review.focus();
  await page.keyboard.insertText(" EXTRA");
  await expect(review).toHaveValue("Fixed our leak the same afternoon.");
  await noChangeQueued(page);
  expect(sent).toEqual([]);
  await finishGeneration(page.request, id, "failed");
  await expect(page.getByText("We could not write new wording this time. Your current wording is unchanged.")).toBeVisible({ timeout: 15_000 });
  const stored = (await siteView(page, siteId))["facts"] as { testimonials?: Array<{ quote: string }> };
  expect(stored.testimonials?.[0]?.quote).toBe("Fixed our leak the same afternoon.");
});

// R1 (A), the f4 review's I-2 probe: an answer typed on the Questionnaire while another tab's rewrite runs is STORED, even when the owner
// leaves at once. Answers are not edits.
test("an answer typed on the questionnaire during another tab's rewrite is stored, even when the owner leaves at once", async ({ page, browser }) => {
  const siteId = await builtSite(page);
  const other = await browser.newContext({ baseURL: APP, ignoreHTTPSErrors: true, storageState: await page.context().storageState() });
  try {
    const tabB = await other.newPage();
    await tabB.goto(`/sites/${siteId}/edit`);
    await expect(headlineField(tabB)).toBeVisible();
    const id = await askNewWording(tabB, siteId);
    await page.goto(`/sites/${siteId}/setup/business`);
    await expect(page.getByRole("heading", { level: 1, name: "Your business" })).toBeVisible();
    const answers: number[] = [];
    page.on("response", (r) => r.request().method() === "PATCH" && r.url().endsWith(`/api/sites/${siteId}/draft`) && answers.push(r.status()));
    await page.getByLabel("Business name").fill("Joe's Plumbing and Heating");
    await page.getByRole("link", { name: "Your website", exact: true }).click();
    await expect.poll(() => answers).toEqual([200]);
    expect(((await siteView(page, siteId))["facts"] as { businessName: string }).businessName).toBe("Joe's Plumbing and Heating");
    await finishGeneration(tabB.request, id, "failed");
  } finally {
    await other.close();
  }
});

// R1 (A), the other tab: a tab opened before the rewrite changes an ANSWER while it runs: stored, no notice, no lock; an edit still refused.
test("a tab opened before another tab's rewrite stores an answer change, and still refuses a wording change", async ({ page, browser }) => {
  const siteId = await openEditor(page);
  await headlineField(page).fill("My saved headline");
  await expect(savedStatus(page)).toBeVisible();
  const other = await browser.newContext({ baseURL: APP, ignoreHTTPSErrors: true, storageState: await page.context().storageState() });
  try {
    const tabB = await other.newPage();
    await tabB.goto(`/sites/${siteId}/edit`);
    const id = await askNewWording(tabB, siteId);
    await page.getByRole("tab", { name: "Details" }).click();
    await page.getByLabel("Business name").fill("Joe's Plumbing and Heating");
    await expect(savedStatus(page)).toBeVisible();
    expect(((await siteView(page, siteId))["facts"] as { businessName: string }).businessName).toBe("Joe's Plumbing and Heating");
    await expect(page.getByText(WRITING_LOCK)).toHaveCount(0);
    await page.getByRole("tab", { name: "Words" }).click();
    await headlineField(page).fill("Changed in the old tab");
    await expect(page.getByRole("status").filter({ hasText: WRITING_DROPPED })).toBeVisible();
    expect(((await savedEdits(page, siteId)) as { copy: { heroHeadline?: string } }).copy.heroHeadline).toBe("My saved headline");
    await finishGeneration(tabB.request, id, "failed");
  } finally {
    await other.close();
  }
});

// R4 (the f4 review's m-1): "Write new wording" refused because another tab's rewrite is already running locks this tab and follows it.
test("a refused request for new wording (another tab's rewrite runs) locks the tab and follows that rewrite", async ({ page, browser }) => {
  const siteId = await openEditor(page);
  const other = await browser.newContext({ baseURL: APP, ignoreHTTPSErrors: true, storageState: await page.context().storageState() });
  try {
    const tabB = await other.newPage();
    await tabB.goto(`/sites/${siteId}/edit`);
    const idB = await askNewWording(tabB, siteId);
    await page.getByRole("tab", { name: "Words" }).click();
    await page.getByRole("button", { name: "Write new wording" }).click();
    const [refused] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/sites/${siteId}/generations`) && r.request().method() === "POST"),
      page.getByRole("dialog", { name: "Write new wording?" }).getByRole("button", { name: "Write new wording" }).click(),
    ]);
    expect(refused.status()).toBe(409);
    await expect(page.getByText(WRITING_LOCK)).toHaveCount(1);
    const headline = headlineField(page);
    const shown = await headline.inputValue();
    await headline.focus();
    await page.keyboard.type("Lost");
    await expect(headline).toHaveValue(shown);
    await noChangeQueued(page);
    // It follows the other tab's rewrite: when that lands, the new wording is shown and editing works again.
    await finishGeneration(tabB.request, idB);
    await expect(page.getByText("New wording is ready.")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(WRITING_LOCK)).toHaveCount(0);
    await headlineField(page).fill("Typed when it was ready");
    await expect(savedStatus(page)).toBeVisible();
  } finally {
    await other.close();
  }
});

// m-6: the frozen editor blocks Photos upload, delete and move by behaviour, not only by the wrapper's attribute.
test("while new wording is written, Photos upload, delete and move send nothing and change nothing", async ({ page }) => {
  const siteId = await openEditor(page);
  await page.getByRole("tab", { name: "Photos" }).click();
  const photo = await sharp({ create: { width: 800, height: 400, channels: 3, background: { r: 20, g: 160, b: 90 } } }).jpeg().toBuffer();
  const jpeg = (name: string) => ({ name, mimeType: "image/jpeg", buffer: photo });
  const uploadsBefore = async () => ((await siteView(page, siteId))["uploads"] as unknown[]).length;
  for (const [n, name] of ["a.jpg", "b.jpg"].entries()) {
    await page.getByLabel("Upload a photo").setInputFiles(jpeg(name));
    await expect.poll(uploadsBefore).toBe(n + 1);
    await expect(page.getByLabel("Upload a photo")).toHaveAttribute("aria-disabled", "false");
  }
  const count = await uploadsBefore();
  await page.getByRole("button", { name: "Add uploaded photo 1 to your work photos" }).click();
  await page.getByRole("button", { name: "Add uploaded photo 2 to your work photos" }).click();
  await page.getByLabel("Describe work photo 1").fill("A new water heater in a garage");
  await page.getByLabel("Describe work photo 2").fill("A repaired kitchen drain");
  const storedPhotos = async () => ((await siteView(page, siteId))["facts"] as { photos?: Array<{ url: string; alt?: string }> }).photos ?? [];
  await expect.poll(async () => (await storedPhotos()).map((p) => p.alt)).toEqual(["A new water heater in a garage", "A repaired kitchen drain"]);
  const photosBefore = (await storedPhotos()).map((p) => p.url);
  expect(photosBefore).toHaveLength(2);
  // Reload so the Photos tab lists the stored uploads (it reads them from the loaded view).
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Edit your website" })).toBeFocused();

  const id = await askNewWording(page, siteId);
  await expect(page.getByText(WRITING_LOCK)).toHaveCount(1);
  await page.getByRole("tab", { name: "Photos" }).click();
  const writes: string[] = [];
  page.on("request", (r) => r.method() !== "GET" && r.url().includes(`/api/sites/${siteId}/`) && writes.push(`${r.method()} ${new URL(r.url()).pathname}`));
  await page.getByLabel("Upload a photo").setInputFiles(jpeg("c.jpg"));
  await page.getByRole("button", { name: "Delete uploaded photo 1" }).click({ force: true });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Move work photo 1 down" }).click({ force: true });
  await noChangeQueued(page);
  await expect(page.getByText("Uploading your photo…")).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(await uploadsBefore()).toBe(count);
  expect((await storedPhotos()).map((p) => p.url)).toEqual(photosBefore);
  await finishGeneration(page.request, id, "failed");
  await expect(page.getByText("We could not write new wording this time. Your current wording is unchanged.")).toBeVisible({ timeout: 15_000 });
});

test("while new wording is written, the web address Save sends nothing and the address is not changed", async ({ page }) => {
  const siteId = await openEditor(page);
  const slugBefore = (await siteView(page, siteId))["slug"];
  await page.getByRole("tab", { name: "Details" }).click();
  await page.locator("#details-step").selectOption("address"); // chosen before the freeze: the picker is aria-disabled while frozen
  const id = await askNewWording(page, siteId);
  await expect(page.getByText(WRITING_LOCK)).toHaveCount(1);
  // Back on Details the address form mounts fresh, so the new address is entered now, after the freeze.
  // fill() sends no key event, so the wrapper lets it through and it only changes the field's local state.
  await page.getByRole("tab", { name: "Details" }).click();
  const field = page.getByLabel("Web address");
  const typed = uniqueSlug("frozen");
  await field.fill(typed, { force: true });
  await expect(field).toHaveValue(typed);
  await expect(page.getByText("This address is free. Save it to keep it.")).toBeVisible();
  // The Save is now genuinely enabled; only the freeze can stop it. No request of any kind may be written for this site.
  const writes: string[] = [];
  const isWrite = (request: Request) => request.method() !== "GET" && new URL(request.url()).pathname.startsWith(`/api/sites/${siteId}`);
  page.on("request", (request) => isWrite(request) && writes.push(`${request.method()} ${request.url()}`));
  await page.getByRole("button", { name: "Save this web address" }).click({ force: true });
  // Bounded window: the one place we wait on the clock, because "no request arrives" has no state to wait for.
  await page.waitForRequest(isWrite, { timeout: 5_000 }).catch(() => null);
  expect(writes).toEqual([]);
  expect((await siteView(page, siteId))["slug"]).toBe(slugBefore);
  await finishGeneration(page.request, id, "failed");
  await expect(page.getByText("We could not write new wording this time. Your current wording is unchanged.")).toBeVisible({ timeout: 15_000 });
});
