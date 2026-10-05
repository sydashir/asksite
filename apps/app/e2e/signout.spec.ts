import { expect, test, type Browser, type Page } from "@playwright/test";
import { acceptInvite, apiCall, APP, askNewWording, BRIEF, builtSite, FACTS, finishGeneration, stubTurnstile, uniqueEmail, uniqueSlug, waitForSecurityCheck } from "./support.ts";

const NOT_SAVED = "Your latest changes are not saved yet. Please try again in a moment.";
const CONFLICT = "This site changed in another tab or window. Reload to see the latest version.";
const PRESS_AGAIN = "Press Sign out again to sign out without saving.";
const FAIL_500 = { status: 500, json: { error: { code: "internal", message: "Something went wrong. Please try again." } } };

/** Every request and answer for the draft and the logout, in the order the browser saw them. */
function watchSaves(page: Page) {
  const events: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "PATCH" && r.url().includes("/draft")) events.push("patch-sent");
    if (r.method() === "POST" && r.url().endsWith("/api/auth/logout")) events.push("logout-sent");
  });
  page.on("response", (r) => {
    if (r.request().method() === "PATCH" && r.url().includes("/draft")) events.push(`patch-answered-${r.status()}`);
  });
  return events;
}

// STRICT (customer data): "Sign out" saves what the owner just typed BEFORE it ends the session, and never after (the session is gone then).
test("Sign out saves an edit still inside the autosave delay, and the save finishes before the logout is sent", async ({ page }) => {
  const siteId = await builtSite(page);
  await page.goto(`/sites/${siteId}/edit`);
  const events = watchSaves(page);
  await page.getByLabel("Headline", { exact: true }).fill("Plumbers who answer the phone");
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL((url) => url.pathname === "/" && !url.pathname.includes("/sites/"));
  await expect.poll(() => events).toContain("logout-sent");
  expect(events).toEqual(["patch-sent", "patch-answered-200", "logout-sent"]);
});

