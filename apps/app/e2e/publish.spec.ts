import { expect, test, type Page } from "@playwright/test";
import { expectFrameTitle, expectLinksStayInFrame, JOES_TITLE, LINKS_OFF, scrollFrameBottomIntoView } from "./frame-links.ts";
import { APP, apiCall, builtSite, expectAccessible, expectNoSidewaysScroll, FACTS } from "./support.ts";

const PREVIEW_FRAME = 'iframe[title="Preview of the pages we are reviewing"]';

test("send for review, see what is reviewed, withdraw, send again, then see it live", async ({ page }) => {
  const siteId = await builtSite(page);
  await page.goto(`/sites/${siteId}/publish`);
  await expect(page.getByRole("heading", { level: 1, name: "Publish your website" })).toBeFocused();
  await expectAccessible(page);

  await page.getByRole("button", { name: "Send for review" }).click();
  await expect(page.getByRole("heading", { name: "Waiting for approval" })).toBeVisible();
  await expect(page.getByText(/^Version 1, sent/)).toBeVisible();
  // The pages of the sent version, inline: a "Page" group outside the frame, one button per page the version has.
  await expect(page.getByRole("heading", { name: "See what we are reviewing" })).toBeVisible();
  const pageButtons = page.getByRole("group", { name: "Page", exact: true }).getByRole("button");
  await expect(pageButtons).toHaveText(["Home", "Services", "About", "Contact"]);
  await expect(pageButtons.first()).toHaveAttribute("aria-pressed", "true");
  const frame = page.frameLocator(PREVIEW_FRAME);
  await expect(page.locator(PREVIEW_FRAME)).toHaveAttribute("sandbox", "");
  await expectFrameTitle(frame, JOES_TITLE.home);
  await pageButtons.nth(1).click();
  await expect(pageButtons.nth(1)).toHaveAttribute("aria-pressed", "true");
  await expectFrameTitle(frame, JOES_TITLE.services);
  await page.getByRole("group", { name: "Page", exact: true }).getByRole("button", { name: "Contact" }).click();
  await expect(frame.locator("form#quote")).toBeAttached();
  const sent = (await apiCall(page, "GET", `/api/sites/${siteId}`)).json?.["pendingVersion"] as { id: string };
  const stored = await page.request.get(`${APP}/api/sites/${siteId}/versions/${sent.id}/pages/home`);
  expect(stored.headers()["content-security-policy"]).toContain("sandbox");
  expect(await stored.text()).toContain("Plumbing done right");
  await expectAccessible(page);
  await page.setViewportSize({ width: 320, height: 700 });
  await expectNoSidewaysScroll(page);

  await page.getByRole("button", { name: "Withdraw this request" }).click();
  await page.getByRole("dialog", { name: "Withdraw your request?" }).getByRole("button", { name: "Withdraw" }).click();
  await expect(page.getByText("Your request was withdrawn. Nothing was published.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Waiting for approval" })).toBeHidden();

  await page.getByRole("button", { name: "Send for review" }).click();
  await expect(page.getByText(/^Version 2, sent/)).toBeVisible();
  const view = await apiCall(page, "GET", `/api/sites/${siteId}`);
  const pending = view.json?.["pendingVersion"] as { id: string };
  await page.request.post(`${APP}/__test/versions/${pending.id}/approve`, { data: {} });
  await page.reload();
  await expect(page.getByText("Your website is live at")).toBeVisible();
  await expect(page.getByRole("link", { name: /^https:\/\/joes-[a-z0-9]+\.localhost:8789\/$/ })).toBeVisible();
});

test("links in the preview frame go nowhere: the frame stays on the shown page and the status line says so, by click and by Enter", async ({ page }) => {
  const siteId = await builtSite(page);
  await page.goto(`/sites/${siteId}/publish`);
  await page.getByRole("button", { name: "Send for review" }).click();
  await expect(page.getByRole("heading", { name: "Waiting for approval" })).toBeVisible();
  await expectLinksStayInFrame(page, PREVIEW_FRAME, async () => {
    await page.reload();
    await expect(page.getByRole("heading", { name: "Waiting for approval" })).toBeVisible();
  });
});

