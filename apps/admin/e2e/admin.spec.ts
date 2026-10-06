import { expect, test, type Page } from "@playwright/test";
import { expectFrameTitle, expectLinksStayInFrame, JOES_TITLE } from "../../app/e2e/frame-links.ts";
import { ADMIN, expectAccessible, expectNoSidewaysScroll, FACTS, pendingSite, showEveryPage, tabTo, UNLOCKED, watchCsp } from "./support.ts";

const FRAME = 'iframe[title="Page under review"]';

/** A site that was approved, so it is live: its detail page is /sites/<siteId>. */
async function liveSite(page: Page, options: { emailDomain?: string } = {}) {
  const site = await pendingSite(page.request, FACTS, options);
  await page.goto(`/reviews/${site.versionId}`);
  await showEveryPage(page);
  await page.getByRole("button", { name: "Approve and publish" }).click();
  await expect(page.getByText("Approved.", { exact: false })).toBeVisible();
  return site;
}

test("review a site: the stored page shows in a sandboxed frame, flags are listed, and approving publishes it", async ({ page }) => {
  const violations = await watchCsp(page);
  const site = await pendingSite(page.request, { ...FACTS, testimonials: [{ quote: "Pay at paypa1-help.com", name: "A" }] });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Waiting for review" })).toBeFocused();
  await page.getByRole("link", { name: `Review ${site.slug} version 1` }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Review Joe's Plumbing (version 1)" })).toBeFocused();

  const frame = page.frameLocator(FRAME);
  await page.getByRole("button", { name: "Desktop width" }).click(); // a 390 window opens Phone width (N1); Bold shows its call button from 64rem
  await expect(frame.getByRole("link", { name: "Call Joe today" }).first()).toBeAttached();
  await expect(page.locator(FRAME)).toHaveAttribute("sandbox", "");
  await expect(page.getByText("facts.testimonials.0.quote contains a web address", { exact: false })).toBeVisible();
  await expect(page.getByText("copy.ctaText", { exact: false })).toBeVisible();
  await expectAccessible(page);
  await expectNoSidewaysScroll(page);
  await expect(page.locator("dd", { hasText: FACTS.email })).toBeVisible();

  const desktop = page.getByRole("button", { name: "Desktop width" });
  const phone = page.getByRole("button", { name: "Phone width" });
  await expect(desktop).toHaveAttribute("aria-pressed", "true");
  await phone.click();
  await expect(phone).toHaveAttribute("aria-pressed", "true");
  await expect(desktop).toHaveAttribute("aria-pressed", "false");
  expect((await page.locator(FRAME).boundingBox())?.width).toBeLessThanOrEqual(390);
  await desktop.click();
  await expect(desktop).toHaveAttribute("aria-pressed", "true");

  await page.getByLabel("Allow search engines to list this site").uncheck();
  await showEveryPage(page);
  await page.getByRole("button", { name: "Approve and publish" }).click();
  await expect(page.getByText("Approved. We'll email the owner. The site goes live within about a minute:")).toBeVisible();
  await expect(page.getByRole("link", { name: `https://${site.slug}.localhost:8789/` })).toBeVisible();
  expect(await violations()).toEqual([]);
});

// ADMIN-CSP-COLLECTOR: the collector must see a violation in every engine, so an empty list means "none" and not "not
// watching". An inline script on the admin's own origin breaks its script-src 'self'; the event line (not the console
// wording, which differs by engine) is what proves the securitypolicyviolation listener works.
test("the CSP collector reports an inline script on the admin origin", async ({ page }) => {
  const violations = await watchCsp(page);
  await page.goto("/");
  await page.evaluate(() => {
    const script = document.createElement("script");
    script.textContent = "window.__inlineRan = true";
    document.head.append(script);
  });
  expect(await page.evaluate(() => "__inlineRan" in window)).toBe(false);
  await expect.poll(async () => (await violations()).filter((line) => /^event script-src(-elem)? inline$/.test(line)).length).toBeGreaterThan(0);
});

test("the review shows every page of the version, as stored, and its links go nowhere (click and Enter)", async ({ page }) => {
  const site = await pendingSite(page.request);
  await page.goto(`/reviews/${site.versionId}`);
  const pageButtons = page.getByRole("group", { name: "Page", exact: true }).getByRole("button");
  await expect(pageButtons).toHaveText(["Home", "Services", "About", "Contact"]);
  const frame = page.frameLocator(FRAME);
  await expectFrameTitle(frame, JOES_TITLE.home);
  // What the frame shows is what is stored: the page's own bytes, with no style or other edit added.
  const detail = (await (await page.request.get(`${ADMIN}/api/admin/versions/${site.versionId}`)).json()) as { pages: Array<{ page: string; url: string }> };
  expect(detail.pages.map((p) => p.page)).toEqual(["home", "services", "about", "contact"]);
  const stored = await (await page.request.get(`${ADMIN}${detail.pages[0]?.url}`)).text();
  await expect(page.locator(FRAME)).toHaveAttribute("srcdoc", stored);
  await expectLinksStayInFrame(page, FRAME, async () => {
    await page.goto(`/reviews/${site.versionId}`);
    await expect(page.getByRole("group", { name: "Page", exact: true })).toBeVisible();
  }, "Call Joe today"); // the site's own wording: at the 1280 layout Bold shows it in the header, not as "Get a quote"
});

test("the review page says when the stored page could not load, and loads it on Try again", async ({ page }) => {
  const site = await pendingSite(page.request);
  await page.route("**/api/admin/versions/*/pages/*", (route) => route.fulfill({ status: 500, json: { error: { code: "internal", message: "Something went wrong." } } }));
  await page.goto(`/reviews/${site.versionId}`);
  await expect(page.getByText("The page couldn't load.")).toBeVisible();
  await page.unroute("**/api/admin/versions/*/pages/*");
  await page.getByRole("button", { name: "Try again" }).click();
  await page.getByRole("button", { name: "Desktop width" }).click(); // a 390 window opens Phone width (N1); Bold shows its call button from 64rem
  await expect(page.frameLocator(FRAME).getByRole("link", { name: "Call Joe today" }).first()).toBeAttached();
});

test("rejecting needs a note, which is then sent", async ({ page }) => {
  const site = await pendingSite(page.request);
  await page.goto(`/reviews/${site.versionId}`);
  // WebKit moves focus into an iframe that finishes loading after the textarea was focused: let the preview arrive first. (It now arrives
  // after every page was fetched and proved, so a click straight after goto can come first.)
  await page.getByRole("button", { name: "Desktop width" }).click(); // a 390 window opens Phone width (N1); Bold shows its call button from 64rem
  await expect(page.frameLocator(FRAME).getByRole("link", { name: "Call Joe today" }).first()).toBeAttached();
  await page.getByRole("button", { name: "Reject and email the owner" }).click();
  await expect(page.getByLabel("Reason (the owner sees this)")).toBeFocused();
  await expect(page.getByText("Write a note for the owner.")).toBeVisible();
  await page.getByLabel("Reason (the owner sees this)").fill("Please use photos of your own work.");
  await page.getByRole("button", { name: "Reject and email the owner" }).click();
  await expect(page.getByText("Rejected. We'll email the owner your note.")).toBeVisible();
});

test("the internal note is labelled as not shown to the owner", async ({ page }) => {
  const site = await pendingSite(page.request);
  await page.goto(`/reviews/${site.versionId}`);
  await expect(page.getByLabel("Internal note (optional, not shown to the owner)")).toBeVisible();
});

test("a live address that is not safe to link shows as plain text", async ({ page }) => {
  const site = await pendingSite(page.request);
  await page.route("**/api/admin/versions/*/approve", (route) => route.fulfill({ json: { siteId: site.siteId, liveUrl: "javascript:alert(1)" } }));
  await page.goto(`/reviews/${site.versionId}`);
  await showEveryPage(page);
  await page.getByRole("button", { name: "Approve and publish" }).click();
  await expect(page.getByText("javascript:alert(1)", { exact: false })).toBeVisible();
  await expect(page.locator('a[href^="javascript"]')).toHaveCount(0);
});

test("when approving fails with a server error, Approve stays available to try again", async ({ page }) => {
  const site = await pendingSite(page.request);
  await page.route("**/api/admin/versions/*/approve", (route) => route.fulfill({ status: 500, json: { error: { code: "internal", message: "Something went wrong. Please try again." } } }));
  await page.goto(`/reviews/${site.versionId}`);
  await showEveryPage(page);
  await page.getByRole("button", { name: "Approve and publish" }).click();
  await expect(page.getByText("Something went wrong. Please try again.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve and publish" })).toBeEnabled();
});

