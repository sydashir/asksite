import { expect, test, type Locator, type Page } from "@playwright/test";
import { acceptInvite, apiCall, APP, BRIEF, builtSite, expectAccessible, expectNoSidewaysScroll, FACTS, finishGeneration, seedDraft, uniqueEmail, uniqueSlug } from "./support.ts";

/** The Business name field's id (fieldId(["facts", "businessName"])). */
const NAME_FIELD_ID = "f-facts-businessName";

/**
 * Records what the Business name field saw, for a failure report: focus, beforeinput, input and change, each with the
 * field's value then and the focused element. "after React" is a second input listener on the document, which runs
 * after React's own listener on its root, so it shows whether the app put a different value back. A value the app
 * clears later fires no event, so every click (leaving the step) also records the field's value just before it.
 */
async function logNameFieldEvents(page: Page) {
  await page.evaluate((id) => {
    const events: object[] = [];
    (window as unknown as { __nameFieldEvents: object[] }).__nameFieldEvents = events;
    const push = (phase: string, event: Event) => {
      const field = document.getElementById(id);
      const active = document.activeElement;
      const input = event instanceof InputEvent ? { inputType: event.inputType, data: event.data } : {};
      const value = field instanceof HTMLInputElement ? field.value : null;
      events.push({ at: Math.round(performance.now()), phase, type: event.type, ...input, value, active: active?.id || active?.tagName || null });
    };
    const onField = (phase: string) => (event: Event) => {
      if (event.target instanceof HTMLInputElement && event.target.id === id) push(phase, event);
    };
    for (const type of ["focusin", "focusout", "beforeinput", "input", "change"]) document.addEventListener(type, onField("capture"), true);
    document.addEventListener("input", onField("after React"));
    document.addEventListener("click", (event) => push("capture", event), true);
  }, NAME_FIELD_ID);
}

// Failure only: attach the Business name field's events when a test that logged them fails, so a recurrence tells
// "nothing was typed" (no input events) from "typed text was wiped" (an input event with the value, then it is gone).
test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const evidence = await page
    .evaluate((id) => {
      const events = (window as unknown as { __nameFieldEvents?: object[] }).__nameFieldEvents;
      if (events === undefined) return null;
      const active = document.activeElement;
      return { events, fieldNow: (document.getElementById(id) as HTMLInputElement | null)?.value ?? null, activeNow: active?.id || active?.tagName || null };
    }, NAME_FIELD_ID)
    .catch(() => null);
  if (evidence !== null) await testInfo.attach("business-name-field-events", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
});

