import { expect, test, type Browser, type Page } from "@playwright/test";
import { acceptInvite, apiCall, APP, askNewWording, BRIEF, builtSite, FACTS, finishGeneration, seedDraft, stubTurnstile, uniqueEmail, waitForSecurityCheck } from "./support.ts";

const NOT_SAVED = "Your latest changes are not saved yet. Please try again in a moment.";
const CONFLICT = "This site changed in another tab or window. Reload to see the latest version.";
const PRESS_AGAIN = "Press Sign out again to sign out without saving.";
// The editor's own status text for a save in flight, and the grace (use-route.ts SIGN_OUT_GRACE_MS) a first press waits alone.
const SAVING = "Saving…";
const GRACE_MS = 1_500;
const FAIL_500 = { status: 500, json: { error: { code: "internal", message: "Something went wrong. Please try again." } } };

/** A press after a stop: it waits out the grace (a press inside it is a double click and is ignored), a bounded wait on purpose as nothing observable marks its end. */
async function pressAfterGrace(page: Page) {
  await page.waitForTimeout(GRACE_MS + 100);
  await page.getByRole("button", { name: "Sign out" }).click();
}

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
  await seedDraft(page, siteId, "joes");
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
  await pressAfterGrace(page);
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

/** Starts logging the text of every alert node added to the page from now on (a node added and removed inside one task is still seen). */
async function watchAlertsAdded(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { alertsAdded: string[] };
    w.alertsAdded = [];
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element && (node.matches("[role=alert]") || node.querySelector("[role=alert]") !== null)) w.alertsAdded.push(node.textContent ?? "");
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
}

const alertsAdded = (page: Page) => page.evaluate(() => (window as unknown as { alertsAdded: string[] }).alertsAdded);

/** An editor in conflict (another writer saved first), left by the header link to Home with the owner's text unsaved. Returns the save events. */
async function leaveConflictedEditor(page: Page): Promise<string[]> {
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
  return events;
}

// R1 (conflict): the editor's saver is in conflict (another writer saved first) and the owner leaves by the header link, which still
// leaves on an ordinary failure. A conflict can never be saved, so nothing retried can help: Sign out says so once, then goes on.
test("Sign out after leaving a conflicted editor stops once with the conflict text, then the next press signs out", async ({ page }) => {
  const events = await leaveConflictedEditor(page);
  await watchAlertsAdded(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("alert").filter({ hasText: CONFLICT })).toContainText(PRESS_AGAIN);
  // A conflict sends nothing, so nothing is pending: "Saving…" is never put on the page, not even for one task.
  expect((await alertsAdded(page)).filter((text) => text.includes(SAVING))).toEqual([]);
  expect(events).not.toContain("logout-sent");
  await pressAfterGrace(page);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  expect(events.at(-1)).toBe("logout-sent");
});

// A new page is on screen: its first stop is its own to say, so the stop of the page before does not let this press sign out unasked.
test("Sign out stops again on a new page: a route change resets the stop", async ({ page }) => {
  const events = await leaveConflictedEditor(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("alert").filter({ hasText: CONFLICT })).toContainText(PRESS_AGAIN);
  await page.getByRole("link", { name: "Your website" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("alert").filter({ hasText: CONFLICT })).toContainText(PRESS_AGAIN);
  expect(events).not.toContain("logout-sent");
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
  await pressAfterGrace(page);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  expect(events.at(-1)).toBe("logout-sent");
});

// A save that never answers must not trap the owner: a press after the grace signs out, and the first press said "Saving…" meanwhile.
test("Sign out on a save that never answers says Saving…, and a press after the grace signs out", async ({ page }) => {
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
    await expect(page.getByRole("alert")).toHaveText(`${SAVING} ${PRESS_AGAIN}`);
    await expect.poll(() => events).toContain("patch-sent");
    expect(events).not.toContain("logout-sent");
    // Nothing observable marks the end of the grace, so this waits just past it (a bounded wait on purpose).
    await page.waitForTimeout(GRACE_MS + 300);
    expect(events).not.toContain("logout-sent");
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
    expect(events).toContain("logout-sent");
  } finally {
    release();
  }
});

