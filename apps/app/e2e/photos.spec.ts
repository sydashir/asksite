import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import { acceptInvite, apiCall, expectAccessible, expectNoSidewaysScroll } from "./support.ts";

async function rotatedJpeg(): Promise<Buffer> {
  // Stored 800x400 with EXIF orientation 6: it displays upright as 400x800.
  return sharp({ create: { width: 800, height: 400, channels: 3, background: { r: 20, g: 160, b: 90 } } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
}

/** Playwright cannot read a multipart file part from the request, so record the file the page sends. */
async function recordSentFiles(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __sent: number[][] };
    w.__sent = [];
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const file = init?.body instanceof FormData ? init.body.get("file") : null;
      if (file instanceof Blob) w.__sent.push(Array.from(new Uint8Array(await file.arrayBuffer())));
      return original(input, init);
    };
  });
}

const sentFiles = (page: Page) => page.evaluate(() => (window as unknown as { __sent: number[][] }).__sent);

const CAMERA_MARKER = "ASKSITE-CAMERA-MARKER";
const GPS_MARKER = "ASKSITE-GPS-MARKER";

/** A photo whose EXIF carries a GPS position and recognisable text, as a phone camera writes them. */
async function geotaggedJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 200, g: 60, b: 60 } } })
    .jpeg()
    .withExif({
      IFD0: { ImageDescription: CAMERA_MARKER },
      IFD3: { GPSMapDatum: GPS_MARKER, GPSLatitudeRef: "N", GPSLatitude: "30/1 15/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "97/1 44/1 0/1" },
    })
    .toBuffer();
}

test("an uploaded photo is redrawn upright in the browser, then used as the main photo with alt text @mobile", async ({ page }) => {
  const siteId = await acceptInvite(page);
  await page.goto(`/sites/${siteId}/setup/photos`);
  await page.getByLabel("Upload a photo").setInputFiles({ name: "IMG_0001.jpg", mimeType: "image/jpeg", buffer: await rotatedJpeg() });
  await expect(page.getByText("Photo uploaded. Choose where to use it below.")).toBeVisible();
  const view = await apiCall(page, "GET", `/api/sites/${siteId}`);
  const uploads = view.json?.["uploads"] as Array<{ width: number; height: number }>;
  expect(uploads.map((u) => [u.width, u.height])).toEqual([[400, 800]]);

  await page.getByRole("button", { name: "Use uploaded photo 1 as the main photo" }).click();
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByRole("link", { name: /Describe the main photo|Please fill this in/ }).first()).toBeVisible();
  await page.getByLabel("Describe the main photo").fill("IMG_0001.jpg");
  await expect(page.getByText("This looks like a file name. Say what the photo shows instead.")).toBeVisible();
  await page.getByLabel("Describe the main photo").fill("New water heater installed in a garage");
  await expect(page.getByText("This looks like a file name. Say what the photo shows instead.")).toBeHidden();
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "In your own words" })).toBeFocused();
});

test("the photos step has no sideways scroll and no accessibility violations @mobile", async ({ page }) => {
  const siteId = await acceptInvite(page);
  await page.goto(`/sites/${siteId}/setup/photos`);
  await page.getByLabel("Upload a photo").setInputFiles({ name: "IMG_0004.jpg", mimeType: "image/jpeg", buffer: await rotatedJpeg() });
  await expect(page.getByText("Photo uploaded. Choose where to use it below.")).toBeVisible();
  await page.getByRole("button", { name: "Use uploaded photo 1 as the main photo" }).click();
  await expect(page.getByLabel("Describe the main photo")).toBeVisible();
  await expectNoSidewaysScroll(page);
  await expectAccessible(page);
});

test("a file the browser cannot read is refused before upload", async ({ page }) => {
  const siteId = await acceptInvite(page);
  await page.goto(`/sites/${siteId}/setup/photos`);
  await page.getByLabel("Upload a photo").setInputFiles({ name: "IMG_0002.heic", mimeType: "image/jpeg", buffer: Buffer.from("\u0000\u0000\u0000\u0018ftypheic not a real photo") });
  await expect(page.getByText("We could not read that photo. Please choose a JPG or PNG photo.")).toBeVisible();
  const view = await apiCall(page, "GET", `/api/sites/${siteId}`);
  expect(view.json?.["uploads"]).toEqual([]);
});