test("moving Home, Services, Home in the preview says nothing about links, and one real link click says it once", async ({ page }) => {
  const siteId = await builtSite(page);
  await page.goto(`/sites/${siteId}/publish`);
  await page.getByRole("button", { name: "Send for review" }).click();
  await expect(page.getByRole("heading", { name: "Waiting for approval" })).toBeVisible();
  const group = page.getByRole("group", { name: "Page", exact: true });
  const frame = page.frameLocator(PREVIEW_FRAME);
  await expectFrameTitle(frame, JOES_TITLE.home);

  // Count every "Links are turned off" the preview's status line ever inserts. The line is found by structure (the role="status"
  // right after the buttons' row), not by text. Counting starts before the first switch.
  await page.evaluate((text) => {
    const box = document.querySelector('[role="group"][aria-label="Page"]')?.parentElement?.nextElementSibling;
    if (box?.getAttribute("role") !== "status") throw new Error("the preview's status line is not where it was");
    const seen = { count: 0 };
    (window as unknown as { linksOffSeen: typeof seen }).linksOffSeen = seen;
    new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) if (node.textContent === text) seen.count += 1;
    }).observe(box, { childList: true, subtree: true });
  }, LINKS_OFF);

  for (const [name, title] of [["Home", JOES_TITLE.home], ["Services", JOES_TITLE.services], ["Home", JOES_TITLE.home]] as const) {
    await group.getByRole("button", { name }).click();
    await expect(group.getByRole("button", { name })).toHaveAttribute("aria-pressed", "true");
    await expectFrameTitle(frame, title, `the frame shows ${name}`);
  }

  // The barrier: this real click makes a later load event than any switch above, and React renders the updates of one lane
  // together and in order (react-dom 19.3.0: "load" has no case in getEventPriority, cjs/react-dom-client.development.js:26252-26340,
  // so every load's update is DefaultEventPriority). When its announcement is visible, any earlier one is committed too.
  const target = frame.getByRole("link", { name: "Get a quote", exact: true }).first();
  // Below 1024 px the renderer's menu is a <details>: its links are hidden until the menu is opened.
  if ((await target.count()) === 0) await frame.locator("details > summary").click();
  await scrollFrameBottomIntoView(page, PREVIEW_FRAME);
  await target.click();
  await expect(page.getByText(LINKS_OFF)).toBeVisible();
  await expectFrameTitle(frame, JOES_TITLE.home, "the frame stays on Home");
  expect(await page.evaluate(() => (window as unknown as { linksOffSeen: { count: number } }).linksOffSeen.count)).toBe(1);
});

// N1 (2026-10-06): "Desktop width" is the real 1280 px layout, scaled to fit the column, so the owner sees what a visitor on a desktop sees.
// Bold hides its header call button below 64rem; at the old 622 px frame it never showed, whatever the label said.
test("Desktop width shows the 1280 px layout: Bold's header call button is visible, in a frame no wider than its column", async ({ page }) => {
  const siteId = await builtSite(page);
  await page.goto(`/sites/${siteId}/publish`);
  await page.getByRole("button", { name: "Send for review" }).click();
  await expect(page.getByRole("heading", { name: "Waiting for approval" })).toBeVisible();
  await page.getByRole("button", { name: "Desktop width" }).click();
  await expect(page.getByRole("button", { name: "Desktop width" })).toHaveAttribute("aria-pressed", "true");
  const frame = page.frameLocator(PREVIEW_FRAME);
  await expectFrameTitle(frame, JOES_TITLE.home);
  await expect(page.locator(PREVIEW_FRAME), 'the design is Bold ("impact"), whose header button this test needs').toHaveAttribute("srcdoc", /data-design="impact"/);
  await expect(frame.locator(".header-cta")).toBeVisible();
  expect(await frame.locator("body").evaluate(() => window.innerWidth)).toBe(1280);
  const column = await page.locator(PREVIEW_FRAME).locator("xpath=ancestor::div[2]").boundingBox();
  const box = await page.locator(PREVIEW_FRAME).boundingBox();
  expect(box?.width).toBeLessThanOrEqual((column?.width ?? 0) + 0.5);
});

test("publishing with reviews but no attestation lists the fix, with a link to it", async ({ page }) => {
  const siteId = await builtSite(page, { ...FACTS, testimonials: [{ quote: "Fixed our leak the same afternoon.", name: "Ana P." }] });
  await page.goto(`/sites/${siteId}/publish`);
  await page.getByRole("button", { name: "Send for review" }).click();
  const fix = page.getByRole("link", { name: "Why customers can trust you: Check the box to confirm these reviews are from real customers." });
  await expect(fix).toBeVisible();
  await fix.click();
  await page.waitForURL(`${APP}/sites/${siteId}/setup/trust#f-brief-reviewsAreReal`);
  await expect(page.getByLabel("These reviews are from real customers, copied word for word")).toBeFocused();
});