test("when approving fails with a server error AFTER the version was approved, Approve stays so the copy to live can be retried", async ({ page }) => {
  const site = await pendingSite(page.request);
  await page.route("**/api/admin/versions/*/approve", async (route) => {
    await route.fetch(); // the server really approves, as it does when only its last step (the live copy) fails
    await route.fulfill({ status: 500, json: { error: { code: "internal", message: "Something went wrong. Please try again." } } });
  });
  await page.goto(`/reviews/${site.versionId}`);
  await showEveryPage(page);
  await page.getByRole("button", { name: "Approve and publish" }).click();
  await expect(page.getByText("Something went wrong. Please try again.")).toBeVisible();
  await expect(page.getByText(/status approved/)).toBeVisible(); // the reload shows the version approved
  await expect(page.getByRole("button", { name: "Approve and publish" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reject and email the owner" })).toHaveCount(0);
  await page.unroute("**/api/admin/versions/*/approve");
  await page.getByRole("button", { name: "Approve and publish" }).click();
  await expect(page.getByText("Approved. We'll email the owner.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve and publish" })).toHaveCount(0);
});

// STRICT (honesty: "The exact pages that will go live"): a page is shown only if its raw bytes hash to ITS OWN listed sha256.
test("a page whose bytes do not match is not shown and cannot be approved; Reject still works, and Try again shows the right page", async ({ page }) => {
  const site = await pendingSite(page.request);
  const detail = (await (await page.request.get(`${ADMIN}/api/admin/versions/${site.versionId}`)).json()) as { pages: Array<{ page: string; url: string }> };
  const urlOf = (name: string) => detail.pages.find((p) => p.page === name)?.url ?? "";
  const home = await page.request.get(`${ADMIN}${urlOf("home")}`);
  const homeBytes = await home.body();
  // The Services address answers with Home's page: a real stored page, but not the one that was sent for review as Services.
  await page.route(`**${urlOf("services")}`, (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: homeBytes }));
  await page.goto(`/reviews/${site.versionId}`);
  await expect(page.getByText("The Services page doesn't match what was sent for review, so this version can't be approved. Try again, or reject it.")).toBeVisible();
  await expect(page.locator(FRAME)).toHaveCount(0);
  const approve = page.getByRole("button", { name: "Approve and publish" });
  await expect(approve).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByRole("button", { name: "Reject and email the owner" })).toBeEnabled();
  let approveRequests = 0;
  await page.route("**/api/admin/versions/*/approve", (route) => {
    approveRequests += 1;
    return route.continue();
  });
  await approve.focus();
  await page.keyboard.press("Enter");
  expect(approveRequests).toBe(0);
  await page.unroute(`**${urlOf("services")}`);
  await page.getByRole("button", { name: "Try again" }).click();
  await page.getByRole("button", { name: "Desktop width" }).click(); // a 390 window opens Phone width (N1); Bold shows its call button from 64rem
  await expect(page.frameLocator(FRAME).getByRole("link", { name: "Call Joe today" }).first()).toBeAttached();
  await expect(page.getByText("doesn't match what was sent for review")).toHaveCount(0);
});

// STRICT (admin gate / honesty): the gate is a process aid, but it must hold: no approve request leaves while a page is unseen.
test("Approve stays off until every page has been shown: it keeps focus, says why, does nothing when pressed, and says once when it turns on", async ({ page }) => {
  const site = await pendingSite(page.request);
  let approveRequests = 0;
  await page.route("**/api/admin/versions/*/approve", (route) => {
    approveRequests += 1;
    return route.continue();
  });
  await page.goto(`/reviews/${site.versionId}`);
  const approve = page.getByRole("button", { name: "Approve and publish" });
  const gate = page.locator("#approve-gate");
  // Home is on screen and its frame loads by itself; the others have not been looked at.
  await expect(gate).toHaveText("Look at every page before approving. Not looked at yet: Services, About, Contact.");
  await expect(approve).toHaveAttribute("aria-disabled", "true");
  await expect(approve).toHaveAttribute("aria-describedby", "approve-gate");
  await expect(page.getByText(UNLOCKED)).toHaveCount(0);
  await approve.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  await expect(approve).toBeFocused();
  expect(approveRequests).toBe(0);
  await expect(page.getByText("Approved. We'll email the owner", { exact: false })).toHaveCount(0);

  const pages = page.getByRole("group", { name: "Page", exact: true });
  await pages.getByRole("button", { name: "Services", exact: true }).click();
  await expect(gate).toHaveText("Look at every page before approving. Not looked at yet: About, Contact.");
  await pages.getByRole("button", { name: "About", exact: true }).click();
  await expect(gate).toHaveText("Look at every page before approving. Not looked at yet: Contact.");
  await expect(approve).toHaveAttribute("aria-disabled", "true");
  await pages.getByRole("button", { name: "Contact", exact: true }).click();
  await expect(gate).toHaveCount(0);
  await expect(approve).toHaveAttribute("aria-disabled", "false");
  await expect(approve).not.toHaveAttribute("aria-describedby", /.*/);
  await expect(page.getByText(UNLOCKED)).toHaveCount(1);
  await approve.click();
  await expect(page.getByText("Approved. We'll email the owner.", { exact: false })).toBeVisible();
  expect(approveRequests).toBe(1);
});

test("a version with no stored pages cannot be approved: Approve is off and described by the notice, and Reject works", async ({ page }) => {
  const site = await pendingSite(page.request);
  await page.route(`**/api/admin/versions/${site.versionId}`, async (route) => {
    const json = (await (await route.fetch()).json()) as object;
    await route.fulfill({ json: { ...json, pages: [] } });
  });
  await page.goto(`/reviews/${site.versionId}`);
  const note = "This version has no stored pages (it was sent before sites had several pages), so it cannot be approved.";
  await expect(page.getByText(note)).toBeVisible();
  const approve = page.getByRole("button", { name: "Approve and publish" });
  await expect(approve).toHaveAttribute("aria-disabled", "true");
  await expect(approve).toHaveAttribute("aria-describedby", "no-pages-note");
  await expect(page.locator("#no-pages-note")).toContainText(note);
  await approve.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Approved. We'll email the owner", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reject and email the owner" })).toBeEnabled();
});