// R4: a double click while the save is slow is ONE press: the save answers before the logout, and a fresh sign-in reads the edit.
test("A double click on Sign out during a slow save waits for the save, then signs out; a fresh sign-in sees the edit", async ({ page, browser }) => {
  const email = uniqueEmail("dbl");
  const siteId = await builtSiteAs(page, email);
  await page.goto("/");
  await page.getByRole("link", { name: "Open" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Edit your website" })).toBeFocused();
  // The save is held until after the double click; it answers inside the grace, as a slow ordinary save would.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**/api/sites/${siteId}/draft`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    await held;
    await route.continue();
  });
  const events = watchSaves(page);
  await page.getByLabel("Headline", { exact: true }).fill("Double click");
  await browserBack(page);
  await expect(page.getByRole("heading", { level: 1, name: "Your websites" })).toBeVisible();
  await expect.poll(() => events).toContain("patch-sent");
  await page.getByRole("button", { name: "Sign out" }).dblclick();
  await expect(page.getByRole("alert")).toHaveText(`${SAVING} ${PRESS_AGAIN}`);
  expect(events).toEqual(["patch-sent"]);
  release();
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  expect(events).toEqual(["patch-sent", "patch-answered-200", "logout-sent"]);
  expect(await storedHeadline(browser, email, siteId)).toBe("Double click");
});

// A double click is ONE press even when the first press stops at once (nothing to wait for): the owner must get to read the stop.
test("A double click on Sign out with a conflict on screen stops once and stays", async ({ page }) => {
  const siteId = await builtSiteAs(page, uniqueEmail("dblstop"));
  await page.goto(`/sites/${siteId}/edit`);
  await expect(page.getByRole("heading", { level: 1, name: "Edit your website" })).toBeFocused();
  const rev = (await apiCall(page, "GET", `/api/sites/${siteId}`)).json!["rev"] as number;
  expect((await apiCall(page, "PATCH", `/api/sites/${siteId}/draft`, { rev, brief: BRIEF })).status).toBe(200);
  const events = watchSaves(page);
  await page.getByLabel("Headline", { exact: true }).fill("Typed in a stale tab");
  await expect(page.getByRole("status").filter({ hasText: CONFLICT })).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).dblclick();
  await expect(page.getByRole("alert").filter({ hasText: CONFLICT })).toContainText(PRESS_AGAIN);
  // Nothing observable marks a logout that does not happen, so this waits a bounded while (well inside the grace) and checks it stayed.
  await page.waitForTimeout(500);
  expect(events).not.toContain("logout-sent");
  await expect(page.getByLabel("Headline", { exact: true })).toHaveValue("Typed in a stale tab");
});

test("Two presses on Sign out 250 ms apart while the save fails fast stop once and stay", async ({ page }) => {
  const siteId = await builtSite(page);
  await page.goto(`/sites/${siteId}/edit`);
  await page.route(`**/api/sites/${siteId}/draft`, (route) => (route.request().method() === "PATCH" ? route.fulfill(FAIL_500) : route.fallback()));
  const events = watchSaves(page);
  await page.getByLabel("Headline", { exact: true }).fill("Typed, then a slow double click");
  const button = page.getByRole("button", { name: "Sign out" });
  await button.click();
  await page.waitForTimeout(250);
  await button.click();
  await expect(page.getByRole("alert").filter({ hasText: NOT_SAVED })).toContainText(PRESS_AGAIN);
  await page.waitForTimeout(500);
  expect(events).not.toContain("logout-sent");
  await expect(page.getByLabel("Headline", { exact: true })).toHaveValue("Typed, then a slow double click");
});

