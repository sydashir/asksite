import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import sharp from "sharp";
import { adminApi, APP, expectAccessible, expectLive, expectOffline, latestEmail, LIVE_PORT, pageUrl, reviewVersion, waitOutEdgeCopy } from "./support.ts";

// The admin's side of design §10.2 against the real Workers: Plan 2's publishing and sites Worker,
// Plan 3's generator. The owner's setup goes through the API (the owner's journey covers the screens).

const BRIEF = { tone: "friendly", goal: "call" };
const facts = (email: string, businessName = "Takedown Plumbing") => ({
  businessName,
  trade: "plumbing",
  phone: "+15125550142",
  email,
  location: { city: "Austin", state: "TX" },
  serviceArea: { places: ["Austin"] },
  services: [{ name: "Drain cleaning" }],
});

type Generation = { id: string; kind: string; status: string; usedFallback: boolean; fallbackReason: string | null };

const json = async <T>(res: { json(): Promise<unknown> }): Promise<T> => (await res.json()) as T;
const stamp = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A 400 x 300 JPEG that the upload checks accept. */
const photo = (red: number) => sharp({ create: { width: 400, height: 300, channels: 3, background: { r: red, g: 120, b: 90 } } }).jpeg().toBuffer();

async function ownerApi(page: Page, method: "GET" | "POST" | "PUT" | "PATCH", path: string, data?: unknown) {
  const res = await page.request.fetch(`${APP}${path}`, { method, headers: { Origin: APP }, ...(data === undefined ? {} : { data }) });
  expect(res.status(), `${method} ${path}`).toBeLessThan(300);
  return res;
}

/**
 * The admin invites `email`; the owner accepts from the emailed link in `page`. Returns the site and
 * the draft's rev once the page's own first save (the prefilled public email) is done, and leaves
 * the page, so nothing on screen holds the draft while the test drives the API.
 */