test("an empty closing time is listed once, and its link opens that day's closing field", async ({ page }) => {
  const siteId = await builtSite(page);
  const before = await apiCall(page, "GET", `/api/sites/${siteId}`);
  await apiCall(page, "PATCH", `/api/sites/${siteId}/draft`, { rev: before.json?.["rev"], facts: { ...FACTS, hours: [{ days: ["Monday"], opens: "09:00", closes: "" }] } });
  await page.goto(`/sites/${siteId}/publish`);
  await page.getByRole("button", { name: "Send for review" }).click();
  await expect(page.getByRole("heading", { name: "There is 1 thing to fix" })).toBeVisible();
  await page.getByRole("link", { name: /Please enter a time\./ }).click();
  await page.waitForURL(`${APP}/sites/${siteId}/setup/area#hours-Monday-closes`);
  await expect(page.getByLabel("Monday closes at")).toBeFocused();
});

test("a request approved in another tab is not reported as withdrawn", async ({ page }) => {
  const siteId = await builtSite(page);
  await page.goto(`/sites/${siteId}/publish`);
  await page.getByRole("button", { name: "Send for review" }).click();
  await expect(page.getByRole("heading", { name: "Waiting for approval" })).toBeVisible();
  const view = await apiCall(page, "GET", `/api/sites/${siteId}`);
  const pending = view.json?.["pendingVersion"] as { id: string };
  await page.request.post(`${APP}/__test/versions/${pending.id}/approve`, { data: {} });
  // No reload: the page still shows "Waiting for approval" when the owner withdraws.
  await page.getByRole("button", { name: "Withdraw this request" }).click();
  await page.getByRole("dialog", { name: "Withdraw your request?" }).getByRole("button", { name: "Withdraw" }).click();
  await expect(page.getByText("Your website is live at")).toBeVisible();
  await expect(page.getByText("There was no request waiting to withdraw. Its latest status is shown above.")).toBeVisible();
  await expect(page.getByText(/Nothing was published/)).toBeHidden();
});

test("a rejected request shows the reviewer's note", async ({ page }) => {
  const siteId = await builtSite(page);
  await page.goto(`/sites/${siteId}/publish`);
  await page.getByRole("button", { name: "Send for review" }).click();
  await expect(page.getByRole("heading", { name: "Waiting for approval" })).toBeVisible();
  const view = await apiCall(page, "GET", `/api/sites/${siteId}`);
  const pending = view.json?.["pendingVersion"] as { id: string };
  await page.request.post(`${APP}/__test/versions/${pending.id}/reject`, { data: { note: "Please add your license number." } });
  await page.reload();
  await expect(page.getByText("We asked for a change before your website goes live:")).toBeVisible();
  await expect(page.getByText("Please add your license number.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Waiting for approval" })).toBeHidden();
});

test("after going live, a changed draft says it is not published yet", async ({ page }) => {
  const siteId = await builtSite(page);
  await page.goto(`/sites/${siteId}/publish`);
  await page.getByRole("button", { name: "Send for review" }).click();
  await expect(page.getByRole("heading", { name: "Waiting for approval" })).toBeVisible();
  const view = await apiCall(page, "GET", `/api/sites/${siteId}`);
  const pending = view.json?.["pendingVersion"] as { id: string };
  await page.request.post(`${APP}/__test/versions/${pending.id}/approve`, { data: {} });
  await page.reload();
  await expect(page.getByText("Your website is live at")).toBeVisible();
  await expect(page.getByText("You have changes that are not published yet.")).toBeHidden();
  const live = await apiCall(page, "GET", `/api/sites/${siteId}`);
  await apiCall(page, "PATCH", `/api/sites/${siteId}/draft`, { rev: live.json?.["rev"], facts: { ...FACTS, businessName: "Joe's Plumbing and Heating" } });
  await page.reload();
  await expect(page.getByText("You have changes that are not published yet.")).toBeVisible();
});

for (const path of ["setup/business", "publish"]) {
  test(`a site that cannot be loaded shows an error, not a spinner (/${path})`, async ({ page }) => {
    await builtSite(page);
    await page.goto(`/sites/00000000-0000-4000-8000-000000000000/${path}`);
    await expect(page.getByText(/not found|could not|cannot/i)).toBeVisible();
    await expect(page.getByText(/^Loading/)).toBeHidden();
  });
}

test("a taken-down site shows the notice and no way to send for review", async ({ page }) => {
  const siteId = await builtSite(page);
  await page.request.post(`${APP}/__test/sites/${siteId}/take-down`, { data: {} });
  await page.goto(`/sites/${siteId}/publish`);
  await expect(page.getByText("Your website has been taken offline, so visitors cannot see it.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send for review" })).toBeHidden();
});