test("deleting an uploaded photo asks first, and Cancel keeps it", async ({ page }) => {
  const siteId = await acceptInvite(page);
  await page.goto(`/sites/${siteId}/setup/photos`);
  await page.getByLabel("Upload a photo").setInputFiles({ name: "IMG_0003.jpg", mimeType: "image/jpeg", buffer: await rotatedJpeg() });
  await expect(page.getByText("Photo uploaded. Choose where to use it below.")).toBeVisible();
  const uploads = async () => ((await apiCall(page, "GET", `/api/sites/${siteId}`)).json?.["uploads"] as unknown[]).length;

  await page.getByRole("button", { name: "Delete uploaded photo 1" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete this photo?" });
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect(await uploads()).toBe(1);

  await page.getByRole("button", { name: "Delete uploaded photo 1" }).click();
  await dialog.getByRole("button", { name: "Delete photo" }).click();
  await expect(page.getByText("Photo deleted.")).toBeFocused();
  expect(await uploads()).toBe(0);
});

test("work photos move with buttons", async ({ page }) => {
  const siteId = await acceptInvite(page);
  await page.goto(`/sites/${siteId}/setup/photos`);
  for (const name of ["a.jpg", "b.jpg"]) {
    await page.getByLabel("Upload a photo").setInputFiles({ name, mimeType: "image/jpeg", buffer: await rotatedJpeg() });
    await expect(page.getByText("Photo uploaded. Choose where to use it below.")).toBeVisible();
  }
  // Focus moves to each new photo's description (it can land late on a busy machine, so wait for it before typing).
  await page.getByRole("button", { name: "Add uploaded photo 1 to your work photos" }).click();
  await expect(page.getByLabel("Describe work photo 1")).toBeFocused();
  await page.getByRole("button", { name: "Add uploaded photo 2 to your work photos" }).click();
  await expect(page.getByLabel("Describe work photo 2")).toBeFocused();
  await page.getByLabel("Describe work photo 1").fill("First job");
  await page.getByLabel("Describe work photo 2").fill("Second job");
  await page.getByRole("button", { name: "Move work photo 2 up" }).click();
  await expect(page.getByLabel("Describe work photo 1")).toHaveValue("Second job");
  await expect(page.getByLabel("Describe work photo 2")).toHaveValue("First job");
});

// STRICT (customer data): the file the owner's phone took carries their position; only the redrawn copy may leave the browser.
test("the uploaded copy carries none of the original's GPS data", async ({ page }) => {
  const original = await geotaggedJpeg();
  // Control: both markers (one in the GPS block, one in the camera block) really are in the original.
  expect(original.includes(Buffer.from(GPS_MARKER))).toBe(true);
  expect(original.includes(Buffer.from(CAMERA_MARKER))).toBe(true);
  await recordSentFiles(page);
  const siteId = await acceptInvite(page);
  await page.goto(`/sites/${siteId}/setup/photos`);
  await page.getByLabel("Upload a photo").setInputFiles({ name: "IMG_0005.jpg", mimeType: "image/jpeg", buffer: original });
  await expect(page.getByText("Photo uploaded. Choose where to use it below.")).toBeVisible();
  const sent = await sentFiles(page);
  expect(sent).toHaveLength(1);
  const body = Buffer.from(sent[0]!);
  expect(body.length).toBeGreaterThan(1000); // a real image went out
  expect(body.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff])); // and it is a JPEG
  expect(body.includes(Buffer.from(GPS_MARKER))).toBe(false);
  expect(body.includes(Buffer.from(CAMERA_MARKER))).toBe(false);
});

// STRICT (customer data): facts are owner-typed JSON, so a photo address that is not https is never put in an <img>.
test("only https photo addresses are shown", async ({ page }) => {
  const siteId = await acceptInvite(page);
  const requested: string[] = [];
  page.on("request", (r) => requested.push(r.url()));
  await page.route(`**/api/sites/${siteId}`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const res = await route.fetch();
    const json = (await res.json()) as { facts: Record<string, unknown> };
    json.facts = {
      ...json.facts,
      heroPhoto: { url: "http://insecure.example/hero.jpg", alt: "Hero", width: 400, height: 400 },
      photos: [
        { url: "javascript:alert(1)", alt: "Script", width: 400, height: 400 },
        { url: "https://secure.example/work.jpg", alt: "Work", width: 400, height: 400 },
      ],
    };
    return route.fulfill({ response: res, json });
  });
  await page.route("https://secure.example/**", (route) => route.fulfill({ status: 200, contentType: "image/gif", body: Buffer.from("R0lGODlhAQABAAAAACw=", "base64") }));
  await page.goto(`/sites/${siteId}/setup/photos`);
  await expect(page.getByLabel("Describe work photo 2")).toBeVisible();
  const srcs = await page.locator("main img").evaluateAll((imgs) => imgs.map((i) => i.getAttribute("src")));
  expect(srcs).toEqual(["https://secure.example/work.jpg"]);
  expect(requested.some((u) => u.startsWith("http://insecure.example"))).toBe(false);
});