async function invitedOwner(page: Page, admin: APIRequestContext, email: string) {
  await adminApi(admin, "POST", "/api/admin/invites", { email });
  const link = /https:\/\/app\.localhost:8789\/invite#[A-Za-z0-9_-]{43}/.exec(await latestEmail(page.request, email, /invited/))![0];
  await page.goto(link);
  await page.getByRole("button", { name: "Set up my website" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Your business" })).toBeFocused();
  await expect(page.getByRole("status").filter({ hasText: "All changes saved." })).toBeVisible();
  const siteId = new URL(page.url()).pathname.split("/")[2]!;
  await page.goto(`${APP}/`);
  return { siteId, rev: await currentRev(page, siteId) };
}

const currentRev = async (page: Page, siteId: string) => (await json<{ rev: number }>(await ownerApi(page, "GET", `/api/sites/${siteId}`))).rev;

async function upload(page: Page, siteId: string, bytes: Buffer) {
  const res = await page.request.post(`${APP}/api/sites/${siteId}/uploads`, { headers: { Origin: APP }, multipart: { file: { name: "photo.jpg", mimeType: "image/jpeg", buffer: bytes } } });
  expect(res.status()).toBe(201);
  return json<{ url: string; width: number; height: number }>(res);
}

/** Asks for the first build and waits for the real generator (fake provider) to finish it. */
async function build(page: Page, siteId: string): Promise<Generation> {
  const { generation } = await json<{ generation: Generation }>(await ownerApi(page, "POST", `/api/sites/${siteId}/generations`, {}));
  let view = generation;
  await expect
    .poll(async () => {
      view = await json<Generation>(await ownerApi(page, "GET", `/api/sites/${siteId}/generations/${generation.id}`));
      return view.status;
    }, { timeout: 120_000 })
    .toMatch(/^(succeeded|failed)$/);
  return view;
}

test("the admin rejects, approves twice, takes the site down with its photos, and restores it", async ({ browser }, testInfo) => {
  test.setTimeout(300_000); // the chromium project's restore step waits out the sites Worker's 60 s edge copy
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: testInfo.project.use.viewport ?? null });
  const owner = await context.newPage();
  const adminContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const admin = adminContext.request;
  const id = stamp();
  const email = `admin-journey-${id}@example.com`;
  const slug = `takedown-${id}`;

  // An owner with a main photo and a work photo, built and sent for review.
  const { siteId, rev } = await invitedOwner(owner, admin, email);
  const main = await upload(owner, siteId, await photo(40));
  const work = await upload(owner, siteId, await photo(200));
  const photos = {
    heroPhoto: { url: main.url, alt: "A new water heater in a garage", width: main.width, height: main.height },
    photos: [{ url: work.url, alt: "A repaired kitchen sink", width: work.width, height: work.height }],
  };
  let current = (await json<{ rev: number }>(await ownerApi(owner, "PATCH", `/api/sites/${siteId}/draft`, { rev, facts: { ...facts(email), ...photos }, brief: BRIEF }))).rev;
  current = (await json<{ rev: number }>(await ownerApi(owner, "PUT", `/api/sites/${siteId}/slug`, { rev: current, slug }))).rev;
  expect(await build(owner, siteId)).toMatchObject({ status: "succeeded", usedFallback: false });
  const sendForReview = async () => json<{ version: { id: string; number: number } }>(await ownerApi(owner, "POST", `/api/sites/${siteId}/publish-requests`, { rev: await currentRev(owner, siteId) }));

  // 1. Reject: the owner gets the note by email and sees it on the publish page.
  const first = await sendForReview();
  await adminApi(admin, "POST", `/api/admin/versions/${first.version.id}/reject`, { note: "Please add your license number." });
  expect(await latestEmail(owner.request, email, /needs a change/)).toContain("Please add your license number.");
  await owner.goto(`${APP}/sites/${siteId}/publish`);
  await expect(owner.getByText("Please add your license number.")).toBeVisible();
  await expectAccessible(owner);
  await owner.goto(`${APP}/`);

  // 2. Approve the next version: the sites Worker serves every page of it, straight away, with its photos.
  // Pages are fetched with request.get only, never opened in a browser: a browser would cache the hero photo.
  const second = await sendForReview();
  expect(second.version.number).toBe(2);
  const v2 = await reviewVersion(admin, second.version.id, { gallery: true });
  await adminApi(admin, "POST", `/api/admin/versions/${second.version.id}/approve`, { htmlSha256: v2.htmlSha256 });
  const live = pageUrl(slug, "home");
  expect(live).toBe(`https://${slug}.localhost:${LIVE_PORT}/`);
  const liveV2 = await expectLive(owner.request, slug, v2.pages);
  expect(liveV2.html["home"]).toContain(`src="${main.url}"`);
  expect(liveV2.html["home"]).not.toContain(work.url);
  expect(liveV2.html["gallery"]).toContain(`src="${work.url}"`);
  const served = await owner.request.get(work.url);
  expect(served.status()).toBe(200);
  expect(served.headers()["content-type"]).toBe("image/webp");

  // 3. A second approval: the owner renames the business, a name every page shows. Every page of the new
  // version differs from the old one, and after the approval every page shows the new version, none the old.
  // This comes before the take-down: a purge makes the owner's old photos unusable for a new request.
  await ownerApi(owner, "PATCH", `/api/sites/${siteId}/draft`, { rev: await currentRev(owner, siteId), facts: { ...facts(email, "Second Version Plumbing"), ...photos } });
  const third = await sendForReview();
  expect(third.version.number).toBe(3);
  const v3 = await reviewVersion(admin, third.version.id, { gallery: true });
  for (const listed of v3.pages) expect(listed.sha256, `v3 ${listed.page} differs from v2`).not.toBe(v2.pages.find((p) => p.page === listed.page)?.sha256);
  await adminApi(admin, "POST", `/api/admin/versions/${third.version.id}/approve`, { htmlSha256: v3.htmlSha256 });
  const liveV3 = await expectLive(owner.request, slug, v3.pages);
  for (const [page, html] of Object.entries(liveV3.html)) {
    expect(html, `v3 ${page}`).toContain("Second Version Plumbing");
    expect(html, `v3 ${page}`).not.toContain("Takedown Plumbing");
  }
  for (const old of v2.pages.filter((p) => !v3.pages.some((n) => n.page === p.page))) expect((await owner.request.get(pageUrl(slug, old.page))).status(), `v2-only ${old.page}`).toBe(404);

  // 4. Take it down with its photos. The pointer goes first, so every page stops at once; the main photo,
  // which nobody has fetched, is gone at once too.
  const takedown = await json<{ noticeSent: boolean }>(await adminApi(admin, "POST", `/api/admin/sites/${siteId}/takedown`, { reason: "Phishing report", purgeMedia: true }));
  expect(takedown).toEqual({ noticeSent: true });
  await expectOffline(owner.request, slug, v3.pages);
  expect((await owner.request.get(main.url)).status()).toBe(404);
  expect(await latestEmail(owner.request, email, /taken offline/)).toContain("If you have questions, reply to this email");

  // 5. Restore: the admin is told that its two photos are gone. The pages were fetched a moment ago and the
  // sites Worker keeps a copy of each for 60 s; wait that out, so every 200 below comes from the restored pages.
  const restored = await json<{ liveUrl: string; missingPhotos: number }>(await adminApi(admin, "POST", `/api/admin/sites/${siteId}/restore`, {}));
  expect(restored).toEqual({ liveUrl: live, missingPhotos: 2 });
  // The wait and the hash check are about the sites Worker, not the browser: one project does them, once per run.
  if (testInfo.project.name === "chromium-1280") {
    await waitOutEdgeCopy(liveV3.fetchedAt);
    await expectLive(owner.request, slug, v3.pages);
  }

  await context.close();
  await adminContext.close();
});