test("invite, then the seven questionnaire steps, then Build starts writing the website", async ({ page }) => {
  const email = uniqueEmail("journey");
  const siteId = await acceptInvite(page, email);

  await expect(page.getByRole("heading", { level: 1, name: "Your business" })).toBeFocused();
  await page.getByLabel("Business name").fill("Joe's Plumbing");
  await page.getByLabel("What kind of work do you do?").selectOption("plumbing");
  await page.getByLabel("Business phone number").fill("(512) 555-0142");
  await expect(page.getByLabel("Business email address")).toHaveValue(email);
  await page.getByLabel("City").fill("Austin");
  await page.getByLabel("State", { exact: true }).selectOption("TX");
  await page.getByRole("button", { name: "Save and continue" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Your services" })).toBeFocused();
  await page.getByLabel("Service 1", { exact: true }).fill("Drain cleaning");
  await page.getByLabel("Starting price for service 1, in dollars").fill("89");
  await page.getByRole("button", { name: "Add a service" }).click();
  await expect(page.getByLabel("Service 2", { exact: true })).toBeFocused();
  await page.getByLabel("Service 2", { exact: true }).fill("Water heaters");
  await page.getByLabel("We give free estimates or quotes").check();
  await page.getByRole("button", { name: "Save and continue" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Where you work and when" })).toBeFocused();
  await page.getByLabel("Place 1").fill("Austin");
  await page.getByRole("button", { name: "Add a place" }).click();
  await page.getByLabel("Place 2").fill("Round Rock");
  await page.getByLabel("Open on Monday").check();
  await page.getByRole("button", { name: "Save and continue" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Why customers can trust you" })).toBeFocused();
  await page.getByLabel("Years in business").fill("12");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Photos and links" })).toBeFocused();
  await page.getByRole("button", { name: "Save and continue" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "In your own words" })).toBeFocused();
  await page.getByLabel("Friendly").check();
  await page.getByLabel("Call us").check();
  await page.getByRole("button", { name: "Save and continue" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Your web address" })).toBeFocused();
  const slug = `joes-plumbing-${Date.now().toString(36)}`;
  await page.getByLabel("Web address").fill(slug);
  await expect(page.getByText("This address is free. Save it to keep it.")).toBeVisible();
  await page.getByRole("button", { name: "Save this web address" }).click();
  await expect(page.getByText("This is your web address.")).toBeVisible();
  await page.getByRole("button", { name: "Build my website" }).click();

  await page.waitForURL(`${APP}/sites/${siteId}/build`);
  await expect(page.getByRole("heading", { level: 1, name: "Building your website" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("We are writing your website. This usually takes under a minute.");
  const view = await apiCall(page, "GET", `/api/sites/${siteId}`);
  expect(view.json?.["facts"]).toMatchObject({ phone: "+15125550142", yearFounded: new Date().getFullYear() - 12, freeEstimates: true });
  expect((view.json?.["activeGeneration"] as { status: string }).status).toBe("queued");
});

test("the build page tries again through a server hiccup, and offers Try again if it lasts @mobile", async ({ page }) => {
  const siteId = await acceptInvite(page);
  await apiCall(page, "PATCH", `/api/sites/${siteId}/draft`, { rev: 1, facts: FACTS, brief: BRIEF });
  await apiCall(page, "POST", `/api/sites/${siteId}/generations`, {});
  const polled = () => page.waitForRequest((req) => req.url().includes(`/api/sites/${siteId}/generations/`));
  let failures = 1;
  await page.route(`**/api/sites/${siteId}`, (route) =>
    failures-- > 0 ? route.fulfill({ status: 500, json: { error: { code: "internal", message: "Something went wrong. Please try again." } } }) : route.continue(),
  );

  // One failed load is tried again without bothering the owner.
  let polling = polled();
  await page.goto(`/sites/${siteId}/build`);
  await polling;
  await expect(page.getByRole("alert")).toHaveCount(0);

  // A failure that lasts is shown, with a button that tries again.
  failures = 3;
  await page.reload();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Something went wrong. Please try again.");
  await expectAccessible(page);
  polling = polled();
  await alert.getByRole("button", { name: "Try again" }).click();
  await polling;
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("Continue with missing answers shows a focused error summary that links to each field @mobile", async ({ page }) => {
  await acceptInvite(page);
  await page.getByLabel("Business email address").fill("");
  await page.getByRole("button", { name: "Save and continue" }).click();
  const summary = page.getByRole("heading", { name: /things to fix/ }).locator("..");
  await expect(summary).toBeFocused();
  await expect(page.getByLabel("Business name")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Enter your business name (at least 2 characters).").first()).toBeVisible();
  await summary.getByRole("link", { name: "Enter a 10-digit US phone number, like (512) 555-0142." }).click();
  await expect(page.getByLabel("Business phone number")).toBeFocused();
  await expectAccessible(page);
  await expectNoSidewaysScroll(page);
});

test("answers are saved automatically and survive a reload @firefox", async ({ page }) => {
  const siteId = await acceptInvite(page);
  await page.getByLabel("Business name").fill("Autosave Plumbing");
  await expect(page.getByRole("status").filter({ hasText: "All changes saved." })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Business name")).toHaveValue("Autosave Plumbing");
  const view = await apiCall(page, "GET", `/api/sites/${siteId}`);
  expect((view.json?.["facts"] as { businessName: string }).businessName).toBe("Autosave Plumbing");
});

test("a second tab that saves later is stopped with a clear message", async ({ page, context }) => {
  const siteId = await acceptInvite(page);
  // The business email starts as the sign-in email and is saved by itself soon after the step loads (BusinessStep.tsx). Wait for that save
  // first: a second tab opened before it would load the same rev, save the same prefill first, and make THIS tab the stale one.
  await expect(page.getByLabel("Business email address")).not.toHaveValue("");
  await expect(page.getByRole("status").filter({ hasText: "All changes saved." })).toBeVisible();
  const other = await context.newPage();
  await other.goto(`/sites/${siteId}/setup/business`);
  await expect(other.getByLabel("Business email address")).not.toHaveValue("");
  await page.getByLabel("City").fill("Austin");
  await expect(page.getByRole("status").filter({ hasText: "All changes saved." })).toBeVisible();
  await other.getByLabel("City").fill("Dallas");
  await expect(other.getByText("This site changed in another tab or window. Reload to see the latest version.")).toBeVisible();
  await other.getByRole("button", { name: "Reload" }).click();
  await expect(other.getByLabel("City")).toHaveValue("Austin");
});

test("a problem in a step's own comment box is listed on that step, and its link focuses the box", async ({ page }) => {
  const siteId = await acceptInvite(page);
  await seedDraft(page, siteId, "comment");
  await page.goto(`/sites/${siteId}/setup/business`);
  await page.getByLabel("Anything we should know about this?").fill("Park on the street\u200B please");
  await page.getByRole("button", { name: "Save and continue" }).click();
  const summary = page.getByRole("heading", { name: /things? to fix/ }).locator("..");
  await expect(summary).toBeFocused();
  await summary.getByRole("link", { name: "This text has hidden characters. Please delete it and type it again." }).click();
  await expect(page.getByLabel("Anything we should know about this?")).toBeFocused();

  // The last step lists it too; its link opens the business step on that box, and Build works once it is fixed.
  await page.getByRole("navigation", { name: "Questionnaire steps" }).getByRole("link", { name: "7. Your web address" }).click();
  await page.getByRole("button", { name: "Build my website" }).click();
  await page.getByRole("link", { name: "Your business: This text has hidden characters. Please delete it and type it again." }).click();
  await page.waitForURL(`${APP}/sites/${siteId}/setup/business#f-brief-comments-business`);
  await expect(page.getByLabel("Anything we should know about this?")).toBeFocused();
  await page.getByLabel("Anything we should know about this?").fill("Park on the street please");
  await page.getByRole("navigation", { name: "Questionnaire steps" }).getByRole("link", { name: "7. Your web address" }).click();
  await page.getByRole("button", { name: "Build my website" }).click();
  await page.waitForURL(`${APP}/sites/${siteId}/build`);
});

test("changing a review clears the confirmation that the reviews are real", async ({ page }) => {
  const siteId = await acceptInvite(page);
  await page.goto(`/sites/${siteId}/setup/trust`);
  await page.getByRole("button", { name: "Add a review" }).click();
  await page.getByLabel("Review 1", { exact: true }).fill("Fixed our leak the same afternoon.");
  await page.getByLabel("Review 1: customer's name").fill("Ana P.");
  const confirm = page.getByLabel("These reviews are from real customers, copied word for word");
  await confirm.check();
  const confirmed = async () => ((await apiCall(page, "GET", `/api/sites/${siteId}`)).json?.["brief"] as { reviewsAreReal?: boolean }).reviewsAreReal;
  await expect.poll(confirmed).toBe(true);
  await page.getByLabel("Review 1", { exact: true }).fill("Fixed our leak the same afternoon. Great work!");
  await expect(confirm).not.toBeChecked();
  await expect.poll(confirmed).toBe(false);

  // Adding and removing a review clear it too (decision 38: no server-side reset).
  await confirm.check();
  await expect.poll(confirmed).toBe(true);
  await page.getByRole("button", { name: "Add a review" }).click();
  await expect(confirm).not.toBeChecked();
  await expect.poll(confirmed).toBe(false);
  await confirm.check();
  await expect.poll(confirmed).toBe(true);
  await page.getByRole("button", { name: "Remove review 2" }).click();
  await expect(confirm).not.toBeChecked();
  await expect.poll(confirmed).toBe(false);

  // Changing who a review is attributed to clears it too (the name and the town are part of the review).
  for (const field of ["Review 1: customer's name", "Review 1: customer's town"]) {
    await confirm.check();
    await expect.poll(confirmed).toBe(true);
    await page.getByLabel(field).fill("Changed after confirming");
    await expect(confirm).not.toBeChecked();
    await expect.poll(confirmed).toBe(false);
  }
});

// STRICT (customer data): leaving a step saves what was just typed first, and a failed save keeps the owner on the step.
test("an answer typed just before leaving a step is saved first; if saving fails, the owner stays", async ({ page }) => {
  const siteId = await acceptInvite(page);
  const steps = page.getByRole("navigation", { name: "Questionnaire steps" });
  const carriesName = (body: string | null) => (body ?? "").includes("Quick Exit Plumbing");
  // The order of two events decides this test: the server's answer to the save that carries the name, recorded before
  // the page can receive it, and the page changing step. So the order is cause and effect, never a timing guess.
  const order: string[] = [];
  await page.route(`**/api/sites/${siteId}/draft`, async (route) => {
    const response = await route.fetch();
    if (carriesName(route.request().postData())) order.push(`saved ${response.status()}`);
    await route.fulfill({ response });
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame() && new URL(frame.url()).pathname.endsWith("/setup/services")) order.push("left the step");
  });
  await logNameFieldEvents(page);
  const nameSaved = page.waitForResponse(
    (res) => res.request().method() === "PATCH" && res.url().endsWith(`/api/sites/${siteId}/draft`) && carriesName(res.request().postData()),
  );
  await page.getByLabel("Business name").fill("Quick Exit Plumbing");
  // The name reached the page's answers (the counter is drawn from them), so a failure below is about saving, not typing.
  await expect(page.getByText("19 of 60 characters", { exact: true })).toBeVisible();
  await steps.getByRole("link", { name: "2. Your services" }).click();
  expect((await nameSaved).status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Your services" })).toBeFocused();
  // A later save may carry the name too (the sign-in email fills in as well): the first one must come before the step change.
  expect(order).toContain("left the step");
  expect(order.indexOf("saved 200"), JSON.stringify(order)).toBeGreaterThan(-1);
  expect(order.indexOf("saved 200"), JSON.stringify(order)).toBeLessThan(order.indexOf("left the step"));
  const view = await apiCall(page, "GET", `/api/sites/${siteId}`);
  expect((view.json?.["facts"] as { businessName?: string }).businessName).toBe("Quick Exit Plumbing");

  await page.route(`**/api/sites/${siteId}/draft`, (route) =>
    route.fulfill({ status: 500, json: { error: { code: "internal", message: "Something went wrong. Please try again." } } }),
  );
  await page.getByLabel("Service 1", { exact: true }).fill("Drain cleaning");
  await steps.getByRole("link", { name: "3. Where you work and when" }).click();
  await expect(page.getByRole("alert")).toContainText("Your latest answers are not saved yet.");
  await expect(page).toHaveURL(`${APP}/sites/${siteId}/setup/services`);
});

/** Holds every GET /api/me (the sign-in email the business step fills in) until the returned function is called. */
async function holdSignInEmail(page: Page): Promise<() => void> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/me", async (route) => {
    await released;
    await route.continue();
  });
  return release;
}

// STRICT (customer data): the sign-in email fills in when GET /api/me answers. When that answer is slow and lands after
// the owner has typed, it must not wipe the typed business name, take the focus, or save without the name.
const lateEmailCases: ReadonlyArray<{ how: string; typeBefore: (name: Locator) => Promise<void>; before: string; after: string }> = [
  { how: "after fill()", typeBefore: (name) => name.fill("Quick Exit Plumbing"), before: "Quick Exit Plumbing", after: "" },
  { how: "after typing key by key", typeBefore: (name) => name.pressSequentially("Quick Exit Plumbing"), before: "Quick Exit Plumbing", after: "" },
  { how: "in the middle of typing key by key", typeBefore: (name) => name.pressSequentially("Quick Exit "), before: "Quick Exit ", after: "Plumbing" },
];
for (const { how, typeBefore, before, after } of lateEmailCases) {
  test(`the sign-in email arriving ${how} keeps the typed business name and saves it`, async ({ page }) => {
    const owner = uniqueEmail("late-email");
    const release = await holdSignInEmail(page);
    const siteId = await acceptInvite(page, owner);
    const name = page.getByLabel("Business name");
    const email = page.getByLabel("Business email address");
    const counter = (text: string) => page.getByText(`${[...text].length} of 60 characters`, { exact: true });
    await expect(page.getByRole("heading", { level: 1, name: "Your business" })).toBeFocused();

    await typeBefore(name);
    await expect(counter(before)).toBeVisible();
    expect(await email.inputValue(), "the sign-in email must still be held").toBe("");
    const saved = page.waitForResponse(
      (res) => res.request().method() === "PATCH" && res.url().endsWith(`/api/sites/${siteId}/draft`) && (res.request().postData() ?? "").includes("Quick Exit Plumbing") && (res.request().postData() ?? "").includes(owner),
    );
    release();
    await expect(email).toHaveValue(owner);
    // Read once, not polled: the email render has landed, and a name it wiped must not pass by coming back later.
    expect(await name.inputValue()).toBe(before);
    expect(await counter(before).isVisible(), "the page's answers (the counter is drawn from them) still hold the name").toBe(true);
    await expect(name).toBeFocused();
    await page.keyboard.type(after);
    await expect(name).toHaveValue("Quick Exit Plumbing");
    await expect(counter("Quick Exit Plumbing")).toBeVisible();

    const response = await saved;
    expect(response.status()).toBe(200);
    expect(JSON.parse(response.request().postData() ?? "{}")).toMatchObject({ facts: { businessName: "Quick Exit Plumbing", email: owner } });
    const view = await apiCall(page, "GET", `/api/sites/${siteId}`);
    expect(view.json?.["facts"]).toMatchObject({ businessName: "Quick Exit Plumbing", email: owner });
  });
}

test("an opening-time error links to that day's opens field and shows its message there", async ({ page }) => {
  const siteId = await acceptInvite(page);
  await page.goto(`/sites/${siteId}/setup/area`);
  await page.getByLabel("Open on Monday").check();
  await page.getByLabel("Monday opens at").fill("");
  await page.getByRole("button", { name: "Save and continue" }).click();
  const summary = page.getByRole("heading", { name: /things? to fix/ }).locator("..");
  await expect(summary).toBeFocused();
  await summary.getByRole("link", { name: "Please enter a time." }).click();
  await expect(page.getByLabel("Monday opens at")).toBeFocused();
  await expect(page.getByLabel("Monday opens at")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("Monday opens at")).toHaveAccessibleDescription(/Please enter a time\./);
});

test("with a draft already written, the last step says Go to the editor and starts no new writing", async ({ page }) => {
  const siteId = await builtSite(page);
  const generationPosts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith(`/api/sites/${siteId}/generations`)) generationPosts.push(request.url());
  });
  await page.goto(`/sites/${siteId}/setup/address`);
  await expect(page.getByRole("button", { name: "Go to the editor" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Build my website" })).toHaveCount(0);
  await page.getByRole("button", { name: "Go to the editor" }).click();
  await page.waitForURL(`${APP}/sites/${siteId}/edit`);
  expect(generationPosts).toEqual([]);
  const view = await apiCall(page, "GET", `/api/sites/${siteId}`);
  expect(view.json?.["activeGeneration"]).toBeNull();
});

// STRICT (customer data): typing while the web address is being saved must never be lost.
test("typing and Enter are blocked while the web address saves, and typing after it is kept", async ({ page }) => {
  const siteId = await acceptInvite(page);
  await page.goto(`/sites/${siteId}/setup/address`);
  // The server takes the address at once, but its answer is slow: the window in which the saver's rev is stale.
  await page.route(`**/api/sites/${siteId}/slug`, async (route) => {
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fulfill({ response });
  });
  await page.getByLabel("Web address").fill(uniqueSlug("typing"));
  await expect(page.getByText("This address is free. Save it to keep it.")).toBeVisible();
  const comments = page.getByLabel("Anything we should know about this?");
  await comments.fill("Before saving");
  await expect(page.getByRole("status").filter({ hasText: "All changes saved." })).toBeVisible();
  await page.getByRole("button", { name: "Save this web address" }).click();
  // While the save runs the step is busy but keeps keyboard focus: the field is read-only, not disabled.
  await expect(page.locator("form")).toHaveAttribute("aria-busy", "true");
  await comments.focus();
  await expect(comments).toBeFocused();
  await page.keyboard.type(" typed while saving");
  await expect(comments).toBeFocused();
  // Read once, not polled: a typed character that was accepted and then dropped by the reload must not pass.
  expect(await comments.inputValue()).toBe("Before saving");
  // Enter inside a read-only field must not submit the step while the save runs.
  await page.getByLabel("Web address").focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`${APP}/sites/${siteId}/setup/address`);
  await expect(page.locator("form")).not.toHaveAttribute("aria-busy", "true");
  // A submit on this unfilled step would draw the error summary: none may appear.
  await expect(page.getByRole("heading", { name: /things? to fix/ })).toHaveCount(0);
  await comments.focus();
  await page.keyboard.type(" and after");
  await expect(comments).toHaveValue("Before saving and after");
  await expect(page.getByRole("status").filter({ hasText: "All changes saved." })).toBeVisible();
  const view = await apiCall(page, "GET", `/api/sites/${siteId}`);
  expect(view.json?.["slug"]).toMatch(/^typing-/);
  expect(view.json?.["brief"]).toMatchObject({ comments: { address: "Before saving and after" } });
});

test("the web address is not saved while the owner's latest answers are unsaved", async ({ page }) => {
  const siteId = await acceptInvite(page);
  await page.goto(`/sites/${siteId}/setup/address`);
  const puts: string[] = [];
  page.on("request", (req) => req.method() === "PUT" && req.url().endsWith("/slug") && puts.push(req.url()));
  await page.route(`**/api/sites/${siteId}/draft`, (route) =>
    route.request().method() === "PATCH" ? route.fulfill({ status: 500, json: { error: { code: "internal", message: "Something went wrong. Please try again." } } }) : route.continue(),
  );
  await page.getByLabel("Web address").fill(uniqueSlug("unsaved"));
  await expect(page.getByText("This address is free. Save it to keep it.")).toBeVisible();
  await page.getByLabel("Anything we should know about this?").fill("Not saved yet");
  await page.getByRole("button", { name: "Save this web address" }).click();
  await expect(page.getByText("Your latest answers are not saved yet. Please try again in a moment.")).toBeVisible();
  expect(puts).toEqual([]);
  expect((await apiCall(page, "GET", `/api/sites/${siteId}`)).json?.["slug"]).toBeNull();
  // The owner can act on it: once the answers save (SaveStatus "Try again"), the message goes and Save stores the address.
  await page.unroute(`**/api/sites/${siteId}/draft`);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("status").filter({ hasText: "All changes saved." })).toBeVisible();
  await expect(page.getByText("Your latest answers are not saved yet.")).toHaveCount(0);
  await page.getByRole("button", { name: "Save this web address" }).click();
  await expect.poll(async () => (await apiCall(page, "GET", `/api/sites/${siteId}`)).json?.["slug"]).toMatch(/^unsaved-/);
  expect((await apiCall(page, "GET", `/api/sites/${siteId}`)).json?.["brief"]).toMatchObject({ comments: { address: "Not saved yet" } });
});

test("after a failed first build, opening the build page again goes to the last step, not the first", async ({ page }) => {
  const siteId = await acceptInvite(page);
  await apiCall(page, "PATCH", `/api/sites/${siteId}/draft`, { rev: 1, facts: FACTS, brief: BRIEF });
  await apiCall(page, "PUT", `/api/sites/${siteId}/slug`, { rev: 2, slug: uniqueSlug("failed") });
  const started = await apiCall(page, "POST", `/api/sites/${siteId}/generations`, {});
  await finishGeneration(page.request, (started.json?.["generation"] as { id: string }).id, "failed");
  await page.goto(`/sites/${siteId}/build`);
  await page.waitForURL(`${APP}/sites/${siteId}/setup/address`);
  await expect(page.getByRole("heading", { level: 1, name: "Your web address" })).toBeFocused();
});

test("a service name of 40 characters with an emoji counts 40, not 41", async ({ page }) => {
  const siteId = await acceptInvite(page);
  await page.goto(`/sites/${siteId}/setup/services`);
  await page.getByLabel("Service 1", { exact: true }).fill(`${"a".repeat(39)}😀`);
  await expect(page.getByText("40 of 40 characters")).toBeVisible();
});

test("the move service buttons hand keyboard focus to the opposite button at either end", async ({ page }) => {
  const siteId = await builtSite(page);
  await page.goto(`/sites/${siteId}/setup/services`);
  await page.getByRole("button", { name: "Move service 1 down" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Service 2", { exact: true })).toHaveValue("Drain cleaning");
  await expect(page.getByRole("button", { name: "Move service 2 up" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Service 1", { exact: true })).toHaveValue("Drain cleaning");
  await expect(page.getByRole("button", { name: "Move service 1 down" })).toBeFocused();
});
