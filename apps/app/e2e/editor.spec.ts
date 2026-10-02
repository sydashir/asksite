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
  await page.getByRole("button", { name: "Reload the page" }).click();
  await expect.poll(kept).toBe(false);
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

test("a change that could not be saved survives new wording, with its warning, and saves once saving works", async ({ page }) => {
  const siteId = await openEditor(page);
  let failing = true;
  await page.route(`**/api/sites/${siteId}/draft`, (route) =>
    failing ? route.fulfill({ status: 500, json: { error: { code: "internal", message: "Something went wrong. Please try again." } } }) : route.fallback(),
  );
  await page.getByRole("tab", { name: "Look" }).click();
  await green(page).check();
  await expect(page.getByRole("status").filter({ hasText: NOT_SAVED })).toBeVisible();

  const id = await askNewWording(page, siteId);
  await finishGeneration(page.request, id);
  await expect(page.getByText("New wording is ready.")).toBeVisible({ timeout: 15_000 });

  await expect(page.getByRole("status").filter({ hasText: NOT_SAVED })).toBeVisible();
  await page.getByRole("tab", { name: "Look" }).click();
  await expect(green(page)).toBeChecked();
  expect(await savedTheme(page, siteId)).not.toBe("green-amber");

  failing = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(savedStatus(page)).toBeVisible();
  expect(await savedTheme(page, siteId)).toBe("green-amber");
});

test("a change made while new wording arrives is kept on screen and saved", async ({ page }) => {
  const siteId = await openEditor(page);
  const gate = await holdNextSiteGet(page, siteId);
  gate.armed = true;
  const id = await askNewWording(page, siteId);
  await finishGeneration(page.request, id);
  await expect.poll(() => gate.reached, { timeout: 15_000 }).toBe(true);

  await page.getByRole("tab", { name: "Look" }).click();
  await green(page).check();
  gate.release();
  await expect(page.getByText("New wording is ready.")).toBeVisible();

  await expect(green(page)).toBeChecked();
  await expect(savedStatus(page)).toBeVisible();
  await expect.poll(() => savedTheme(page, siteId)).toBe("green-amber");
});

test("a change saved while new wording arrives stays, and the next change is not refused as another tab's", async ({ page }) => {
  const siteId = await openEditor(page);
  const gate = await holdNextSiteGet(page, siteId);
  gate.armed = true;
  const id = await askNewWording(page, siteId);
  await finishGeneration(page.request, id);
  await expect.poll(() => gate.reached, { timeout: 15_000 }).toBe(true);

  // The held answer is from before this change, so it is stale when it arrives.
  await page.getByRole("tab", { name: "Look" }).click();
  await green(page).check();
  await expect(savedStatus(page)).toBeVisible();
  await expect.poll(() => savedTheme(page, siteId)).toBe("green-amber");
  gate.release();
  await expect(page.getByText("New wording is ready.")).toBeVisible();
  await expect(green(page)).toBeChecked();

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
  await expect(page.getByText(UNREADABLE)).toHaveCount(0);

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
  await expect(page.getByText(UNREADABLE)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("New wording is ready.")).toHaveCount(0);
  expect(gate.failed).toBe(2); // one try and one retry, never more
  await expect(page.getByRole("button", { name: "Reload the page" })).toBeVisible();

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

  await page.waitForTimeout(1500); // longer than the autosave delay
  expect(bases).toEqual([]);
  expect((await savedEdits(page, siteId)).order).toBeNull();

  // The look does not depend on the AI's wording, so it stays editable.
  await page.getByRole("tab", { name: "Look" }).click();
  await green(page).check();
  await expect.poll(() => savedTheme(page, siteId)).toBe("green-amber");
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