test("Sign out stays and says so while the changes are not saved", async ({ page }) => {
  const siteId = await builtSite(page);
  await page.goto(`/sites/${siteId}/edit`);
  await page.route(`**/api/sites/${siteId}/draft`, (route) => (route.request().method() === "PATCH" ? route.fulfill({ status: 500, json: { error: { code: "internal", message: "Something went wrong. Please try again." } } }) : route.fallback()));
  const events = watchSaves(page);
  await page.getByLabel("Headline", { exact: true }).fill("Plumbers who answer the phone");
  await expect(page.getByText("Your changes are not saved yet", { exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByText("Your latest changes are not saved yet. Please try again in a moment.")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(`/sites/${siteId}/edit`);
  await expect(page.getByLabel("Headline", { exact: true })).toHaveValue("Plumbers who answer the phone");
  expect(events).not.toContain("logout-sent");
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
});

/** What the app sees on the browser's Back: a popstate to Home, so no link and no guard runs. (Playwright's goBack stalls while a save is in flight.) */
async function browserBack(page: Page) {
  await page.evaluate(() => {
    history.replaceState(null, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}

/** A signed-in owner (known email, so a second session can be started) whose first draft is written. */
async function builtSiteAs(page: Page, email: string): Promise<string> {
  const siteId = await acceptInvite(page, email);
  expect((await apiCall(page, "PATCH", `/api/sites/${siteId}/draft`, { rev: 1, facts: FACTS, brief: BRIEF })).status).toBe(200);
  expect((await apiCall(page, "PUT", `/api/sites/${siteId}/slug`, { rev: 2, slug: uniqueSlug("joes") })).status).toBe(200);
  const started = await apiCall(page, "POST", `/api/sites/${siteId}/generations`, {});
  await finishGeneration(page.request, (started.json?.["generation"] as { id: string }).id);
  return siteId;
}

/** The headline the server stores, read from a fresh session of the same owner (the emailed sign-in link). */
async function storedHeadline(browser: Browser, email: string, siteId: string): Promise<string | undefined> {
  const ctx = await browser.newContext({ baseURL: APP, ignoreHTTPSErrors: true });
  try {
    const page = await ctx.newPage();
    await stubTurnstile(page);
    await page.goto("/");
    await waitForSecurityCheck(page);
    await page.getByLabel("Your email address").fill(email);
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    let text = "";
    await expect
      .poll(async () => {
        const res = await page.request.get(`${APP}/api/dev/outbox?to=${encodeURIComponent(email)}`);
        text = ((await res.json()) as { messages: Array<{ text: string }> }).messages.at(-1)?.text ?? "";
        return text;
      })
      .toContain(`${APP}/login#`);
    await page.goto(/https:\/\/app\.localhost:8787\/login#[A-Za-z0-9_-]{43}/.exec(text)![0]);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Your websites" })).toBeVisible();
    const view = (await apiCall(page, "GET", `/api/sites/${siteId}`)).json!;
    return (view["edits"] as { copy: { heroHeadline?: string } }).copy.heroHeadline;
  } finally {
    await ctx.close();
  }
}

// STRICT (customer data): the editor saves what is unsaved when it closes by any route (here the browser's Back), and the page it
// leaves to (Home) holds no draft, so no guard waits for that save. "Sign out" must wait for it too, or the logout wins the race.
test("Sign out waits for the save the editor started as it closed (Back, then Sign out); a fresh sign-in sees the edit", async ({ page, browser }) => {
  const email = uniqueEmail("leaving");
  const siteId = await builtSiteAs(page, email);
  await page.goto("/");
  await page.getByRole("link", { name: "Open" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Edit your website" })).toBeFocused();
  const events = watchSaves(page);
  // The save is held until the test lets it go, which is after Sign out was pressed: the press happens while the save is in flight.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**/api/sites/${siteId}/draft`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    await held;
    await route.continue();
  });
  await page.getByLabel("Headline", { exact: true }).fill("Typed just before Back");
  await browserBack(page);
  await expect(page.getByRole("heading", { level: 1, name: "Your websites" })).toBeVisible();
  await expect.poll(() => events).toContain("patch-sent");
  await page.getByRole("button", { name: "Sign out" }).click();
  expect(events).toEqual(["patch-sent"]);
  release();
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  expect(events).toEqual(["patch-sent", "patch-answered-200", "logout-sent"]);
  expect(await storedHeadline(browser, email, siteId)).toBe("Typed just before Back");
});

test("Sign out stays and says so when the save the editor started as it closed failed (R2); the next press signs out", async ({ page, browser }) => {
  const email = uniqueEmail("leavingfail");
  const siteId = await builtSiteAs(page, email);
  await page.goto("/");
  await page.getByRole("link", { name: "Open" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Edit your website" })).toBeFocused();
  await page.route(`**/api/sites/${siteId}/draft`, (route) => (route.request().method() === "PATCH" ? route.fulfill(FAIL_500) : route.fallback()));
  const events = watchSaves(page);
  await page.getByLabel("Headline", { exact: true }).fill("Never saved");
  await browserBack(page);
  await expect(page.getByRole("heading", { level: 1, name: "Your websites" })).toBeVisible();
  await expect.poll(() => events).toContain("patch-answered-500");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("alert").filter({ hasText: NOT_SAVED })).toContainText(PRESS_AGAIN);
  expect(events).not.toContain("logout-sent");
  expect(new URL(page.url()).pathname).toBe("/");
  // The owner was told once: the server keeps failing, and the second press signs out anyway.
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  expect(events.at(-1)).toBe("logout-sent");
  expect(await storedHeadline(browser, email, siteId)).toBeUndefined();
});

test("Sign out retries a failed closing save, and the next press after the save worked saves it, then signs out", async ({ page, browser }) => {
  const email = uniqueEmail("leavingretry");
  const siteId = await builtSiteAs(page, email);
  await page.goto("/");
  await page.getByRole("link", { name: "Open" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Edit your website" })).toBeFocused();
  let failing = true;
  await page.route(`**/api/sites/${siteId}/draft`, (route) => (route.request().method() === "PATCH" && failing ? route.fulfill(FAIL_500) : route.fallback()));
  const events = watchSaves(page);
  await page.getByLabel("Headline", { exact: true }).fill("Kept after a failed save");
  await browserBack(page);
  await expect(page.getByRole("heading", { level: 1, name: "Your websites" })).toBeVisible();
  await expect.poll(() => events).toContain("patch-answered-500");
  failing = false;
  // The first press tries the failed save again; it works, so nothing stops it.
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  expect(events.at(-1)).toBe("logout-sent");
  expect(events).toContain("patch-answered-200");
  expect(await storedHeadline(browser, email, siteId)).toBe("Kept after a failed save");
});

// R1 (conflict): the editor's saver is in conflict (another writer saved first) and the owner leaves by the header link, which still
// leaves on an ordinary failure. A conflict can never be saved, so nothing retried can help: Sign out says so once, then goes on.
test("Sign out after leaving a conflicted editor stops once with the conflict text, then the next press signs out", async ({ page }) => {
  const siteId = await builtSiteAs(page, uniqueEmail("trapc"));
  await page.goto("/");
  await page.getByRole("link", { name: "Open" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Edit your website" })).toBeFocused();
  const rev = (await apiCall(page, "GET", `/api/sites/${siteId}`)).json!["rev"] as number;
  expect((await apiCall(page, "PATCH", `/api/sites/${siteId}/draft`, { rev, brief: BRIEF })).status).toBe(200);
  const events = watchSaves(page);
  await page.getByLabel("Headline", { exact: true }).fill("Typed in a stale tab");
  await expect(page.getByRole("status").filter({ hasText: CONFLICT })).toBeVisible();
  await page.getByRole("link", { name: "Your website" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Your websites" })).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("alert").filter({ hasText: CONFLICT })).toContainText(PRESS_AGAIN);
  expect(events).not.toContain("logout-sent");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  expect(events.at(-1)).toBe("logout-sent");
});

// R5: the page on screen holds a save that keeps failing.
test("Sign out on the editor with a save that keeps failing stops once, says what to do, then the next press signs out", async ({ page }) => {
  const siteId = await builtSite(page);
  await page.goto(`/sites/${siteId}/edit`);
  await page.route(`**/api/sites/${siteId}/draft`, (route) => (route.request().method() === "PATCH" ? route.fulfill(FAIL_500) : route.fallback()));
  const events = watchSaves(page);
  await page.getByLabel("Headline", { exact: true }).fill("On screen, never saved");
  await expect(page.getByText("Your changes are not saved yet", { exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  // The whole text, word for word: the existing not-saved text, then the one new sentence.
  await expect(page.getByRole("alert").filter({ hasText: NOT_SAVED })).toHaveText(`${NOT_SAVED} ${PRESS_AGAIN}`);
  expect(events).not.toContain("logout-sent");
  expect(new URL(page.url()).pathname).toBe(`/sites/${siteId}/edit`);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  expect(events.at(-1)).toBe("logout-sent");
});

// A save that never answers must not trap the owner: a press while an earlier one is still waiting signs out.
test("Sign out while the first press still waits on a save that never answers signs out", async ({ page }) => {
  const siteId = await builtSite(page);
  await page.goto(`/sites/${siteId}/edit`);
  let release!: () => void;
  const never = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**/api/sites/${siteId}/draft`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    await never;
    await route.abort();
  });
  const events = watchSaves(page);
  try {
    await page.getByLabel("Headline", { exact: true }).fill("Held for ever");
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect.poll(() => events).toContain("patch-sent");
    expect(events).not.toContain("logout-sent");
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
    expect(events).toContain("logout-sent");
  } finally {
    release();
  }
});

const WORDING_DROPPED = "New wording arrived, so your last wording change wasn't applied. Make it again on the new wording if you still want it.";

/** The owner's draft is on the old wording (roofing facts), then another tab of the same owner writes new wording and it lands. */
async function rewriteElsewhere(page: Page, browser: Browser, siteId: string) {
  const other = await browser.newContext({ baseURL: APP, ignoreHTTPSErrors: true, storageState: await page.context().storageState() });
  try {
    const tabB = await other.newPage();
    await tabB.goto(`/sites/${siteId}/edit`);
    await expect(tabB.getByRole("heading", { level: 1, name: "Edit your website" })).toBeFocused();
    await finishGeneration(tabB.request, await askNewWording(tabB, siteId));
    await expect(tabB.getByText("New wording is ready.")).toBeVisible({ timeout: 15_000 });
  } finally {
    await other.close();
  }
}

/** The editor holds a wording change the server refused (new wording arrived elsewhere): its notice is up, and nobody was stopped for it yet. */
async function editorWithDroppedWording(page: Page, browser: Browser) {
  const siteId = await builtSiteAs(page, uniqueEmail("dropped"));
  const rev = (await apiCall(page, "GET", `/api/sites/${siteId}`)).json!["rev"] as number;
  expect((await apiCall(page, "PATCH", `/api/sites/${siteId}/draft`, { rev, facts: { ...FACTS, trade: "roofing" } })).status).toBe(200);
  await page.goto(`/sites/${siteId}/edit`);
  const headline = page.getByLabel("Headline", { exact: true });
  await expect(headline).toHaveValue("Plumbing done right");
  await rewriteElsewhere(page, browser, siteId);
  await headline.fill("Mine");
  const notice = page.getByRole("status").filter({ hasText: WORDING_DROPPED });
  await expect(notice).toBeVisible();
  return { siteId, notice };
}

// R3: the save the editor sends as it closes is the one that finds the drop, so no screen is left to say it: Sign out says it, once.
test("Sign out stops once on a wording change dropped by the save the editor started as it closed, then the next press signs out", async ({ page, browser }) => {
  const siteId = await builtSiteAs(page, uniqueEmail("dropleave"));
  const rev = (await apiCall(page, "GET", `/api/sites/${siteId}`)).json!["rev"] as number;
  expect((await apiCall(page, "PATCH", `/api/sites/${siteId}/draft`, { rev, facts: { ...FACTS, trade: "roofing" } })).status).toBe(200);
  await page.goto("/");
  await page.getByRole("link", { name: "Open" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Edit your website" })).toBeFocused();
  const headline = page.getByLabel("Headline", { exact: true });
  await expect(headline).toHaveValue("Plumbing done right");
  await rewriteElsewhere(page, browser, siteId);
  const events = watchSaves(page);
  await headline.fill("Mine, typed just before Back");
  await browserBack(page);
  await expect(page.getByRole("heading", { level: 1, name: "Your websites" })).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("alert").filter({ hasText: WORDING_DROPPED })).toContainText(PRESS_AGAIN);
  expect(events).not.toContain("logout-sent");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  expect(events.at(-1)).toBe("logout-sent");
});

test("Sign out stops once on a dropped wording change, says so, and the next press signs out", async ({ page, browser }) => {
  const { notice } = await editorWithDroppedWording(page, browser);
  const events = watchSaves(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(notice).toBeFocused();
  expect(events).not.toContain("logout-sent");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  expect(events).toContain("logout-sent");
});

// The Questionnaire holds the owner's answers: the same Sign out rule as the editor.
test("Questionnaire: Sign out stays and says so once while the answers are not saved, then the next press signs out", async ({ page }) => {
  await acceptInvite(page, uniqueEmail("setup"));
  await page.route("**/api/sites/*/draft", (route) => (route.request().method() === "PATCH" ? route.fulfill(FAIL_500) : route.fallback()));
  const events = watchSaves(page);
  await page.getByLabel("Business name").fill("Probe Plumbing");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Your latest answers are not saved yet. Please try again in a moment." })).toContainText(PRESS_AGAIN);
  expect(events).not.toContain("logout-sent");
  expect(new URL(page.url()).pathname).toMatch(/\/setup\/business$/);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  expect(events.at(-1)).toBe("logout-sent");
});

test("Questionnaire: Sign out saves the answers first, and the save finishes before the logout", async ({ page }) => {
  await acceptInvite(page, uniqueEmail("setupok"));
  const events = watchSaves(page);
  await page.getByLabel("Business name").fill("Probe Plumbing");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  expect(events.at(-1)).toBe("logout-sent");
  expect(events.at(-2)).toBe("patch-answered-200");
});

// Publish holds no field of its own, but a dropped wording change carried out of the editor is its to report: Sign out stops once there too.
test("Publish: Sign out stops once on a dropped wording change carried from the editor, and the next press signs out", async ({ page, browser }) => {
  const { siteId } = await editorWithDroppedWording(page, browser);
  await page.evaluate((to) => {
    history.pushState(null, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, `/sites/${siteId}/publish`);
  await expect(page.getByRole("heading", { level: 1, name: "Publish your website" })).toBeVisible();
  const notice = page.getByRole("status").filter({ hasText: WORDING_DROPPED });
  await expect(notice).toBeVisible();
  const events = watchSaves(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(notice).toBeFocused();
  expect(events).not.toContain("logout-sent");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
});
