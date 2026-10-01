import { expect, test } from "@playwright/test";
import { acceptInvite, apiCall, APP, BRIEF, builtSite, expectAccessible, expectNoSidewaysScroll, FACTS, finishGeneration, uniqueEmail, uniqueSlug } from "./support.ts";

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

test("answers are saved automatically and survive a reload", async ({ page }) => {
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
  const other = await context.newPage();
  await other.goto(`/sites/${siteId}/setup/business`);
  await page.getByLabel("City").fill("Austin");
  await expect(page.getByRole("status").filter({ hasText: "All changes saved." })).toBeVisible();
  await other.getByLabel("City").fill("Dallas");
  await expect(other.getByText("This site changed in another tab or window. Reload to see the latest version.")).toBeVisible();
  await other.getByRole("button", { name: "Reload" }).click();
  await expect(other.getByLabel("City")).toHaveValue("Austin");
});

test("a problem in a step's own comment box is listed on that step, and its link focuses the box", async ({ page }) => {
  const siteId = await acceptInvite(page);
  await apiCall(page, "PATCH", `/api/sites/${siteId}/draft`, { rev: 1, facts: FACTS, brief: BRIEF });
  await apiCall(page, "PUT", `/api/sites/${siteId}/slug`, { rev: 2, slug: uniqueSlug("comment") });
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

test("an answer typed just before leaving a step is saved first; if saving fails, the owner stays", async ({ page }) => {
  const siteId = await acceptInvite(page);
  const steps = page.getByRole("navigation", { name: "Questionnaire steps" });
  await page.getByLabel("Business name").fill("Quick Exit Plumbing");
  await steps.getByRole("link", { name: "2. Your services" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Your services" })).toBeFocused();
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
test("typing while the web address saves is kept, not dropped by a stale save", async ({ page }) => {
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
  await page.getByRole("button", { name: "Save this web address" }).click();
  await page.getByLabel("Anything we should know about this?").fill("Typed while saving");
  await expect(page.getByRole("status").filter({ hasText: "All changes saved." })).toBeVisible();
  await expect(page.getByLabel("Anything we should know about this?")).toHaveValue("Typed while saving");
  const view = await apiCall(page, "GET", `/api/sites/${siteId}`);
  expect(view.json?.["slug"]).toMatch(/^typing-/);
  expect(view.json?.["brief"]).toMatchObject({ comments: { address: "Typed while saving" } });
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