test("the kill switch gives a first build the starter wording and refuses a rewrite", async ({ browser }, testInfo) => {
  // The switch turns the AI off for every owner, so no other test may run beside this one. A caller's
  // --workers arrives after the script's own (pnpm appends it) and wins, so the run checks itself.
  expect(testInfo.config.workers, "run the journey with exactly one worker: this test switches the AI off for every owner").toBe(1);
  test.skip(testInfo.project.name !== "chromium-1280", "Switches the AI off for every owner for a moment: one project is enough.");
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: testInfo.project.use.viewport ?? null });
  const owner = await context.newPage();
  const adminContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const admin = adminContext.request;
  const email = `kill-switch-${stamp()}@example.com`;

  const { siteId, rev } = await invitedOwner(owner, admin, email);
  await adminApi(admin, "PUT", "/api/admin/settings", { generationEnabled: false });
  try {
    await ownerApi(owner, "PATCH", `/api/sites/${siteId}/draft`, { rev, facts: facts(email), brief: BRIEF });
    expect(await build(owner, siteId)).toMatchObject({ kind: "first", status: "succeeded", usedFallback: true, fallbackReason: "disabled" });
    await owner.goto(`${APP}/sites/${siteId}/edit`);
    await expect(owner.getByText("We wrote simple starter wording for you.", { exact: false })).toBeVisible();
    await expectAccessible(owner);
    const rewrite = await owner.request.post(`${APP}/api/sites/${siteId}/generations`, { headers: { Origin: APP }, data: {} });
    expect(rewrite.status()).toBe(503);
    expect(((await rewrite.json()) as { error: { code: string } }).error.code).toBe("generation_disabled");
  } finally {
    await adminApi(admin, "PUT", "/api/admin/settings", { generationEnabled: true });
  }

  await context.close();
  await adminContext.close();
});