/**
 * Reloads the Publish page and returns once its version list has been fetched AND drawn. The list starts
 * empty and fills after mount, so an absence check made earlier would pass for the wrong reason.
 */
async function reloadWithVersions(page: Page, siteId: string) {
  const loaded = page.waitForResponse((res) => res.request().method() === "GET" && new URL(res.url()).pathname === `/api/sites/${siteId}/versions`);
  await page.reload();
  await loaded;
  // The response is in; let React draw it before anything is asserted to be absent.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test("a takedown never shows as a requested change, and neither does the restore", async ({ page }) => {
  const siteId = await builtSite(page);
  const pendingId = async () => ((await apiCall(page, "GET", `/api/sites/${siteId}`)).json?.["pendingVersion"] as { id: string }).id;
  await page.goto(`/sites/${siteId}/publish`);
  await page.getByRole("button", { name: "Send for review" }).click();
  await expect(page.getByRole("heading", { name: "Waiting for approval" })).toBeVisible();
  await page.request.post(`${APP}/__test/versions/${await pendingId()}/approve`, { data: {} });
  await page.reload();
  await expect(page.getByText("Your website is live at")).toBeVisible();

  await page.getByRole("button", { name: "Send for review" }).click();
  await expect(page.getByRole("heading", { name: "Waiting for approval" })).toBeVisible();
  await page.request.post(`${APP}/__test/sites/${siteId}/take-down`, { data: {} });
  // A slow list must not let the absence check pass before the versions have arrived.
  await page.route(`**/api/sites/${siteId}/versions`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await reloadWithVersions(page, siteId);
  await expect(page.getByText("Your website has been taken offline, so visitors cannot see it.")).toBeVisible();
  await expect(page.getByText("We asked for a change")).toBeHidden();

  await page.request.post(`${APP}/__test/sites/${siteId}/restore`, { data: {} });
  await reloadWithVersions(page, siteId);
  await expect(page.getByText("Your website is live at")).toBeVisible();
  await expect(page.getByText("We asked for a change")).toBeHidden();
});

test("a real rejection is not shown as a requested change once the site is taken down", async ({ page }) => {
  const siteId = await builtSite(page);
  await page.goto(`/sites/${siteId}/publish`);
  await page.getByRole("button", { name: "Send for review" }).click();
  await expect(page.getByRole("heading", { name: "Waiting for approval" })).toBeVisible();
  const pending = (await apiCall(page, "GET", `/api/sites/${siteId}`)).json?.["pendingVersion"] as { id: string };
  await page.request.post(`${APP}/__test/versions/${pending.id}/reject`, { data: { note: "Please add your license number." } });
  // Control: before the takedown this real note is shown.
  await reloadWithVersions(page, siteId);
  await expect(page.getByText("We asked for a change before your website goes live:")).toBeVisible();

  await page.request.post(`${APP}/__test/sites/${siteId}/take-down`, { data: {} });
  await reloadWithVersions(page, siteId);
  await expect(page.getByText("Your website has been taken offline, so visitors cannot see it.")).toBeVisible();
  await expect(page.getByText("We asked for a change")).toBeHidden();
});

test("after a restore, an older rejection does not come back as a requested change", async ({ page }) => {
  const siteId = await builtSite(page);
  const pendingId = async () => ((await apiCall(page, "GET", `/api/sites/${siteId}`)).json?.["pendingVersion"] as { id: string }).id;
  await page.goto(`/sites/${siteId}/publish`);
  await page.getByRole("button", { name: "Send for review" }).click();
  await expect(page.getByRole("heading", { name: "Waiting for approval" })).toBeVisible();
  await page.request.post(`${APP}/__test/versions/${await pendingId()}/reject`, { data: { note: "Fix X" } });
  await reloadWithVersions(page, siteId);
  await expect(page.getByText("Fix X")).toBeVisible();

  // Version 2 is sent, then the site is taken down and restored: version 2 was never reviewed.
  await page.getByRole("button", { name: "Send for review" }).click();
  await expect(page.getByText(/^Version 2, sent/)).toBeVisible();
  await page.request.post(`${APP}/__test/sites/${siteId}/take-down`, { data: {} });
  await page.request.post(`${APP}/__test/sites/${siteId}/restore`, { data: {} });
  await reloadWithVersions(page, siteId);
  await expect(page.getByRole("heading", { name: "Publish your website" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send for review" })).toBeVisible();
  await expect(page.getByText("We asked for a change")).toBeHidden();
  await expect(page.getByText("Fix X")).toBeHidden();
});