// A stop is about its cause: once everything is saved the alert goes (it would be untrue), and the next press saves a fresh edit first.
test("A Sign out stop expires once the changes are saved: no alert is left, and a fresh edit is saved before the logout", async ({ page, browser }) => {
  const email = uniqueEmail("expire");
  const siteId = await builtSiteAs(page, email);
  await page.goto(`/sites/${siteId}/edit`);
  await expect(page.getByRole("heading", { level: 1, name: "Edit your website" })).toBeFocused();
  let failing = true;
  await page.route(`**/api/sites/${siteId}/draft`, (route) => (route.request().method() === "PATCH" && failing ? route.fulfill(FAIL_500) : route.fallback()));
  const events = watchSaves(page);
  const headline = page.getByLabel("Headline", { exact: true });
  await headline.fill("First try");
  await expect(page.getByText("Your changes are not saved yet", { exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("alert").filter({ hasText: NOT_SAVED })).toContainText(PRESS_AGAIN);
  failing = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("status").filter({ hasText: "All changes saved." })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await headline.fill("Final words");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  expect(events.slice(-3)).toEqual(["patch-sent", "patch-answered-200", "logout-sent"]);
  expect(await storedHeadline(browser, email, siteId)).toBe("Final words");
});

// A stop is about its cause, and a NEW edit that is still pending or saving is not the cause resolved: the alert stays until a save lands.
test("A Sign out stop never expires while a new edit is pending or saving; after it expires, a new failed save stops again", async ({ page }) => {
  const siteId = await builtSite(page);
  await page.goto(`/sites/${siteId}/edit`);
  let failing = true;
  await page.route(`**/api/sites/${siteId}/draft`, (route) => (route.request().method() === "PATCH" && failing ? route.fulfill(FAIL_500) : route.fallback()));
  const events = watchSaves(page);
  const headline = page.getByLabel("Headline", { exact: true });
  const stop = page.getByRole("alert").filter({ hasText: NOT_SAVED });
  await headline.fill("First try");
  await expect(page.getByText("Your changes are not saved yet", { exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(stop).toContainText(PRESS_AGAIN);
  const failed = () => events.filter((e) => e === "patch-answered-500").length;
  const failsBefore = failed();
  await headline.fill("Second, still failing");
  await expect(page.getByRole("alert")).toHaveCount(1);
  await expect.poll(failed).toBe(failsBefore + 1);
  await expect(stop).toHaveCount(1);
  failing = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("status").filter({ hasText: "All changes saved." })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  failing = true;
  await headline.fill("Third, failing");
  await expect(page.getByText("Your changes are not saved yet", { exact: false }).first()).toBeVisible();
  const sentBefore = events.filter((e) => e === "patch-sent").length;
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(stop).toContainText(PRESS_AGAIN);
  expect(events.filter((e) => e === "patch-sent").length).toBeGreaterThan(sentBefore);
  expect(events).not.toContain("logout-sent");
});

// "Saving…" is said only for a save that is really pending: with nothing to save no alert is ever added to the page, and the logout goes out at once.
test("Sign out with nothing to save adds no alert and signs out at once", async ({ page }) => {
  await builtSite(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Your websites" })).toBeVisible();
  const added: string[] = [];
  page.on("console", (message) => {
    if (message.text().startsWith("ALERT-ADDED ")) added.push(message.text());
  });
  // Logged by console so it survives the reload; a MutationObserver sees a node added and removed inside one task, which no frame would show.
  await page.evaluate(() => {
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element && (node.matches("[role=alert]") || node.querySelector("[role=alert]") !== null)) console.log(`ALERT-ADDED ${node.textContent}`);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  const events = watchSaves(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  expect(events).toContain("logout-sent");
  expect(added).toEqual([]);
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
async function editorWithDroppedWording(page: Page, browser: Browser, email = uniqueEmail("dropped")) {
  const siteId = await builtSiteAs(page, email);
  const rev = (await apiCall(page, "GET", `/api/sites/${siteId}`)).json!["rev"] as number;
  expect((await apiCall(page, "PATCH", `/api/sites/${siteId}/draft`, { rev, facts: { ...FACTS, trade: "roofing" } })).status).toBe(200);
  await page.goto(`/sites/${siteId}/edit`);
  const headline = page.getByLabel("Headline", { exact: true });
  await expect(headline).toHaveValue("Plumbing done right");
  await rewriteElsewhere(page, browser, siteId);
  await headline.fill("Mine");
  const notice = page.getByRole("status").filter({ hasText: WORDING_DROPPED });
  await expect(notice).toBeVisible();
  return { siteId, notice, headline };
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
  await pressAfterGrace(page);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  expect(events.at(-1)).toBe("logout-sent");
});

test("Sign out stops once on a dropped wording change, says so, and the next press signs out", async ({ page, browser }) => {
  const { notice } = await editorWithDroppedWording(page, browser);
  const events = watchSaves(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(notice).toBeFocused();
  expect(events).not.toContain("logout-sent");
  await pressAfterGrace(page);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  expect(events).toContain("logout-sent");
});

// IMP-1: the notice of a dropped change stays up until Dismiss, but the STOP is about the unsaved change. Once a later save has landed, the
// next press runs the full guard again, so an edit typed just before it is saved first.
test("A Sign out stop on a dropped wording change expires once a later save lands: a fresh edit is saved before the logout", async ({ page, browser }) => {
  const email = uniqueEmail("dropexpire");
  const { siteId, notice, headline } = await editorWithDroppedWording(page, browser, email);
  const events = watchSaves(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(notice).toBeFocused();
  await expect(page.getByRole("alert").filter({ hasText: WORDING_DROPPED })).toContainText(PRESS_AGAIN);
  await page.waitForTimeout(GRACE_MS + 100);
  await headline.fill("Later, saved");
  await expect.poll(() => events.filter((e) => e === "patch-answered-200").length).toBe(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await headline.fill("Final words");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  expect(events).toEqual(["patch-sent", "patch-answered-200", "patch-sent", "patch-answered-200", "logout-sent"]);
  expect(await storedHeadline(browser, email, siteId)).toBe("Final words");
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
  await pressAfterGrace(page);
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
  await pressAfterGrace(page);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
});

/** Draft saves and the logout tagged with the site they belong to (an owner with several sites): "X:patch-sent", "Y:patch-answered-500", "logout-sent". */
function watchSavesBySite(page: Page, sites: Record<string, string>) {
  const events: string[] = [];
  const tag = (url: string) => Object.entries(sites).find(([, id]) => url.includes(id))?.[0] ?? "";
  page.on("request", (r) => {
    if (r.method() === "PATCH" && r.url().includes("/draft")) events.push(`${tag(r.url())}:patch-sent`);
    if (r.method() === "POST" && r.url().endsWith("/api/auth/logout")) events.push("logout-sent");
  });
  page.on("response", (r) => {
    if (r.request().method() === "PATCH" && r.url().includes("/draft")) events.push(`${tag(r.url())}:patch-answered-${r.status()}`);
  });
  return events;
}

/** Waits until React has rendered and run the effects of the state the page is in now. */
const settleRender = (page: Page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 500)))));

/** Leaves an editor whose save fails by the header link, so the save it started as it closed fails too and stays unsaved. */
async function leaveFailingEditor(page: Page, siteId: string, typed: string) {
  await page.locator(`a[href="/sites/${siteId}/edit"]`).click();
  await expect(page.getByRole("heading", { level: 1, name: "Edit your website" })).toBeFocused();
  await page.route(`**/api/sites/${siteId}/draft`, (route) => (route.request().method() === "PATCH" ? route.fulfill(FAIL_500) : route.fallback()));
  await page.getByLabel("Headline", { exact: true }).fill(typed);
  await expect(page.getByText("Your changes are not saved yet", { exact: false }).first()).toBeVisible();
  await page.getByRole("link", { name: "Your website" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Your websites" })).toBeVisible();
}

// PX: a failed closing save on site Y stops Sign out on site X's editor. The press always saves the page on screen first, so a fresh edit on X
// is saved before the logout, however often Y's failure was told.
test("PX: a stop caused by another site's failed closing save never lets a fresh edit on this site be skipped", async ({ page, browser }) => {
  const email = uniqueEmail("px");
  const siteY = await builtSiteAs(page, email);
  const siteX = await builtSiteAs(page, email);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Your websites" })).toBeVisible();
  const events = watchSavesBySite(page, { X: siteX, Y: siteY });
  await leaveFailingEditor(page, siteY, "Y, never saved");
  await page.locator(`a[href="/sites/${siteX}/edit"]`).click();
  await expect(page.getByRole("heading", { level: 1, name: "Edit your website" })).toBeFocused();
  const headline = page.getByLabel("Headline", { exact: true });
  await expect(headline).toHaveValue("Plumbing done right");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("alert").filter({ hasText: NOT_SAVED })).toContainText(PRESS_AGAIN);
  await page.waitForTimeout(GRACE_MS + 100);
  await headline.fill("X, later saved");
  await expect.poll(() => events.filter((e) => e === "X:patch-answered-200").length).toBe(1);
  await settleRender(page);
  await headline.fill("X, final words");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  // The press saved the fresh edit (a second save on X) before the logout.
  expect(events.filter((e) => e === "X:patch-answered-200")).toHaveLength(2);
  expect(events.at(-1)).toBe("logout-sent");
  expect(await storedHeadline(browser, email, siteX)).toBe("X, final words");
});

// A cause is identified by its site as well as its kind: two sites that each left a failed closing save are two causes, both told by one stop.
test("Two sites that each left a failed closing save stop Sign out once, and the next press signs out", async ({ page }) => {
  const email = uniqueEmail("px2");
  const siteY = await builtSiteAs(page, email);
  const siteZ = await builtSiteAs(page, email);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Your websites" })).toBeVisible();
  const events = watchSavesBySite(page, { Y: siteY, Z: siteZ });
  await leaveFailingEditor(page, siteY, "Y, never saved");
  await leaveFailingEditor(page, siteZ, "Z, never saved");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("alert").filter({ hasText: NOT_SAVED })).toContainText(PRESS_AGAIN);
  expect(events).not.toContain("logout-sent");
  await pressAfterGrace(page);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  expect(events.at(-1)).toBe("logout-sent");
});

// PA: the press's OWN save is the one that finds the dropped wording change. The stop it then shows stays up: no alert node is removed.
test("PA: a dropped wording change found by the press's own save keeps the stop up", async ({ page, browser }) => {
  const siteId = await builtSiteAs(page, uniqueEmail("pa"));
  const rev = (await apiCall(page, "GET", `/api/sites/${siteId}`)).json!["rev"] as number;
  expect((await apiCall(page, "PATCH", `/api/sites/${siteId}/draft`, { rev, facts: { ...FACTS, trade: "roofing" } })).status).toBe(200);
  await page.goto(`/sites/${siteId}/edit`);
  const headline = page.getByLabel("Headline", { exact: true });
  await expect(headline).toHaveValue("Plumbing done right");
  await rewriteElsewhere(page, browser, siteId);
  await page.evaluate(() => {
    const w = window as unknown as { alertsRemoved: string[] };
    w.alertsRemoved = [];
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) {
          if (node instanceof Element && (node.matches("[role=alert]") || node.querySelector("[role=alert]") !== null)) w.alertsRemoved.push(node.textContent ?? "");
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  const events = watchSaves(page);
  await headline.fill("Mine, then Sign out at once");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("status").filter({ hasText: WORDING_DROPPED })).toBeFocused();
  await expect.poll(() => events).toContain("patch-answered-200");
  await settleRender(page);
  // The "Saving…" alert of the press is replaced by the stop; the stop itself is never taken out.
  const removed = await page.evaluate(() => (window as unknown as { alertsRemoved: string[] }).alertsRemoved);
  expect(removed.filter((text) => text.includes(WORDING_DROPPED))).toEqual([]);
  await expect(page.getByRole("alert").filter({ hasText: WORDING_DROPPED })).toContainText(PRESS_AGAIN);
  expect(events).not.toContain("logout-sent");
});

// ---------------- REFUSED SAVES, KEPT DROPS ----------------
const signOutButton = (page: Page) => page.getByRole("button", { name: "Sign out" });
const signInHeading = (page: Page) => page.getByRole("heading", { level: 1, name: "Sign in" });


/** Site S on old wording; its editor closes (Back) with a wording edit whose closing save FAILS (500); new wording landed meanwhile. */
async function closedEditorFailedOnStaleWording(page: Page, browser: Browser, email: string) {
  const siteId = await builtSiteAs(page, email);
  const rev = (await apiCall(page, "GET", `/api/sites/${siteId}`)).json!["rev"] as number;
  expect((await apiCall(page, "PATCH", `/api/sites/${siteId}/draft`, { rev, facts: { ...FACTS, trade: "roofing" } })).status).toBe(200);
  await page.goto("/");
  await page.locator(`a[href="/sites/${siteId}/edit"]`).click();
  await expect(page.getByRole("heading", { level: 1, name: "Edit your website" })).toBeFocused();
  const headline = page.getByLabel("Headline", { exact: true });
  await expect(headline).toHaveValue("Plumbing done right");
  await rewriteElsewhere(page, browser, siteId);
  const gate = { failing: true };
  await page.route(`**/api/sites/${siteId}/draft`, (route) => (route.request().method() === "PATCH" && gate.failing ? route.fulfill(FAIL_500) : route.fallback()));
  const events = watchSaves(page);
  await headline.fill("Mine, closing save fails");
  await browserBack(page);
  await expect(page.getByRole("heading", { level: 1, name: "Your websites" })).toBeVisible();
  await expect.poll(() => events).toContain("patch-answered-500");
  gate.failing = false;
  return { siteId, events };
}

/** Sign out's retry of the failed closing save finds the drop: the press stops with the drop text. Then S's editor is opened. */
async function keptDropReachesNextEditor(page: Page, browser: Browser, email: string) {
  const { siteId, events } = await closedEditorFailedOnStaleWording(page, browser, email);
  await signOutButton(page).click();
  const stop = page.getByRole("alert").filter({ hasText: WORDING_DROPPED });
  await expect(stop).toContainText(PRESS_AGAIN);
  const stopText = await stop.textContent();
  const afterPress = [...events];
  expect(events).not.toContain("logout-sent");
  await page.waitForTimeout(GRACE_MS + 100);
  // Instead of pressing again, the owner opens that site's editor.
  await page.locator(`a[href="/sites/${siteId}/edit"]`).click();
  await expect(page.getByRole("heading", { level: 1, name: "Edit your website" })).toBeFocused();
  const notice = page.getByRole("status").filter({ hasText: WORDING_DROPPED });
  const noticeShown = await notice.isVisible().catch(() => false);
  const dismissShown = await page.getByRole("button", { name: "Dismiss" }).isVisible().catch(() => false);
  return { siteId, events, stopText, afterPress, notice, noticeShown, dismissShown };
}

test("K1: a drop found by Sign out's retry of a failed closing save stops once, the site's next editor SHOWS the notice, and it never stops a leave twice", async ({ page, browser }) => {
  const k = await keptDropReachesNextEditor(page, browser, uniqueEmail("k1"));
  await expect(k.notice).toBeVisible();
  await expect(page.getByRole("button", { name: "Dismiss" })).toBeVisible();
  // G2: the owner was already stopped once for this drop (the Sign out stop): the next leave goes on.
  const before = k.events.length;
  await signOutButton(page).click();
  await expect(signInHeading(page)).toBeVisible();
  console.log(`K1-RESULT stopText=${JSON.stringify(k.stopText)} afterPress=${JSON.stringify(k.afterPress)} noticeShown=${k.noticeShown} dismissShown=${k.dismissShown} afterNextEditor=${JSON.stringify(k.events.slice(before))}`);
  expect(k.noticeShown).toBe(true);
});

test("K0: a drop found by the closing save itself (R3) is told by a Sign out stop; does the site's next editor stop a leave for it AGAIN?", async ({ page, browser }) => {
  const siteId = await builtSiteAs(page, uniqueEmail("k0"));
  const rev = (await apiCall(page, "GET", `/api/sites/${siteId}`)).json!["rev"] as number;
  expect((await apiCall(page, "PATCH", `/api/sites/${siteId}/draft`, { rev, facts: { ...FACTS, trade: "roofing" } })).status).toBe(200);
  await page.goto("/");
  await page.locator(`a[href="/sites/${siteId}/edit"]`).click();
  await expect(page.getByRole("heading", { level: 1, name: "Edit your website" })).toBeFocused();
  const headline = page.getByLabel("Headline", { exact: true });
  await expect(headline).toHaveValue("Plumbing done right");
  await rewriteElsewhere(page, browser, siteId);
  const events = watchSaves(page);
  await headline.fill("Mine, typed just before Back");
  await browserBack(page);
  await expect(page.getByRole("heading", { level: 1, name: "Your websites" })).toBeVisible();
  await expect.poll(() => events).toContain("patch-answered-200");
  await signOutButton(page).click();
  await expect(page.getByRole("alert").filter({ hasText: WORDING_DROPPED })).toContainText(PRESS_AGAIN);
  await page.waitForTimeout(GRACE_MS + 100);
  await page.locator(`a[href="/sites/${siteId}/edit"]`).click();
  await expect(page.getByRole("heading", { level: 1, name: "Edit your website" })).toBeFocused();
  const noticeShown = await page.getByRole("status").filter({ hasText: WORDING_DROPPED }).isVisible();
  await signOutButton(page).click();
  const outcome = await Promise.race([
    signInHeading(page).waitFor({ timeout: 8_000 }).then(() => "signed-out"),
    page.getByRole("alert").filter({ hasText: WORDING_DROPPED }).waitFor({ timeout: 8_000 }).then(() => "stopped-again"),
  ]).catch(() => "neither");
  console.log(`K0-RESULT noticeShown=${noticeShown} secondLeave=${outcome} events=${JSON.stringify(events)}`);
  // G2 (never block twice): the Sign out stop already told the owner about this drop.
  expect(noticeShown).toBe(true);
  expect(outcome).toBe("signed-out");
});

const WRITING_DROPPED = "New wording is being written. Your last change was not saved. Make it again when the new wording is ready.";
const WRITING_LOCK = "Writing new wording. You can edit again when it is ready.";

// A refused save (generation_in_progress) stores nothing, so the saver's `landed` does not move. A second refused drop after the first
// was told and dismissed has the same (key, source, landed) as the told one. The DECIDED rule: a resolved cause leaves the told set, and
// one that comes back stops once more.
test("W2: a second refused save (another tab's second rewrite), after the first was told and dismissed, stops Sign out again", async ({ page, browser }) => {
  const siteId = await builtSite(page);
  await page.goto(`/sites/${siteId}/edit`);
  await expect(page.getByRole("heading", { level: 1, name: "Edit your website" })).toBeFocused();
  const headline = page.getByLabel("Headline", { exact: true });
  const other = await browser.newContext({ baseURL: APP, ignoreHTTPSErrors: true, storageState: await page.context().storageState() });
  try {
    const tabB = await other.newPage();
    await tabB.goto(`/sites/${siteId}/edit`);
    await expect(tabB.getByRole("heading", { level: 1, name: "Edit your website" })).toBeFocused();
    const id1 = await askNewWording(tabB, siteId);
    const events = watchSaves(page);
    await headline.fill("Changed during rewrite 1");
    const notice = page.getByRole("status").filter({ hasText: WRITING_DROPPED });
    await expect(notice).toBeVisible();
    await expect(page.getByText(WRITING_LOCK)).toHaveCount(1);
    await signOutButton(page).click();
    const stop = page.getByRole("alert").filter({ hasText: WRITING_DROPPED });
    await expect(stop).toContainText(PRESS_AGAIN);
    // The owner stays. Rewrite 1 fails, the lock lifts, the owner dismisses the notice: the told cause is resolved.
    await finishGeneration(tabB.request, id1, "failed");
    await expect(page.getByText(WRITING_LOCK)).toHaveCount(0, { timeout: 15_000 });
    await page.getByRole("button", { name: "Dismiss" }).click();
    await settleRender(page);
    const stopsAfterDismiss = await page.getByRole("alert").filter({ hasText: PRESS_AGAIN }).count();
    // Another rewrite from tab B; this tab's next change is refused again: a NEW drop, same site, same kind, nothing landed.
    await tabB.reload();
    await expect(tabB.getByRole("heading", { level: 1, name: "Edit your website" })).toBeFocused();
    const id2 = await askNewWording(tabB, siteId);
    const before = events.length;
    await headline.fill("Changed during rewrite 2");
    await expect(notice).toBeVisible();
    await expect.poll(() => events.slice(before)).toEqual(["patch-sent", "patch-answered-409"]);
    await settleRender(page);
    await page.waitForTimeout(GRACE_MS);
    await signOutButton(page).click();
    const outcome = await Promise.race([
      signInHeading(page).waitFor({ timeout: 8_000 }).then(() => "signed-out"),
      stop.filter({ hasText: PRESS_AGAIN }).waitFor({ timeout: 8_000 }).then(() => "stopped-again"),
    ]).catch(() => "neither");
    console.log(`W2-RESULT stopsAfterDismiss=${stopsAfterDismiss} secondDrop=${outcome} events=${JSON.stringify(events)}`);
    await finishGeneration(other.request, id2, "failed").catch(() => undefined);
    expect(outcome).toBe("stopped-again");
  } finally {
    await other.close();
  }
});

// The data variant of W2: a failure told, then resolved by a refused save (its unsaved values are discarded by the refusal, nothing lands),
// then a NEW failed edit. The DECIDED rule: a resolved cause leaves the told set, so the new failure stops once (the edit can still be saved).
test("F2: a failure told, resolved by a refused save, then a NEW failed edit: Sign out stops before losing it", async ({ page, browser }) => {
  const siteId = await builtSite(page);
  await page.goto(`/sites/${siteId}/edit`);
  await expect(page.getByRole("heading", { level: 1, name: "Edit your website" })).toBeFocused();
  const headline = page.getByLabel("Headline", { exact: true });
  const gate = { failing: true };
  await page.route(`**/api/sites/${siteId}/draft`, (route) => (route.request().method() === "PATCH" && gate.failing ? route.fulfill(FAIL_500) : route.fallback()));
  const events = watchSaves(page);
  await headline.fill("F1 typed, failing");
  await expect(page.getByText("Your changes are not saved yet", { exact: false }).first()).toBeVisible();
  await signOutButton(page).click();
  const stop = page.getByRole("alert").filter({ hasText: NOT_SAVED });
  await expect(stop).toContainText(PRESS_AGAIN);
  const other = await browser.newContext({ baseURL: APP, ignoreHTTPSErrors: true, storageState: await page.context().storageState() });
  try {
    const tabB = await other.newPage();
    await tabB.goto(`/sites/${siteId}/edit`);
    await expect(tabB.getByRole("heading", { level: 1, name: "Edit your website" })).toBeFocused();
    const id1 = await askNewWording(tabB, siteId);
    gate.failing = false;
    await headline.fill("Typed while tab B writes");
    await expect(page.getByRole("status").filter({ hasText: WRITING_DROPPED })).toBeVisible();
    await settleRender(page);
    const alertsAfterRefusal = await page.getByRole("alert").filter({ hasText: PRESS_AGAIN }).allTextContents();
    await finishGeneration(tabB.request, id1, "failed");
    await expect(page.getByText(WRITING_LOCK)).toHaveCount(0, { timeout: 15_000 });
    await page.getByRole("button", { name: "Dismiss" }).click();
    gate.failing = true;
    await headline.fill("F2, a new edit that fails");
    await expect(page.getByText("Your changes are not saved yet", { exact: false }).first()).toBeVisible();
    await settleRender(page);
    const alertsAtF2 = await page.getByRole("alert").filter({ hasText: PRESS_AGAIN }).allTextContents();
    await page.waitForTimeout(GRACE_MS);
    const sentBefore = events.filter((e) => e === "patch-sent").length;
    await signOutButton(page).click();
    const outcome = await Promise.race([
      signInHeading(page).waitFor({ timeout: 8_000 }).then(() => "signed-out"),
      page.waitForTimeout(3_000).then(() => (events.includes("logout-sent") ? "signed-out" : "stayed")),
    ]).catch(() => "neither");
    console.log(`F2-RESULT alertsAfterRefusal=${JSON.stringify(alertsAfterRefusal)} alertsAtF2=${JSON.stringify(alertsAtF2)} pressRetried=${events.filter((e) => e === "patch-sent").length > sentBefore} outcome=${outcome} events=${JSON.stringify(events)}`);
    expect(outcome).toBe("stayed");
  } finally {
    await other.close();
  }
});
