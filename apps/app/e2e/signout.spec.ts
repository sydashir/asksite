import { expect, test, type Browser, type Page } from "@playwright/test";
import { acceptInvite, apiCall, APP, askNewWording, BRIEF, builtSite, FACTS, finishGeneration, stubTurnstile, uniqueEmail, uniqueSlug, waitForSecurityCheck } from "./support.ts";

const LOGOUT = "**/api/auth/logout";

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
  await page.route(`**/api/sites/${siteId}/draft`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await page.getByLabel("Headline", { exact: true }).fill("Typed just before Back");
  await browserBack(page);
  await expect(page.getByRole("heading", { level: 1, name: "Your websites" })).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  expect(events).toEqual(["patch-sent", "patch-answered-200", "logout-sent"]);
  expect(await storedHeadline(browser, email, siteId)).toBe("Typed just before Back");
});

test("Sign out stays and says so when the save the editor started as it closed failed; the next press saves it, then signs out", async ({ page, browser }) => {
  const email = uniqueEmail("leavingfail");
  const siteId = await builtSiteAs(page, email);
  await page.goto("/");
  await page.getByRole("link", { name: "Open" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Edit your website" })).toBeFocused();
  let failing = true;
  await page.route(`**/api/sites/${siteId}/draft`, (route) =>
    route.request().method() === "PATCH" && failing ? route.fulfill({ status: 500, json: { error: { code: "internal", message: "Something went wrong. Please try again." } } }) : route.fallback(),
  );
  const events = watchSaves(page);
  await page.getByLabel("Headline", { exact: true }).fill("Kept after a failed save");
  await browserBack(page);
  await expect(page.getByRole("heading", { level: 1, name: "Your websites" })).toBeVisible();
  await expect.poll(() => events).toContain("patch-answered-500");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByText("Your latest changes are not saved yet. Please try again in a moment.")).toBeVisible();
  expect(events).not.toContain("logout-sent");
  expect(new URL(page.url()).pathname).toBe("/");
  failing = false;
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  expect(events.at(-1)).toBe("logout-sent");
  expect(events).toContain("patch-answered-200");
  expect(await storedHeadline(browser, email, siteId)).toBe("Kept after a failed save");
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
test("Questionnaire: Sign out stays and says so while the answers are not saved, and a save finishes before the logout", async ({ page }) => {
  await acceptInvite(page, uniqueEmail("setup"));
  let failing = true;
  await page.route("**/api/sites/*/draft", (route) =>
    route.request().method() === "PATCH" && failing ? route.fulfill({ status: 500, json: { error: { code: "internal", message: "Something went wrong. Please try again." } } }) : route.fallback(),
  );
  const events = watchSaves(page);
  await page.getByLabel("Business name").fill("Probe Plumbing");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByText("Your latest answers are not saved yet. Please try again in a moment.")).toBeVisible();
  expect(events).not.toContain("logout-sent");
  expect(new URL(page.url()).pathname).toMatch(/\/setup\/business$/);
  failing = false;
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