test("Approve answers 'approved but not live yet' when the pointer write fails (the real seam); Copy the live pages again finishes it", async ({ page }) => {
  const site = await pendingSite(page.request);
  let faulted = false;
  await page.route("**/api/admin/versions/*/approve", (route, request) => {
    if (faulted) return route.continue();
    faulted = true;
    return route.continue({ headers: { ...request.headers(), "x-test-takedown-fault": "pointer-write" } });
  });
  await page.goto(`/reviews/${site.versionId}`);
  await showEveryPage(page);
  await page.getByRole("button", { name: "Approve and publish" }).click();
  await expect(page.getByText("Approved, but the new pages are not live yet. Press Approve again.")).toBeVisible();
  await expect(page.getByText(/status approved/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve and publish" })).toHaveAttribute("aria-disabled", "false"); // Approve stays, and so does the seen set
  await page.getByRole("button", { name: "Copy the live pages again" }).click();
  await expect(page.getByText("The live pages were copied again.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy the live pages again" })).toHaveCount(0);
});

// STRICT (honesty: what was approved is what is live): an approve that lost its lease AFTER the approval committed leaves D1 live with no
// pointer, so the site answers "not found". A reload must offer the way back, and it must heal.
test("Approve loses its lease after the approval committed: the site is live in D1 with no pointer; after a reload, Copy the live pages again is offered and heals it", async ({ page }) => {
  const site = await pendingSite(page.request);
  const live = async () => (await (await page.request.get(`${ADMIN}/__test/live/${site.slug}`)).json()) as { pointerVersionId: string | null; homeStored: boolean };
  await page.route("**/api/admin/versions/*/approve", (route, request) => route.continue({ headers: { ...request.headers(), "x-test-takedown-fault": "lease-lost-after-batch" } }));
  await page.goto(`/reviews/${site.versionId}`);
  await showEveryPage(page);
  await page.getByRole("button", { name: "Approve and publish" }).click();
  await expect(page.getByText("This approval ran too long and was stopped before it finished. Press Approve again to finish it and tell the owner.")).toBeVisible();
  // The reload after the answer shows the version as approved: wait for it, so the check below sees the settled page, not the one from before.
  await expect(page.getByText(/status approved/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve and publish" })).toHaveAttribute("aria-disabled", "false"); // Approve stays after a lost lease
  expect((await live()).pointerVersionId).toBeNull(); // the visitor's site is broken: pages copied, no pointer
  await page.goto(`/sites/${site.siteId}`); // the admin reloads
  await expect(page.getByText("live", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("Use this if the live site shows 'page not found' or older pages.")).toBeVisible();
  await page.getByRole("button", { name: "Copy the live pages again" }).click();
  await expect(page.getByText("The live pages were copied again.")).toBeVisible();
  expect(await live()).toEqual({ pointerVersionId: site.versionId, homeStored: true });
});

test("Copy the live pages again says when it fails, and offers itself again", async ({ page }) => {
  const site = await pendingSite(page.request);
  await page.route("**/api/admin/versions/*/approve", (route, request) => route.continue({ headers: { ...request.headers(), "x-test-takedown-fault": "pointer-write" } }));
  const copies: string[] = [];
  await page.route("**/api/admin/sites/*/copy-pages", (route, request) => {
    copies.push("copy");
    return copies.length === 1 ? route.continue({ headers: { ...request.headers(), "x-test-takedown-fault": "pointer-write" } }) : route.continue();
  });
  await page.goto(`/reviews/${site.versionId}`);
  await showEveryPage(page);
  await page.getByRole("button", { name: "Approve and publish" }).click();
  await page.getByRole("button", { name: "Copy the live pages again" }).click();
  await expect(page.getByText("The pages could not be copied again. Press Copy the live pages again.")).toBeVisible();
  await page.getByRole("button", { name: "Copy the live pages again" }).click();
  await expect(page.getByText("The live pages were copied again.")).toBeVisible();
});

// STRICT (admin gate: a restore must be of the takedown the admin saw): the page sends back the taken_down_at it showed.
test("Restore on a stale page, after the site was restored and taken down AGAIN, is refused with the taken-down-again text and the site stays down", async ({ page }) => {
  const site = await liveSite(page);
  await takeDown(page, site.siteId);
  await expect(page.getByRole("button", { name: "Restore the site" })).toBeVisible(); // this page shows the first takedown
  const shown = ((await (await page.request.get(`${ADMIN}/api/admin/sites/${site.siteId}`)).json()) as { takenDownAt: number }).takenDownAt;
  const headers = { Origin: ADMIN };
  // Another admin restores it, and takes it down again, while this page stays open.
  expect((await page.request.post(`${ADMIN}/api/admin/sites/${site.siteId}/restore`, { data: { expectedTakenDownAt: shown }, headers })).status()).toBe(200);
  expect((await page.request.post(`${ADMIN}/api/admin/sites/${site.siteId}/takedown`, { data: { reason: "Second report", ownerMessage: "", purgeMedia: false }, headers })).status()).toBe(200);
  await page.getByRole("button", { name: "Restore the site" }).click();
  await expect(page.getByText("This site was taken down again since you opened this page. Reload to see where it stands now.")).toBeVisible();
  const after = ((await (await page.request.get(`${ADMIN}/api/admin/sites/${site.siteId}`)).json()) as { takenDownAt: number | null }).takenDownAt;
  expect(after).toBeGreaterThan(shown); // still down, by the second takedown
  // The page reloaded itself: it now shows the second takedown, and Restore of THAT works.
  await page.getByRole("button", { name: "Restore the site" }).click();
  await expect(page.getByText("Site restored.")).toBeVisible();
});

test("Restore answers busy and lost-lease and failed-pointer in the admin's words", async ({ page }) => {
  const site = await liveSite(page);
  await takeDown(page, site.siteId);
  const answers = [
    { status: 409, headers: { "Retry-After": "42" }, json: { error: { code: "conflict", message: "Another admin action on this site is still running. Try again in a minute.", retryAfter: 42 } } },
    { status: 409, json: { error: { code: "conflict", message: "This action ran too long and was stopped before it finished. Reload to see where the site stands now, then try again." } } },
    { status: 500, json: { error: { code: "internal", message: "The site is still offline: its pages could not be put back. Press Restore again." } } },
  ];
  await page.route("**/api/admin/sites/*/restore", (route) => route.fulfill(answers.shift() ?? { status: 500, json: {} }));
  const restore = page.getByRole("button", { name: "Restore the site" });
  await restore.click();
  await expect(page.getByText("Another admin action on this site is still running. Try again in a minute.")).toBeVisible();
  await restore.click();
  await expect(page.getByText("This action ran too long and was stopped before it finished.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy the live pages again" })).toHaveCount(0); // the site is down: Restore is the way, not Copy
  await restore.click();
  await expect(page.getByText("The site is still offline: its pages could not be put back. Press Restore again.")).toBeVisible();
  await expect(restore).toBeVisible(); // Restore stays active
});

test("a restore that lost its lease on a site that is live by the time the page reloads offers Copy the live pages again, which works", async ({ page }) => {
  const site = await liveSite(page);
  const takedownAnswered = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/takedown"));
  await takeDown(page, site.siteId); // this page shows the takedown and Restore
  expect((await takedownAnswered).status()).toBe(200); // wait for the takedown's answer: reading takenDownAt earlier raced it (Q-11)
  await expect(page.getByRole("button", { name: "Restore the site" })).toBeVisible(); // the takedown has committed: takenDownAt below is its moment, not null
  const shown = ((await (await page.request.get(`${ADMIN}/api/admin/sites/${site.siteId}`)).json()) as { takenDownAt: number }).takenDownAt;
  // Another admin's restore went through meanwhile; this page's own Restore is answered "lost its lease" (the rare case in the contract).
  expect((await page.request.post(`${ADMIN}/api/admin/sites/${site.siteId}/restore`, { data: { expectedTakenDownAt: shown }, headers: { Origin: ADMIN } })).status()).toBe(200);
  await page.route("**/api/admin/sites/*/restore", (route) =>
    route.fulfill({ status: 409, json: { error: { code: "conflict", message: "This action ran too long and was stopped before it finished. Reload to see where the site stands now, then try again." } } }),
  );
  await page.getByRole("button", { name: "Restore the site" }).click();
  await expect(page.getByText("This action ran too long and was stopped before it finished.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Copy the live pages again" }).click(); // the reload showed a live site, which has no Restore
  await expect(page.getByText("The live pages were copied again.")).toBeVisible();
});

// Bold ("impact", the design of Joe's Plumbing) embeds a real face, "Archivo Condensed", as a data: woff2 in the page's own stylesheet. The admin's
// CSP has `font-src 'self' data:` and the srcdoc frame inherits it: this proves the real face LOADS inside the review's frame, and that an
// element of the stored page has it as its family. The page is the stored one, untouched.
test("Bold's real face, Archivo Condensed, loads inside the review's preview frame (the admin policy allows font-src data:)", async ({ page }) => {
  const violations = await watchCsp(page);
  const site = await pendingSite(page.request);
  await page.goto(`/reviews/${site.versionId}`);
  await expect(page.frameLocator(FRAME).locator(".display").first()).toBeAttached();
  const frame = page.frames().find((f) => f !== page.mainFrame() && f.url() === "about:srcdoc");
  expect(frame).toBeDefined();
  const proof = await frame!.locator(".display").first().evaluate(async (element) => {
    await document.fonts.load('800 16px "Archivo Condensed"', "A").catch(() => []);
    await document.fonts.ready;
    return {
      faces: [...document.fonts].map((face) => `${face.family.replaceAll('"', "")} ${face.status}`),
      family: getComputedStyle(element).fontFamily,
    };
  });
  expect(proof.faces).toEqual(["Archivo Condensed loaded"]);
  expect(proof.family.replaceAll('"', "").startsWith("Archivo Condensed")).toBe(true); // engines may quote the family differently
  expect(await violations()).toEqual([]);
});

test("send and revoke an invite; the link is never shown", async ({ page }) => {
  const email = `invitee-${Date.now()}@example.com`;
  await page.goto("/invites");
  await expect(page.getByRole("heading", { level: 1, name: "Invites" })).toBeFocused();
  await expectAccessible(page);
  await page.getByLabel("Owner's email address").fill(email);
  await page.getByRole("button", { name: "Send invite" }).click();
  await expect(page.getByText(`Invite emailed to ${email}.`)).toBeVisible();
  await expect(page.locator("body")).not.toContainText("/invite#");
  await page.getByRole("button", { name: `Revoke invite for ${email}` }).click();
  await expect(page.getByText(`Invite for ${email} revoked.`)).toBeVisible();
});

test("take a live site down after confirming, then restore it", async ({ page }) => {
  const site = await liveSite(page);

  await page.goto("/sites");
  await page.getByLabel("Show").selectOption("live");
  await page.getByLabel("Search").fill(site.slug);
  await expect(page.getByRole("link", { name: /^Open / })).toHaveCount(1);
  await page.getByRole("link", { name: `Open ${site.slug}` }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Joe's Plumbing" })).toBeFocused();
  await expectAccessible(page);
  await expect(page.getByText("search engines allowed")).toBeVisible();
  await page.getByRole("button", { name: "Block search engines" }).click();
  await expect(page.getByText("Search engines are now blocked.")).toBeVisible();
  await expect(page.getByText("search engines blocked")).toBeVisible();
  await page.getByRole("button", { name: "Allow search engines" }).click();
  await expect(page.getByText("Search engines are now allowed.")).toBeVisible();
  await page.getByRole("button", { name: "Take the site down" }).click();
  await expect(page.getByLabel("Reason for taking it down")).toBeFocused();
  await page.getByLabel("Reason for taking it down").fill("Phishing report");
  await page.getByRole("button", { name: "Take the site down" }).click();
  await page.getByRole("dialog", { name: "Take this site down?" }).getByRole("button", { name: "Take it down" }).click();
  const status = page.getByRole("status").filter({ hasText: "Site taken down. It stops being served within about a minute." });
  await expect(status).toBeVisible();
  await expect(status).not.toContainText("Owner not emailed");
  await expect(status).not.toContainText("Clean-up");
  await page.getByRole("button", { name: "Restore the site" }).click();
  await expect(page.getByText("Site restored.")).toBeVisible();
});

async function takeDown(page: Page, siteId: string) {
  await page.goto(`/sites/${siteId}`);
  await page.getByLabel("Reason for taking it down").fill("Phishing report");
  await page.getByRole("button", { name: "Take the site down" }).click();
  await page.getByRole("dialog", { name: "Take this site down?" }).getByRole("button", { name: "Take it down" }).click();
}

/** The withdrawn "tick the box again" hint (DECIDED withdrawn 2026-10-07: it could steer a purge onto a takedown the page cannot attribute): no screen may show it. */
const PURGE_HINT = "To delete the photos";

/** The down-site form is the only Finish: fills its reason and presses it. */
async function finishFromForm(page: Page, reason: string) {
  await page.getByLabel("Reason for finishing the takedown").fill(reason);
  await page.getByRole("button", { name: "Finish the takedown" }).click();
}

test("a takedown whose owner email failed says to contact the owner", async ({ page }) => {
  const site = await liveSite(page, { emailDomain: "mail-fails.example" });
  await takeDown(page, site.siteId);
  await expect(page.getByText("Site taken down. It stops being served within about a minute. Owner not emailed — contact them.")).toBeVisible();
});

test("a takedown whose clean-up failed says so, and Finish the takedown finishes it without a second notice", async ({ page }) => {
  const site = await liveSite(page);
  let faulted = false;
  await page.route("**/api/admin/sites/*/takedown", (route, request) => {
    if (faulted) return route.continue();
    faulted = true;
    return route.continue({ headers: { ...request.headers(), "x-test-takedown-fault": "prefix-delete" } });
  });
  await takeDown(page, site.siteId);
  await expect(page.getByText("Clean-up did not finish. The site is offline; old page files stay in storage until you finish it.")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("nothing from it is shown");
  await expect(page.locator("body")).not.toContainText(PURGE_HINT);
  await expect(page.getByRole("status").getByRole("button", { name: "Finish the takedown" })).toHaveCount(0); // nothing is held in the result: the down-site form is the only Finish
  await expect(page.getByRole("button", { name: "Finish the takedown" })).toHaveCount(1);
  await finishFromForm(page, "Finish after failed clean-up");
  await expect(page.getByText("Clean-up finished.")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Owner not emailed");
});

test("a takedown that fails before it commits says it did not go through", async ({ page }) => {
  const site = await liveSite(page);
  await page.route("**/api/admin/sites/*/takedown", (route) => route.fulfill({ status: 500, json: { error: { code: "internal", message: "Something went wrong. Please try again." } } }));
  await takeDown(page, site.siteId);
  await expect(page.getByText("The takedown did not go through. Try again.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Finish the takedown" })).toHaveCount(0);
});

test("a takedown sends exactly what the admin entered: the reason, the owner message, and whether photos are deleted", async ({ page }) => {
  const bodies: unknown[] = [];
  await page.route("**/api/admin/sites/*/takedown", (route, request) => {
    bodies.push(request.postDataJSON());
    return route.continue();
  });
  const plain = await liveSite(page);
  await takeDown(page, plain.siteId);
  await expect(page.getByText("Site taken down.", { exact: false })).toBeVisible();
  expect(bodies).toEqual([{ reason: "Phishing report", ownerMessage: "", purgeMedia: false }]);

  const purged = await liveSite(page);
  await page.goto(`/sites/${purged.siteId}`);
  await page.getByLabel("Reason for taking it down").fill("Copyright claim");
  await page.getByLabel("Message to the owner").fill("Please send proof of the photos.");
  await page.getByLabel("Also delete this site's photos").check();
  await page.getByRole("button", { name: "Take the site down" }).click();
  const dialog = page.getByRole("dialog", { name: "Take this site down?" });
  await expect(dialog).toContainText("its photos are deleted");
  await dialog.getByRole("button", { name: "Take it down" }).click();
  await expect(page.getByText("Site taken down.", { exact: false })).toBeVisible();
  expect(bodies[1]).toEqual({ reason: "Copyright claim", ownerMessage: "Please send proof of the photos.", purgeMedia: true });
});

test("a takedown that errors AFTER the site went down offers Finish the takedown, which sends the same body and says the owner was not emailed", async ({ page }) => {
  const site = await liveSite(page);
  const bodies: unknown[] = [];
  let faulted = false;
  await page.route("**/api/admin/sites/*/takedown", (route, request) => {
    bodies.push(request.postDataJSON());
    if (faulted) return route.continue();
    faulted = true;
    // The server commits the takedown in D1, then fails on LIVE (and on its re-read): a real 500, and no owner notice.
    return route.continue({ headers: { ...request.headers(), "x-test-takedown-fault": "prefix-delete-reread" } });
  });
  await takeDown(page, site.siteId);
  await expect(page.getByText("The takedown may have partly happened, and the owner may not have been emailed. Finish it to make sure, and contact the owner:")).toBeVisible();
  await expect(page.getByRole("button", { name: "Restore the site" })).toBeVisible(); // the reload shows it down
  await expect(page.getByRole("status").filter({ hasText: "The takedown may have partly happened" })).toBeFocused(); // keyboard focus stays on the result
  await expect(page.getByRole("status").getByRole("button", { name: "Finish the takedown" })).toHaveCount(0); // the down-site form is the only Finish
  await finishFromForm(page, "Finish after a 500");
  await expect(page.getByText("Clean-up finished.", { exact: false })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Owner not emailed"); // the Finish answer never turns the hedged wording definite
  await expect(page.getByRole("button", { name: "Finish the takedown" })).toHaveCount(1); // exactly one Finish control on the page: the form's
  expect(bodies).toHaveLength(2);
  // Finish sends what its own form holds plus the takedown moment the page showed (takedown-truth B).
  expect(bodies[1]).toEqual({ reason: "Finish after a 500", purgeMedia: false, expectedTakenDownAt: expect.any(Number) });
});

// m6, then takedown-truth (A): a takedown's lease can run out after its commit. The text says so; the SERVER has already told the owner (once), and Finish the takedown only finishes the clean-up.
test("a takedown that loses its lease after the commit says so, the owner is told once by the server, and Finish the takedown clears the pages without a second notice", async ({ page }) => {
  const site = await liveSite(page);
  const notices = async () => ((await (await page.request.get(`${ADMIN}/__test/outbox?to=${encodeURIComponent(site.email)}`)).json()) as Array<{ tag: string }>).filter((m) => m.tag === "site_notice").length;
  const urls: string[] = [];
  await page.route("**/api/admin/sites/*/takedown*", (route, request) => {
    urls.push(request.url());
    return urls.length === 1 ? route.continue({ headers: { ...request.headers(), "x-test-takedown-fault": "lease-lost-after-batch" } }) : route.continue();
  });
  await takeDown(page, site.siteId);
  await expect(page.getByText("This takedown ran too long and was stopped before it finished. Reload; if the site shows as taken down, press Finish the takedown.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Restore the site" })).toBeVisible(); // the reload shows it down
  expect(await notices()).toBe(1); // the route sent it, though the call lost its lease
  await expect(page.getByRole("status").getByRole("button", { name: "Finish the takedown" })).toHaveCount(0); // the down-site form is the only Finish
  await finishFromForm(page, "Finish after a lost lease");
  await expect(page.getByText("Clean-up finished.", { exact: false })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Owner not emailed");
  await expect(page.getByRole("button", { name: "Finish the takedown" })).toHaveCount(1); // exactly one Finish control on the page: the form's
  expect(await notices()).toBe(1);
  expect(urls[1]).not.toContain("notice=due");
});

// takedown-residuals: a lost lease must not hide that the owner notice FAILED: the 409 carries noticeSent false and the page says so, and Finish keeps saying it.
test("a takedown that loses its lease after the commit with a failed owner email says the owner was not emailed", async ({ page }) => {
  const site = await liveSite(page, { emailDomain: "mail-fails.example" });
  const urls: string[] = [];
  await page.route("**/api/admin/sites/*/takedown*", (route, request) => {
    urls.push(request.url());
    return urls.length === 1 ? route.continue({ headers: { ...request.headers(), "x-test-takedown-fault": "lease-lost-after-batch" } }) : route.continue();
  });
  await takeDown(page, site.siteId);
  await expect(page.getByText("This takedown ran too long and was stopped before it finished.", { exact: false })).toBeVisible();
  await expect(page.getByText("Owner not emailed — contact them.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Restore the site" })).toBeVisible(); // the reload shows it down
  await expect(page.getByRole("status").getByRole("button", { name: "Finish the takedown" })).toHaveCount(0); // nothing is held: the form is the only Finish
});

test("a Finish that fails after an emailed takedown never claims the owner was not emailed", async ({ page }) => {
  const site = await liveSite(page);
  const faults = ["prefix-delete", "prefix-delete-reread", null];
  await page.route("**/api/admin/sites/*/takedown", (route, request) => {
    const fault = faults.shift();
    return route.continue(fault ? { headers: { ...request.headers(), "x-test-takedown-fault": fault } } : undefined);
  });
  await takeDown(page, site.siteId); // 200, owner emailed, clean-up failed
  await finishFromForm(page, "Finish that fails"); // 500
  await expect(page.getByText("The takedown may have partly happened", { exact: false })).toBeVisible();
  await finishFromForm(page, "Finish again"); // 200: every answer reset the form, so the reason is typed again
  await expect(page.getByText("Clean-up finished.", { exact: false })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Owner not emailed");
});

// #55: a stale LIVE pointer can stay on a down site; the admin re-runs the takedown from the page, after a reload too, and the owner is not emailed again.
test("a down site shows Finish the takedown after a reload; it needs a reason, re-runs the takedown, audits it, and sends no second notice", async ({ page }) => {
  const site = await liveSite(page);
  const notices = async () => ((await (await page.request.get(`${ADMIN}/__test/outbox?to=${encodeURIComponent(site.email)}`)).json()) as Array<{ tag: string }>).filter((m) => m.tag === "site_notice").length;
  const posts: string[] = [];
  const bodies: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/takedown")) {
      posts.push(request.url());
      bodies.push(request.postDataJSON());
    }
  });
  await takeDown(page, site.siteId);
  await expect(page.getByRole("button", { name: "Restore the site" })).toBeVisible();
  await page.reload();
  const finish = page.getByRole("button", { name: "Finish the takedown" });
  await expect(finish).toHaveCount(1); // one control only
  await expect(page.getByLabel("Reason for finishing the takedown")).toBeVisible();
  await expect(page.getByLabel("Also delete this site's photos")).not.toBeChecked();
  await expect(page.getByLabel("Message to the owner")).toHaveCount(0);
  await expectAccessible(page);
  expect(posts).toHaveLength(1); // the original takedown only

  await finish.click(); // empty reason
  await expect(page.getByText("Write the reason. It is kept in the audit log.")).toBeVisible();
  await expect(page.getByLabel("Reason for finishing the takedown")).toBeFocused();
  expect(posts).toHaveLength(1);

  await page.getByLabel("Reason for finishing the takedown").fill("Stale pointer check");
  const answer = page.waitForResponse((r) => r.url().includes("/takedown") && r.request().method() === "POST");
  await finish.click();
  expect((await answer).status()).toBe(200);
  expect(posts).toHaveLength(2);
  expect(posts[1]).not.toContain("notice=due");
  expect(bodies[1]).toEqual({ reason: "Stale pointer check", purgeMedia: false, expectedTakenDownAt: expect.any(Number) });
  await expect(page.getByText("Clean-up finished.", { exact: false })).toBeVisible(); // a re-run says the clean-up text, not the first takedown's
  await expect(page.getByText("Site taken down.", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Restore the site" })).toBeVisible(); // still down
  const detail = (await (await page.request.get(`${ADMIN}/api/admin/sites/${site.siteId}`)).json()) as { audit: Array<{ action: string; detail: { reason?: string; repeat?: boolean } | null }> };
  expect(detail.audit.filter((a) => a.action === "site.taken_down" && a.detail?.reason === "Stale pointer check" && a.detail.repeat === true)).toHaveLength(1);
  expect(await notices()).toBe(1);
});

const siteNotices = async (page: Page, email: string) =>
  ((await (await page.request.get(`${ADMIN}/__test/outbox?to=${encodeURIComponent(email)}`)).json()) as Array<{ tag: string }>).filter((m) => m.tag === "site_notice").length;
type SiteView = { takenDownAt: number | null; audit: Array<{ action: string; detail: { repeat?: boolean } | null }> };
const siteView = async (page: Page, siteId: string) => (await (await page.request.get(`${ADMIN}/api/admin/sites/${siteId}`)).json()) as SiteView;
const takedownAudits = (view: SiteView) => view.audit.filter((a) => a.action === "site.taken_down");

// STRICT (honesty): a lease lost AND a failed re-read leave the notice outcome UNKNOWN (the 409 says noticeUnknown). After the reload the page says what it can know, never the definite "Owner not emailed".
test("a lost lease with a failed re-read, the reload showing the site DOWN, says the owner may not have been emailed (not the definite line), and the form still offers the clean-up", async ({ page }) => {
  const site = await liveSite(page);
  let posts = 0;
  await page.route("**/api/admin/sites/*/takedown", (route, request) => (++posts === 1 ? route.continue({ headers: { ...request.headers(), "x-test-takedown-fault": "lease-lost-after-batch-reread" } }) : route.continue()));
  await takeDown(page, site.siteId);
  await expect(page.getByText("The takedown may have partly happened, and the owner may not have been emailed. Finish it to make sure, and contact the owner:")).toBeVisible();
  await expect(page.getByRole("button", { name: "Restore the site" })).toBeVisible(); // the reload shows it down
  await expect(page.locator("body")).not.toContainText("Owner not emailed — contact them.");
  await expect(page.getByRole("status").getByRole("button", { name: "Finish the takedown" })).toHaveCount(0);
  await expect(page.getByLabel("Reason for finishing the takedown")).toBeVisible(); // the down-site form offers the clean-up
});

test("a lost lease with a failed re-read, the reload showing the site UP, says the takedown did not go through, with no owner line and no Finish", async ({ page }) => {
  const site = await liveSite(page);
  let posts = 0;
  await page.route("**/api/admin/sites/*/takedown", (route, request) => (++posts === 1 ? route.continue({ headers: { ...request.headers(), "x-test-takedown-fault": "lease-lost-before-batch-reread" } }) : route.continue()));
  await takeDown(page, site.siteId);
  await expect(page.getByText("The takedown did not go through. Try again.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Take the site down" })).toBeVisible(); // the reload shows it up
  await expect(page.locator("body")).not.toContainText("Owner not emailed");
  await expect(page.locator("body")).not.toContainText("may not have been emailed");
  await expect(page.getByRole("button", { name: "Finish the takedown" })).toHaveCount(0);
});

// takedown-truth (B), QA Q-1: Finish from a stale page must not take a restored site down again or email the owner again.
test("a down-site page's Finish after another tab restored the site is refused: the text, no notice, no audit row, the site stays up", async ({ page }) => {
  const site = await liveSite(page);
  await page.goto(`/sites/${site.siteId}`);
  await page.getByLabel("Reason for taking it down").fill("Phishing report");
  await page.getByRole("button", { name: "Take the site down" }).click();
  // Wait for the takedown's answer (a state, not the clock) before looking for the Restore button; the waiter is registered before the click.
  const takenDown = page.waitForResponse((r) => r.url().includes("/takedown") && r.request().method() === "POST");
  await page.getByRole("dialog", { name: "Take this site down?" }).getByRole("button", { name: "Take it down" }).click();
  expect((await takenDown).status()).toBe(200);
  await expect(page.getByRole("button", { name: "Restore the site" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Finish the takedown" })).toHaveCount(1);
  const other = await page.context().newPage();
  await other.goto(`/sites/${site.siteId}`);
  await other.getByRole("button", { name: "Restore the site" }).click();
  await expect(other.getByText("Site restored.")).toBeVisible();
  await other.close();
  const before = takedownAudits(await siteView(page, site.siteId)).length;
  expect(await siteNotices(page, site.email)).toBe(1);

  await page.getByLabel("Reason for finishing the takedown").fill("Stale finish");
  const answer = page.waitForResponse((r) => r.url().includes("/takedown") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Finish the takedown" }).click();
  expect((await answer).status()).toBe(409);
  await expect(page.getByText("This site was restored since you opened this page. Reload to see where it stands now.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Take the site down" })).toBeVisible(); // the reload shows the site up
  const after = await siteView(page, site.siteId);
  expect(after.takenDownAt).toBeNull();
  expect(takedownAudits(after)).toHaveLength(before);
  expect(await siteNotices(page, site.email)).toBe(1);
});

const uploadsOf = async (page: Page, siteId: string) => (await (await page.request.get(`${ADMIN}/__test/uploads?siteId=${siteId}`)).json()) as { deletedAt: Array<number | null>; objects: number };
const KEPT = { deletedAt: [null], objects: 1 };
const addPhoto = async (page: Page, siteId: string) => {
  expect((await page.request.post(`${ADMIN}/__test/uploads`, { data: { siteId } })).ok()).toBe(true);
  expect(await uploadsOf(page, siteId)).toEqual(KEPT);
};
const adminHeaders = { Origin: ADMIN };
const apiRestore = (page: Page, siteId: string, expectedTakenDownAt: number) =>
  page.request.post(`${ADMIN}/api/admin/sites/${siteId}/restore`, { data: { expectedTakenDownAt }, headers: adminHeaders });
const apiTakeDown = (page: Page, siteId: string, data: object) => page.request.post(`${ADMIN}/api/admin/sites/${siteId}/takedown`, { data, headers: adminHeaders });

/** Another admin restores the site and takes it down AGAIN without the purge (T2: it chose to keep the photos). */
async function otherAdminRetakesWithoutPurge(page: Page, siteId: string) {
  const first = (await siteView(page, siteId)).takenDownAt;
  expect((await apiRestore(page, siteId, first!)).status()).toBe(200);
  expect((await apiTakeDown(page, siteId, { reason: "Second report, keep photos", ownerMessage: "", purgeMedia: false })).status()).toBe(200);
  expect((await siteView(page, siteId)).takenDownAt).toBeGreaterThan(first!);
}

/** The first takedown POST reaches the server with `fault`; the call's answer is held back until another admin has restored the site and taken it down again without the purge. */
async function otherAdminActsBeforeTheAnswer(page: Page, siteId: string, fault: string) {
  let posts = 0;
  await page.route("**/api/admin/sites/*/takedown", async (route, request) => {
    if (++posts !== 1) return route.continue();
    const answer = await route.fetch({ headers: { ...request.headers(), "x-test-takedown-fault": fault } });
    await otherAdminRetakesWithoutPurge(page, siteId);
    await route.fulfill({ response: answer });
  });
}

async function takeDownWithPurge(page: Page, siteId: string, purge = true) {
  await page.goto(`/sites/${siteId}`);
  await page.getByLabel("Reason for taking it down").fill("Copyright claim");
  if (purge) await page.getByLabel("Also delete this site's photos").check();
  await page.getByRole("button", { name: "Take the site down" }).click();
  await page.getByRole("dialog", { name: "Take this site down?" }).getByRole("button", { name: "Take it down" }).click();
}

// STRICT (customer data): there is no held Finish. A takedown that asked to delete photos whose answer is a lost lease, a clean-up failure or a 500 must never
// bind its purge to ANOTHER admin's newer takedown: when the page reloads and shows that takedown, the only Finish is the down-site form, its box unticked.
for (const [label, fault] of [
  ["lost its lease (409)", "lease-lost-after-batch"],
  ["finished with its clean-up failed (200)", "prefix-delete"],
  ["answered 500", "prefix-delete-reread"],
] as const) {
  test(`a purging takedown that ${label}, whose answer reaches the page after another admin restored and re-took down WITHOUT purge, leaves no held Finish and keeps the photos`, async ({ page }) => {
    const site = await liveSite(page);
    await addPhoto(page, site.siteId);
    await otherAdminActsBeforeTheAnswer(page, site.siteId, fault);
    await takeDownWithPurge(page, site.siteId);
    await expect(page.getByRole("button", { name: "Restore the site" })).toBeVisible(); // the reload shows the newer takedown
    await expect(page.getByRole("status").getByRole("button", { name: "Finish the takedown" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Finish the takedown" })).toHaveCount(1); // the form's
    await expect(page.getByLabel("Also delete this site's photos")).not.toBeChecked();
    await expect(page.locator("body")).not.toContainText(PURGE_HINT); // no hint steers a purge onto the takedown the page cannot attribute
    expect(await uploadsOf(page, site.siteId)).toEqual(KEPT);
    // The one Finish there is sends the form's own choice (unticked) for the takedown the page shows: 200, and the photos stay.
    const answer = page.waitForResponse((r) => r.url().includes("/takedown") && r.request().method() === "POST");
    await finishFromForm(page, "Finish the second takedown");
    expect((await answer).status()).toBe(200);
    expect(await uploadsOf(page, site.siteId)).toEqual(KEPT);
  });
}

test("a down-site form's Finish with the photos box ticked, pressed after another admin restored and re-took down without purge, is refused, and the photos are kept", async ({ page }) => {
  const site = await liveSite(page);
  await addPhoto(page, site.siteId);
  await takeDownWithPurge(page, site.siteId, false);
  await expect(page.getByRole("button", { name: "Restore the site" })).toBeVisible();
  await page.reload(); // the form, bound to the first takedown
  await otherAdminRetakesWithoutPurge(page, site.siteId);
  await page.getByLabel("Also delete this site's photos").check();
  const answer = page.waitForResponse((r) => r.url().includes("/takedown") && r.request().method() === "POST");
  await finishFromForm(page, "Stale finish with purge");
  expect((await answer).status()).toBe(409);
  await expect(page.getByText("This site was restored since you opened this page. Reload to see where it stands now.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Restore the site" })).toBeVisible();
  expect(await uploadsOf(page, site.siteId)).toEqual(KEPT);
  // THE RULE: the form now shows the OTHER admin's takedown. Its fields are born empty and unticked, so the SECOND press cannot carry the refused tick.
  await expect(page.getByLabel("Also delete this site's photos")).not.toBeChecked();
  await expect(page.getByLabel("Reason for finishing the takedown")).toHaveValue("");
  const second = page.waitForResponse((r) => r.url().includes("/takedown") && r.request().method() === "POST");
  await finishFromForm(page, "Finish the second takedown");
  expect((await second).status()).toBe(200);
  expect(await uploadsOf(page, site.siteId)).toEqual(KEPT);
});

// THE RULE (DECIDED 2026-10-07): "Every admin action form is opened for ONE site state. Its fields are born empty and unticked for that state, and reset
// after every answer. Nothing typed or ticked for one takedown can reach another." (x1: a refused tick reaches a second takedown.)
test("a Finish refused as stale does not carry its tick or reason onto the other admin's takedown: the second press keeps the photos", async ({ page }) => {
  const site = await liveSite(page);
  await addPhoto(page, site.siteId);
  expect((await apiTakeDown(page, site.siteId, { reason: "T1", purgeMedia: false })).status()).toBe(200);
  await page.goto(`/sites/${site.siteId}`); // the form, opened for T1
  await expect(page.getByRole("button", { name: "Restore the site" })).toBeVisible();
  const t1 = (await siteView(page, site.siteId)).takenDownAt!;
  await otherAdminRetakesWithoutPurge(page, site.siteId); // T2: the other admin chose to keep the photos
  const t2 = (await siteView(page, site.siteId)).takenDownAt!;
  const bodies: Array<Record<string, unknown>> = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/takedown")) bodies.push(r.postDataJSON() as Record<string, unknown>);
  });
  await page.getByLabel("Also delete this site's photos").check();
  const first = page.waitForResponse((r) => r.url().includes("/takedown") && r.request().method() === "POST");
  await finishFromForm(page, "Finish T1 and delete photos");
  expect((await first).status()).toBe(409);
  expect(bodies[0]).toEqual({ reason: "Finish T1 and delete photos", purgeMedia: true, expectedTakenDownAt: t1 });
  await expect(page.getByText("This site was restored since you opened this page. Reload to see where it stands now.")).toBeVisible();
  await expect(page.getByLabel("Also delete this site's photos")).not.toBeChecked(); // the reload shows T2: unticked and empty
  await expect(page.getByLabel("Reason for finishing the takedown")).toHaveValue("");
  const second = page.waitForResponse((r) => r.url().includes("/takedown") && r.request().method() === "POST");
  await finishFromForm(page, "Finish T2");
  expect((await second).status()).toBe(200);
  expect(bodies[1]).toEqual({ reason: "Finish T2", purgeMedia: false, expectedTakenDownAt: t2 });
  expect(await uploadsOf(page, site.siteId)).toEqual(KEPT);
});

// The form is KEYED by the takedown it was opened for: a tick and a reason typed for T1 and never sent are gone when the page next shows T2.
test("a tick and a reason typed on the Finish form for one takedown are gone when the page next shows another admin's takedown", async ({ page }) => {
  const site = await liveSite(page);
  await addPhoto(page, site.siteId);
  expect((await apiTakeDown(page, site.siteId, { reason: "T1", purgeMedia: false })).status()).toBe(200);
  await page.goto(`/sites/${site.siteId}`);
  await page.getByLabel("Also delete this site's photos").check();
  await page.getByLabel("Reason for finishing the takedown").fill("Typed for T1");
  await otherAdminRetakesWithoutPurge(page, site.siteId);
  await page.getByRole("button", { name: "Block search engines" }).click(); // an in-app reload: the page now shows T2
  await expect(page.getByText("Search engines are now blocked.")).toBeVisible();
  await expect(page.getByLabel("Also delete this site's photos")).not.toBeChecked();
  await expect(page.getByLabel("Reason for finishing the takedown")).toHaveValue("");
  expect(await uploadsOf(page, site.siteId)).toEqual(KEPT);
});

// x2: the form resets after EVERY answer, so nothing typed or ticked for one press can ride on the next.
for (const [label, fault, status] of [
  ["a clean-up that failed again (200)", "prefix-delete", 200],
  ["a lost lease (409)", "lease-lost-after-batch", 409],
] as const) {
  test(`the Finish form with the photos box ticked is reset after ${label}: unticked and empty, the next Finish keeps the photos`, async ({ page }) => {
    const site = await liveSite(page);
    await addPhoto(page, site.siteId);
    // T1 leaves its LIVE clean-up undone, so the Finish below has pages to delete and its own prefix-delete fault fires.
    const t1 = await page.request.post(`${ADMIN}/api/admin/sites/${site.siteId}/takedown`, { data: { reason: "T1", purgeMedia: false }, headers: { ...adminHeaders, "x-test-takedown-fault": "prefix-delete" } });
    expect(t1.status()).toBe(200);
    let posts = 0;
    const bodies: Array<Record<string, unknown>> = [];
    await page.route("**/api/admin/sites/*/takedown", (route, request) => {
      bodies.push(request.postDataJSON() as Record<string, unknown>);
      return ++posts === 1 ? route.continue({ headers: { ...request.headers(), "x-test-takedown-fault": fault } }) : route.continue();
    });
    await page.goto(`/sites/${site.siteId}`);
    await page.getByLabel("Also delete this site's photos").check();
    const first = page.waitForResponse((r) => r.url().includes("/takedown") && r.request().method() === "POST");
    await finishFromForm(page, "Finish and delete photos");
    expect((await first).status()).toBe(status);
    expect(bodies[0]).toMatchObject({ purgeMedia: true });
    await expect(page.getByLabel("Also delete this site's photos")).not.toBeChecked(); // reset, not left ticked
    await expect(page.getByLabel("Reason for finishing the takedown")).toHaveValue("");
    await expect(page.locator("body")).not.toContainText(PURGE_HINT); // the withdrawn hint
    expect(await uploadsOf(page, site.siteId)).toEqual(KEPT);
    const second = page.waitForResponse((r) => r.url().includes("/takedown") && r.request().method() === "POST");
    await finishFromForm(page, "Finish again");
    expect((await second).status()).toBe(200);
    expect(bodies[1]).toMatchObject({ reason: "Finish again", purgeMedia: false });
    await expect(page.getByText("Clean-up finished.", { exact: false })).toBeVisible();
    expect(await uploadsOf(page, site.siteId)).toEqual(KEPT);
  });
}

// x3: the up-site takedown form is born empty for each site state, and resets after every answer.
test("the takedown form is empty and unticked after an in-page Restore", async ({ page }) => {
  const site = await liveSite(page);
  await page.goto(`/sites/${site.siteId}`);
  await page.getByLabel("Reason for taking it down").fill("First reason");
  await page.getByLabel("Message to the owner").fill("First message");
  await page.getByLabel("Also delete this site's photos").check();
  await page.getByRole("button", { name: "Take the site down" }).click();
  await page.getByRole("dialog", { name: "Take this site down?" }).getByRole("button", { name: "Take it down" }).click();
  await expect(page.getByRole("button", { name: "Restore the site" })).toBeVisible();
  await page.getByRole("button", { name: "Restore the site" }).click();
  await expect(page.getByRole("button", { name: "Take the site down" })).toBeVisible();
  await expect(page.getByLabel("Reason for taking it down")).toHaveValue("");
  await expect(page.getByLabel("Message to the owner")).toHaveValue("");
  await expect(page.getByLabel("Also delete this site's photos")).not.toBeChecked();
});

test("a takedown that did not go through resets the takedown form: nothing typed or ticked for it is left for the retry", async ({ page }) => {
  const site = await liveSite(page);
  let posts = 0;
  await page.route("**/api/admin/sites/*/takedown", (route, request) => (++posts === 1 ? route.continue({ headers: { ...request.headers(), "x-test-takedown-fault": "lease-lost-before-batch-reread" } }) : route.continue()));
  await page.goto(`/sites/${site.siteId}`);
  await page.getByLabel("Reason for taking it down").fill("Copyright claim");
  await page.getByLabel("Message to the owner").fill("Please send proof.");
  await page.getByLabel("Also delete this site's photos").check();
  await page.getByRole("button", { name: "Take the site down" }).click();
  await page.getByRole("dialog", { name: "Take this site down?" }).getByRole("button", { name: "Take it down" }).click();
  await expect(page.getByText("The takedown did not go through. Try again.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Take the site down" })).toBeVisible(); // still up
  await expect(page.getByLabel("Reason for taking it down")).toHaveValue("");
  await expect(page.getByLabel("Message to the owner")).toHaveValue("");
  await expect(page.getByLabel("Also delete this site's photos")).not.toBeChecked();
});

test("a takedown form filled for an up site is empty again once another admin has taken the site down and restored it", async ({ page }) => {
  const site = await liveSite(page);
  await page.goto(`/sites/${site.siteId}`);
  await page.getByLabel("Reason for taking it down").fill("Typed before");
  await page.getByLabel("Message to the owner").fill("Message before");
  await page.getByLabel("Also delete this site's photos").check();
  expect((await apiTakeDown(page, site.siteId, { reason: "Other admin", purgeMedia: false })).status()).toBe(200);
  expect((await apiRestore(page, site.siteId, (await siteView(page, site.siteId)).takenDownAt!)).status()).toBe(200);
  await page.getByRole("button", { name: "Block search engines" }).click(); // an in-app reload: the page shows the site up again, in a new state
  await expect(page.getByText("Search engines are now blocked.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Take the site down" })).toBeVisible();
  await expect(page.getByLabel("Reason for taking it down")).toHaveValue("");
  await expect(page.getByLabel("Message to the owner")).toHaveValue("");
  await expect(page.getByLabel("Also delete this site's photos")).not.toBeChecked();
});

test("ticking the fresh Finish box still deletes the photos of the takedown the page shows", async ({ page }) => {
  const site = await liveSite(page);
  await addPhoto(page, site.siteId);
  await takeDownWithPurge(page, site.siteId, false);
  await expect(page.getByRole("button", { name: "Restore the site" })).toBeVisible();
  await page.getByLabel("Also delete this site's photos").check();
  const answer = page.waitForResponse((r) => r.url().includes("/takedown") && r.request().method() === "POST");
  await finishFromForm(page, "Delete the photos now");
  expect((await answer).status()).toBe(200);
  await expect.poll(async () => (await uploadsOf(page, site.siteId)).objects).toBe(0);
});

// The withdrawn hint (x2/x4): no answer, in any state, tells the admin to tick the box again.
for (const [label, fault] of [
  ["lost its lease", "lease-lost-after-batch"],
  ["finished with its clean-up failed", "prefix-delete"],
  ["lost its lease with a failed re-read, the site down", "lease-lost-after-batch-reread"],
] as const) {
  test(`a takedown that asked to delete the photos and ${label} shows no hint to tick the box again, with or without the photos choice`, async ({ page }) => {
    for (const purge of [true, false]) {
      const site = await liveSite(page);
      await page.unrouteAll({ behavior: "wait" });
      let posts = 0;
      await page.route("**/api/admin/sites/*/takedown", (route, request) => (++posts === 1 ? route.continue({ headers: { ...request.headers(), "x-test-takedown-fault": fault } }) : route.continue()));
      await takeDownWithPurge(page, site.siteId, purge);
      await expect(page.getByRole("button", { name: "Restore the site" })).toBeVisible();
      await expect(page.locator("body")).not.toContainText(PURGE_HINT);
      await expect(page.getByLabel("Also delete this site's photos")).not.toBeChecked();
      await expect(page.getByRole("status").getByRole("button", { name: "Finish the takedown" })).toHaveCount(0);
    }
  });
}

// QA Q-2: the lease-lost text says "Reload ... press Finish the takedown"; doing exactly that finishes the clean-up, and the owner (told by the server) is not emailed again.
test("after a takedown lost its lease, a browser reload and the down-site form's Finish clear the pages with no second notice", async ({ page }) => {
  const site = await liveSite(page);
  let posts = 0;
  await page.route("**/api/admin/sites/*/takedown", (route, request) => (++posts === 1 ? route.continue({ headers: { ...request.headers(), "x-test-takedown-fault": "lease-lost-after-batch" } }) : route.continue()));
  await takeDown(page, site.siteId);
  await expect(page.getByText("This takedown ran too long and was stopped before it finished.", { exact: false })).toBeVisible();
  expect(await siteNotices(page, site.email)).toBe(1);
  await page.reload();
  await page.getByLabel("Reason for finishing the takedown").fill("Finishing after reload");
  const answer = page.waitForResponse((r) => r.url().includes("/takedown") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Finish the takedown" }).click();
  expect((await answer).status()).toBe(200);
  await expect(page.getByText("Clean-up finished.", { exact: false })).toBeVisible();
  expect(await siteNotices(page, site.email)).toBe(1);
});

// QA Q-3: a form re-run that loses its lease, then the offered Finish: still one notice in total, and the admin is not told "The owner has been emailed".
test("a form re-run that loses its lease, then the form again, sends no second notice", async ({ page }) => {
  const site = await liveSite(page);
  await takeDown(page, site.siteId);
  await expect(page.getByRole("button", { name: "Restore the site" })).toBeVisible();
  await page.reload();
  const bodies: unknown[] = [];
  let reruns = 0;
  await page.route("**/api/admin/sites/*/takedown", (route, request) => {
    bodies.push(request.postDataJSON());
    return ++reruns === 1 ? route.continue({ headers: { ...request.headers(), "x-test-takedown-fault": "lease-lost-after-batch" } }) : route.continue();
  });
  await page.getByLabel("Reason for finishing the takedown").fill("Re-run that loses its lease");
  await page.getByRole("button", { name: "Finish the takedown" }).click();
  await expect(page.getByText("This takedown ran too long and was stopped before it finished.", { exact: false })).toBeVisible();
  await finishFromForm(page, "Re-run that loses its lease"); // the form again: every answer reset it, so the reason is typed again
  await expect(page.getByText("Clean-up finished.", { exact: false })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("The owner has been emailed");
  await expect(page.locator("body")).not.toContainText("Owner not emailed");
  expect(await siteNotices(page, site.email)).toBe(1);
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toMatchObject({ reason: "Re-run that loses its lease", expectedTakenDownAt: expect.any(Number) });
});

// QA Q-7: one POST in flight. The first answer is held back, so the second press of the double-click lands while it runs.
test("a double-click on the form's Finish the takedown sends one POST and writes one repeat audit row", async ({ page }) => {
  const site = await liveSite(page);
  await takeDown(page, site.siteId);
  await expect(page.getByRole("button", { name: "Restore the site" })).toBeVisible();
  await page.reload();
  let posts = 0;
  await page.route("**/api/admin/sites/*/takedown", async (route) => {
    posts += 1;
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue();
  });
  await page.getByLabel("Reason for finishing the takedown").fill("Double press");
  const answered = page.waitForResponse((r) => r.url().includes("/takedown") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Finish the takedown" }).dblclick();
  await answered; // both presses landed while this answer was held back
  expect(posts).toBe(1);
  await expect(page.getByText("Clean-up finished.", { exact: false })).toBeVisible();
  expect((await siteView(page, site.siteId)).audit.filter((a) => a.action === "site.taken_down" && a.detail?.repeat === true)).toHaveLength(1);
});

// QA Q-8: Approve and publish, same rule.
test("a double-click on Approve and publish sends one approve POST", async ({ page }) => {
  const site = await pendingSite(page.request);
  await page.goto(`/reviews/${site.versionId}`);
  await showEveryPage(page);
  let posts = 0;
  await page.route("**/api/admin/versions/*/approve", async (route) => {
    posts += 1;
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue();
  });
  await page.getByRole("button", { name: "Approve and publish" }).dblclick();
  await expect(page.getByText("Approved.", { exact: false })).toBeVisible();
  expect(posts).toBe(1);
});

// QA Q-9: the takedown reasons stop at 1000 characters with the counter and a field error, and nothing is sent.
test("a takedown reason over 1000 characters shows the counter and the error on both forms, and sends nothing", async ({ page }) => {
  const site = await liveSite(page);
  const posts: string[] = [];
  page.on("request", (request) => request.method() === "POST" && request.url().includes("/takedown") && posts.push(request.url()));
  await page.goto(`/sites/${site.siteId}`);
  const first = page.getByLabel("Reason for taking it down");
  await first.fill("x".repeat(1001));
  await expect(page.getByText("1001 of 1000 characters")).toBeVisible();
  await page.getByRole("button", { name: "Take the site down" }).click();
  await expect(page.getByText("Please use 1000 characters or fewer.")).toBeVisible();
  await expect(first).toHaveAttribute("aria-invalid", "true");
  await expect(first).toBeFocused();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(posts).toHaveLength(0);

  await first.fill("Phishing report");
  await page.getByRole("button", { name: "Take the site down" }).click();
  await page.getByRole("dialog", { name: "Take this site down?" }).getByRole("button", { name: "Take it down" }).click();
  await expect(page.getByRole("button", { name: "Restore the site" })).toBeVisible();
  expect(posts).toHaveLength(1);
  const finish = page.getByLabel("Reason for finishing the takedown");
  await finish.fill("y".repeat(1001));
  await expect(page.getByText("1001 of 1000 characters")).toBeVisible();
  await page.getByRole("button", { name: "Finish the takedown" }).click();
  await expect(page.getByText("Please use 1000 characters or fewer.")).toBeVisible();
  await expect(finish).toHaveAttribute("aria-invalid", "true");
  expect(posts).toHaveLength(1);
});

// The reason is counted in code points, like the server's zod .max: 1000 emoji (2000 UTF-16 units) pass on the client and the server, 1001 are refused with the same text.
test("a takedown reason of 1000 emoji is sent and accepted, and 1001 emoji are refused with the same text and counter", async ({ page }) => {
  const site = await liveSite(page);
  const statuses: number[] = [];
  page.on("response", (response) => response.request().method() === "POST" && response.url().includes("/takedown") && statuses.push(response.status()));
  await page.goto(`/sites/${site.siteId}`);
  const first = page.getByLabel("Reason for taking it down");
  await first.fill("\u{1F600}".repeat(1001));
  await expect(page.getByText("1001 of 1000 characters")).toBeVisible();
  await page.getByRole("button", { name: "Take the site down" }).click();
  await expect(page.getByText("Please use 1000 characters or fewer.")).toBeVisible();
  expect(statuses).toHaveLength(0);
  await first.fill("\u{1F600}".repeat(1000));
  await expect(page.getByText("1000 of 1000 characters")).toBeVisible();
  await page.getByRole("button", { name: "Take the site down" }).click();
  await page.getByRole("dialog", { name: "Take this site down?" }).getByRole("button", { name: "Take it down" }).click();
  await expect(page.getByRole("button", { name: "Restore the site" })).toBeVisible();
  expect(statuses).toEqual([200]);
});

test("send an owner a sign-in link from their site; a disabled owner has no such button", async ({ page }) => {
  const site = await pendingSite(page.request);
  await page.goto(`/sites/${site.siteId}`);
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect(page.getByText(`Sign-in link emailed to ${site.email}.`)).toBeVisible();
  await expect(page.locator("body")).not.toContainText("/verify");

  await page.getByLabel("Reason for disabling the owner").fill("Abuse report");
  await page.getByRole("button", { name: "Disable the owner" }).click();
  await expect(page.getByText("Owner disabled and signed out everywhere.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send sign-in link" })).toHaveCount(0);

  await page.goto(`/reviews/${site.versionId}`);
  await expect(page.getByText("The owner's account is disabled. Approving still publishes this page.")).toBeVisible();

  await page.goto(`/sites/${site.siteId}`);
  await page.getByRole("button", { name: "Enable the owner" }).click();
  await expect(page.getByText("Owner enabled.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send sign-in link" })).toBeVisible();
});

test("a list the server cuts off says so, and a short list does not", async ({ page }) => {
  const site = await pendingSite(page.request);
  await page.goto("/");
  await expect(page.getByRole("link", { name: `Review ${site.slug} version 1` })).toBeVisible();
  await expect(page.getByText(/^Showing the \d+ /)).toHaveCount(0);

  const repeat = <T,>(rows: T[], count: number, edit: (row: T, i: number) => T): T[] => Array.from({ length: count }, (_, i) => edit(rows[0] as T, i));
  await page.route("**/api/admin/reviews", async (route) => {
    const json = (await (await route.fetch()).json()) as { items: Array<{ version: { id: string }; site: object }> };
    await route.fulfill({ json: { items: repeat(json.items, 50, (row, i) => ({ ...row, version: { ...row.version, id: `v${i}` } })) } });
  });
  await page.reload();
  await expect(page.getByText("Showing the 50 oldest waiting. Review these to see the rest.")).toBeVisible();

  await page.route("**/api/admin/sites?*", async (route) => {
    const json = (await (await route.fetch()).json()) as { sites: Array<{ id: string }> };
    await route.fulfill({ json: { sites: repeat(json.sites, 500, (row, i) => ({ ...row, id: `s${i}` })) } });
  });
  await page.goto("/sites");
  await expect(page.getByText("Showing the 500 most recent.")).toBeVisible();

  await page.route(`**/api/admin/sites/${site.siteId}`, async (route) => {
    const json = (await (await route.fetch()).json()) as { versions: Array<{ id: string }>; generations: Array<{ id: string }>; audit: Array<{ at: number }> };
    await route.fulfill({
      json: {
        ...json,
        versions: repeat(json.versions, 50, (row, i) => ({ ...row, id: `v${i}` })),
        generations: repeat(json.generations, 50, (row, i) => ({ ...row, id: `g${i}` })),
        audit: repeat(json.audit, 100, (row, i) => ({ ...row, at: row.at + i })),
      },
    });
  });
  await page.goto(`/sites/${site.siteId}`);
  await expect(page.getByText("Showing the 50 most recent.")).toHaveCount(2);
  await expect(page.getByText("Showing the 100 most recent.")).toHaveCount(1);
});

test("the admin app's policy: frames only itself, no Cloudflare widget, and the other security headers", async ({ request }) => {
  const res = await request.get(`${ADMIN}/`);
  const headers = res.headers();
  const csp = headers["content-security-policy"] ?? "";
  expect(csp).toContain("frame-src 'self';");
  expect(csp).toContain("script-src 'self';");
  expect(csp).toContain("font-src 'self' data:");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain("challenges.cloudflare.com");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-robots-tag"]).toBe("noindex");
});

test("settings show today's sign-in emails against the cap, and a banner when the cap was reached", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByText("Sign-in emails today")).toBeVisible();
  await expect(page.getByText(/^\d+ of 40$/)).toBeVisible();
  await expect(page.getByText("Sign-in emails are paused", { exact: false })).toHaveCount(0);

  await page.route("**/api/admin/sign-in-emails", (route) => route.fulfill({ json: { sentToday: 40, dailyCap: 40, capReachedAt: Date.UTC(2026, 9, 1, 13, 5) } }));
  await page.reload();
  await expect(page.getByText("Sign-in emails are paused until midnight UTC (daily limit reached at 13:05 UTC)")).toBeVisible();
  await expect(page.getByText("40 of 40")).toBeVisible();
});

test("the cost labels: a site's jobs say Up to $X, Cost unknown and $0.00, and Spent today says Up to $X, not counting N jobs", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-1280", "Spent today counts every site's jobs, shared by every project: one project owns the seeded rows.");
  const site = await pendingSite(page.request);
  const seeded = await page.request.post(`${ADMIN}/__test/generations`, {
    data: {
      siteId: site.siteId,
      rows: [
        { status: "succeeded", modelSlot: 1, costMicrousd: 1_331_520, startedAt: "now" }, // known: Up to $1.34
        { status: "failed", modelSlot: 1, costMicrousd: 0, startedAt: "now" }, // took a slot, no recorded cost: Cost unknown
        { status: "running", modelSlot: 1, costMicrousd: 0, startedAt: "now" }, // still running: counted as unknown, no cost line
        { status: "failed", modelSlot: 0, costMicrousd: 0, startedAt: "now" }, // no call sent: $0.00
      ],
    },
  });
  expect(seeded.ok()).toBe(true);

  await page.goto(`/sites/${site.siteId}`);
  const jobs = page.getByRole("region", { name: "AI writing jobs" });
  await expect(jobs.getByText(/ · Up to \$1\.34 · /)).toHaveCount(1);
  await expect(jobs.getByText(/ · Cost unknown$/)).toHaveCount(1); // only "Cost unknown": no "no model" or "0 attempts" stated as facts for it
  await expect(jobs.getByText(/Cost unknown · /)).toHaveCount(0);
  await expect(jobs.getByText(/ · \$0\.00 · /)).toHaveCount(2); // the seeded model_slot 0 job and the site's own first job (no call sent)

  await page.goto("/settings");
  await expect(page.locator('dt:text-is("Spent today") + dd')).toHaveText("Up to $1.34, not counting 2 jobs whose cost is unknown");
});

test("the test seam for generations is refused for a bad body and an unknown site", async ({ request }) => {
  expect((await request.post(`${ADMIN}/__test/generations`, { data: { siteId: "x", rows: [{ status: "bogus", modelSlot: 1, costMicrousd: 1, startedAt: "now" }] } })).status()).toBe(400);
  expect((await request.post(`${ADMIN}/__test/generations`, { data: { siteId: "no-such-site", rows: [{ status: "failed", modelSlot: 1, costMicrousd: 1, startedAt: null }] } })).status()).toBe(404);
});

test("settings, by keyboard only: switch AI writing off and lower the daily limit", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-1280", "Changes a setting shared by every test: one project is enough.");
  await page.goto("/settings");
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeFocused();
  await expectAccessible(page);
  const enabled = page.getByLabel("AI writing is on");
  const limit = page.getByLabel("Most AI writing jobs per day, for all owners");
  await tabTo(page, enabled);
  await page.keyboard.press("Space");
  await expect(enabled).not.toBeChecked();
  await tabTo(page, limit);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("abc");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Enter a whole number from 0 to 1000.")).toBeVisible();
  await expect(limit).toBeFocused();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("5");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Settings saved.")).toBeVisible();
  await page.reload();
  await expect(enabled).not.toBeChecked();
  await expect(limit).toHaveValue("5");
  await tabTo(page, enabled);
  await page.keyboard.press("Space");
  await tabTo(page, page.getByRole("button", { name: "Save settings" }));
  await page.keyboard.press("Enter");
  await expect(page.getByText("Settings saved.")).toBeVisible();
});

test("every admin screen passes axe and reflows at 320 px", async ({ page }) => {
  test.slow(); // seven axe runs: triple the 60 s timeout so a busy machine does not fail it
  const site = await pendingSite(page.request);
  await page.setViewportSize({ width: 320, height: 700 });
  for (const path of ["/", `/reviews/${site.versionId}`, "/invites", "/sites", `/sites/${site.siteId}`, "/settings", "/nope"]) {
    await page.goto(`${ADMIN}${path}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    if (path.startsWith("/reviews/")) {
      // Swept with several pages listed (the switcher sits outside the frames) and Approve still gated.
      await expect(page.getByRole("group", { name: "Page", exact: true }).getByRole("button")).toHaveText(["Home", "Services", "About", "Contact"]);
      const approve = page.getByRole("button", { name: "Approve and publish" });
      await expect(approve).toHaveAttribute("aria-disabled", "true");
      await expect(approve).toHaveAttribute("aria-describedby", "approve-gate");
    }
    await expectAccessible(page);
    await expectNoSidewaysScroll(page);
  }
});