// Decision 21 and the 3,000 px cap: the redraw is what leaves the browser, so check the file that was sent.
test("a large transparent photo is redrawn at 3,000 px with a white background", async ({ page }) => {
  const red = await sharp({ create: { width: 2000, height: 1000, channels: 4, background: { r: 220, g: 20, b: 20, alpha: 1 } } }).png().toBuffer();
  const wide = await sharp({ create: { width: 4000, height: 1000, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: red, left: 0, top: 0 }])
    .png()
    .toBuffer();
  await recordSentFiles(page);
  const siteId = await acceptInvite(page);
  await page.goto(`/sites/${siteId}/setup/photos`);
  await page.getByLabel("Upload a photo").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: wide });
  await expect(page.getByText("Photo uploaded. Choose where to use it below.")).toBeVisible();
  const sent = await sentFiles(page);
  expect(sent).toHaveLength(1);
  const { data, info } = await sharp(Buffer.from(sent[0]!)).raw().toBuffer({ resolveWithObject: true });
  expect([info.width, info.height]).toEqual([3000, 750]);
  expect((await sharp(Buffer.from(sent[0]!)).metadata()).format).toBe("jpeg");
  const at = (x: number, y: number) => Array.from(data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3));
  // The transparent right half is white, not black; the opaque left half is still red.
  for (const channel of at(2990, 10)) expect(channel).toBeGreaterThan(245);
  const [r, g, b] = at(100, 375);
  expect(r).toBeGreaterThan(190);
  expect(g).toBeLessThan(70);
  expect(b).toBeLessThan(70);
});

test("deleting a photo keeps edits made while the delete runs", async ({ page }) => {
  const siteId = await acceptInvite(page);
  await page.goto(`/sites/${siteId}/setup/photos`);
  for (const name of ["a.jpg", "b.jpg", "c.jpg"]) {
    await page.getByLabel("Upload a photo").setInputFiles({ name, mimeType: "image/jpeg", buffer: await rotatedJpeg() });
    await expect(page.getByText("Photo uploaded. Choose where to use it below.")).toBeVisible();
  }
  await page.getByRole("button", { name: "Add uploaded photo 1 to your work photos" }).click();
  await expect(page.getByLabel("Describe work photo 1")).toBeFocused();

  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**/api/sites/${siteId}/uploads/*`, async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    await gate;
    return route.fallback();
  });
  await page.getByRole("button", { name: "Delete uploaded photo 3" }).click();
  await page.getByRole("dialog", { name: "Delete this photo?" }).getByRole("button", { name: "Delete photo" }).click();
  // While the delete is waiting: type a description and add another work photo.
  await page.getByLabel("Describe work photo 1").fill("Typed while deleting");
  await page.getByRole("button", { name: "Add uploaded photo 2 to your work photos" }).click();
  await expect(page.getByLabel("Describe work photo 2")).toBeVisible();
  release();
  await expect(page.getByText("Photo deleted.")).toBeVisible();

  await expect(page.getByLabel("Describe work photo 1")).toHaveValue("Typed while deleting");
  await expect(page.getByLabel("Describe work photo 2")).toBeVisible();
  await expect
    .poll(async () => {
      const facts = (await apiCall(page, "GET", `/api/sites/${siteId}`)).json?.["facts"] as { photos?: Array<{ alt: string }> };
      return (facts.photos ?? []).map((p) => p.alt);
    })
    .toEqual(["Typed while deleting", ""]);
});

test("the photo buttons keep keyboard focus when they change or disappear", async ({ page }) => {
  const siteId = await acceptInvite(page);
  await page.goto(`/sites/${siteId}/setup/photos`);
  const input = page.getByLabel("Upload a photo");
  // A native file input keeps focus while it uploads (it is not disabled).
  await input.focus();
  await input.setInputFiles({ name: "a.jpg", mimeType: "image/jpeg", buffer: await rotatedJpeg() });
  await expect(page.getByText("Photo uploaded. Choose where to use it below.")).toBeVisible();
  await expect(input).toBeFocused();
  await input.setInputFiles({ name: "b.jpg", mimeType: "image/jpeg", buffer: await rotatedJpeg() });
  await expect(page.getByRole("button", { name: "Add uploaded photo 2 to your work photos" })).toBeVisible();
  await expect(input).toBeFocused();

  // Main photo: choosing it moves focus to its description; removing it moves focus to the group.
  await page.getByRole("button", { name: "Use uploaded photo 1 as the main photo" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Describe the main photo")).toBeFocused();
  await page.getByRole("button", { name: "Stop using this main photo" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("group", { name: "Main photo" })).toBeFocused();

  // Work photos: a button that reaches the end of the list hands focus to the opposite move button.
  for (const n of [1, 2]) {
    await page.getByRole("button", { name: `Add uploaded photo ${n} to your work photos` }).click();
    await expect(page.getByLabel(`Describe work photo ${n}`)).toBeFocused();
  }
  await page.getByRole("button", { name: "Move work photo 2 up" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Move work photo 1 down" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Move work photo 2 up" })).toBeFocused();
});
