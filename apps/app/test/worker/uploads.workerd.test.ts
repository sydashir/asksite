import { mediaUrl, type SiteView, type UploadView } from "@asksite/core";
import { describe, expect, it } from "vitest";
import { VALID_FACTS } from "../support/facts.ts";
import { APP_ORIGIN, json, ROOT, useAppHarness } from "../support/harness.ts";
import { animatedWebp, jpegWithGps, latin1, png, truncatedJpeg, upload } from "../support/images.ts";

const h = useAppHarness();

type ErrorJson = { error: { code: string } };

async function media(key: string) {
  const env = (await h.server.getWorker().getEnv()) as { MEDIA: { get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> } | null> } };
  return env.MEDIA.get(key);
}

/** The options of every .transform() and .output() the Worker has asked of IMAGES, oldest first (the test Worker records them). */
async function imagesCalls(): Promise<Array<Record<string, unknown>>> {
  return json<Array<Record<string, unknown>>>(await h.call("GET", "/__test/images-calls"));
}

describe("POST /api/sites/:siteId/uploads", () => {
  it("stores a PNG as a WebP in MEDIA and returns the UploadView", async () => {
    const owner = await h.signIn();
    const res = await h.call("POST", `/api/sites/${owner.siteId}/uploads`, { cookie: owner.cookie, body: upload(await png(400, 300), "x.png", "image/png") });
    expect(res.status).toBe(201);
    const view = await json<UploadView>(res);
    expect(view).toMatchObject({ width: 400, height: 300, url: mediaUrl(ROOT, owner.siteId, view.id) });
    const object = await media(`${owner.siteId}/${view.id}.webp`);
    expect(object?.httpMetadata?.contentType).toBe("image/webp");
    expect(object?.customMetadata).toEqual({ siteId: owner.siteId, uploadId: view.id });
    const bytes = new Uint8Array(await object!.arrayBuffer());
    expect(latin1(bytes.slice(0, 4))).toBe("RIFF");
    expect(latin1(bytes.slice(8, 12))).toBe("WEBP");
    expect(view.bytes).toBe(bytes.byteLength);
  });

  it("scales a large photo down to 1600 px and drops its EXIF and GPS data", async () => {
    const owner = await h.signIn();
    const res = await h.call("POST", `/api/sites/${owner.siteId}/uploads`, { cookie: owner.cookie, body: upload(await jpegWithGps(3200, 2400)) });
    const view = await json<UploadView>(res);
    expect([view.width, view.height]).toEqual([1600, 1200]);
    const stored = latin1(new Uint8Array(await (await media(`${owner.siteId}/${view.id}.webp`))!.arrayBuffer()));
    expect(stored).not.toContain("Exif");
    expect(stored).not.toContain("LeakyCam");
  });

  // Locally this proves only that the original is not stored: the local binding decodes just the first
  // frame whatever it is asked. The next test pins the `anim: false` that production relies on.
  it("stores an animated WebP as a still image", async () => {
    const owner = await h.signIn();
    const res = await h.call("POST", `/api/sites/${owner.siteId}/uploads`, { cookie: owner.cookie, body: upload(await animatedWebp(), "a.webp", "image/webp") });
    expect(res.status).toBe(201);
    const view = await json<UploadView>(res);
    const stored = latin1(new Uint8Array(await (await media(`${owner.siteId}/${view.id}.webp`))!.arrayBuffer()));
    expect(stored).not.toContain("ANIM");
  });

  it("asks the Images binding for a still WebP, at most 1600 px on each side, quality 82 (§8 step 3)", async () => {
    const owner = await h.signIn();
    const before = (await imagesCalls()).length;
    const res = await h.call("POST", `/api/sites/${owner.siteId}/uploads`, { cookie: owner.cookie, body: upload(await animatedWebp(), "a.webp", "image/webp") });
    expect(res.status).toBe(201);
    expect((await imagesCalls()).slice(before)).toEqual([
      { transform: { width: 1600, height: 1600, fit: "scale-down" } },
      { output: { format: "image/webp", quality: 82, anim: false } },
    ]);
  });

  it("refuses anything that is not really a JPEG, PNG or WebP with 415, whatever its name says", async () => {
    const owner = await h.signIn();
    const fakes = [
      new TextEncoder().encode("GIF89a........"),
      new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
      new TextEncoder().encode("\u0000\u0000\u0000\u0018ftypheic...."),
      new TextEncoder().encode("%PDF-1.7"),
    ];
    for (const bytes of fakes) {
      const res = await h.call("POST", `/api/sites/${owner.siteId}/uploads`, { cookie: owner.cookie, body: upload(bytes, "photo.jpg", "image/jpeg") });
      expect(res.status).toBe(415);
    }
  });

  it("refuses a photo under 200 px, or one the image service cannot read, with 422 image_rejected", async () => {
    const owner = await h.signIn();
    const small = await h.call("POST", `/api/sites/${owner.siteId}/uploads`, { cookie: owner.cookie, body: upload(await png(150, 400), "s.png") });
    expect(small.status).toBe(422);
    expect((await json<ErrorJson>(small)).error.code).toBe("image_rejected");
    const broken = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const res = await h.call("POST", `/api/sites/${owner.siteId}/uploads`, { cookie: owner.cookie, body: upload(broken) });
    expect(res.status).toBe(422);
  });

  it("refuses a JPEG whose data is cut off, which the image service can measure but not re-encode, with 422 image_rejected", async () => {
    const owner = await h.signIn();
    const before = (await imagesCalls()).length;
    const res = await h.call("POST", `/api/sites/${owner.siteId}/uploads`, { cookie: owner.cookie, body: upload(await truncatedJpeg(800, 600)) });
    expect(res.status).toBe(422);
    expect((await json<ErrorJson>(res)).error.code).toBe("image_rejected");
    // The file got past .info() and failed in the transform: the transform was really asked for.
    expect((await imagesCalls()).slice(before).map((call) => Object.keys(call))).toEqual([["transform"], ["output"]]);
    expect((await (await h.db()).prepare("SELECT COUNT(*) AS n FROM uploads WHERE site_id = ?").bind(owner.siteId).first<{ n: number }>())?.n).toBe(0);
  });

  it("refuses a file over 10 MB with 413", async () => {
    const owner = await h.signIn();
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set([0xff, 0xd8, 0xff]);
    const res = await h.call("POST", `/api/sites/${owner.siteId}/uploads`, { cookie: owner.cookie, body: upload(big) });
    expect(res.status).toBe(413);
  });

  it("refuses a body that is not multipart with 403", async () => {
    const owner = await h.signIn();
    const res = await h.call("POST", `/api/sites/${owner.siteId}/uploads`, { cookie: owner.cookie, body: { file: "x" } });
    expect(res.status).toBe(403);
  });

  it("refuses a multipart body that cannot be parsed with 400 bad_request, not as a server failure", async () => {
    const owner = await h.signIn();
    const part = '------b\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\nÿØÿ';
    const bodies: Array<[contentType: string, body: string]> = [
      ["multipart/form-data; boundary=----b", "not multipart at all"],
      ["multipart/form-data; boundary=----b", part],
      ["multipart/form-data;", part],
      ["multipart/form-data; boundary=----b", ""],
    ];
    const answers: Array<[number, string]> = [];
    for (const [contentType, body] of bodies) {
      const res = await h.server.fetch(`${APP_ORIGIN}/api/sites/${owner.siteId}/uploads`, {
        method: "POST",
        headers: { Origin: APP_ORIGIN, Cookie: owner.cookie, "Content-Type": contentType },
        body,
      });
      answers.push([res.status, (await json<ErrorJson>(res)).error.code]);
    }
    expect(answers).toEqual(bodies.map(() => [400, "bad_request"]));
  });

  it("stops at 40 kept photos and at 150 uploads in total (429 upload_limit_reached)", async () => {
    const db = await h.db();
    const kept = await h.signIn();
    for (let i = 0; i < 40; i += 1) {
      await db.prepare("INSERT INTO uploads (id, site_id, width, height, bytes, created_at) VALUES (?, ?, 400, 300, 1, 1)").bind(crypto.randomUUID(), kept.siteId).run();
    }
    const full = await h.call("POST", `/api/sites/${kept.siteId}/uploads`, { cookie: kept.cookie, body: upload(await png(400, 300), "x.png") });
    expect(full.status).toBe(429);
    expect((await json<ErrorJson>(full)).error.code).toBe("upload_limit_reached");
    expect(full.headers.get("Retry-After")).toBe("86400");

    const churned = await h.signIn();
    for (let i = 0; i < 150; i += 1) {
      await db.prepare("INSERT INTO uploads (id, site_id, width, height, bytes, created_at, deleted_at) VALUES (?, ?, 400, 300, 1, 1, 2)").bind(crypto.randomUUID(), churned.siteId).run();
    }
    const res = await h.call("POST", `/api/sites/${churned.siteId}/uploads`, { cookie: churned.cookie, body: upload(await png(400, 300), "x.png") });
    expect(res.status).toBe(429);
  });

  it("cannot upload to another owner's site", async () => {
    const a = await h.signIn();
    const b = await h.signIn();
    const res = await h.call("POST", `/api/sites/${b.siteId}/uploads`, { cookie: a.cookie, body: upload(await png(400, 300), "x.png") });
    expect(res.status).toBe(404);
    expect((await h.call("POST", `/api/sites/${b.siteId}/uploads`, { cookie: b.cookie, body: upload(await png(400, 300), "x.png") })).status).toBe(201);
  });

  it("refuses a photo for a taken-down site with 423 and stores nothing", async () => {
    const owner = await h.signIn();
    const db = await h.db();
    await db.prepare("UPDATE sites SET taken_down_at = 1 WHERE id = ?").bind(owner.siteId).run();
    const res = await h.call("POST", `/api/sites/${owner.siteId}/uploads`, { cookie: owner.cookie, body: upload(await png(400, 300), "x.png") });
    expect(res.status).toBe(423);
    expect((await json<ErrorJson>(res)).error.code).toBe("site_taken_down");
    expect((await db.prepare("SELECT COUNT(*) AS n FROM uploads WHERE site_id = ?").bind(owner.siteId).first<{ n: number }>())?.n).toBe(0);
  });
});

// images/reference/troubleshooting: not an image (9412), over 100 megapixels (9413), a format it does not support (9520), an invalid one (9523).
const FILE_FAULT_CODES = [9412, 9413, 9520, 9523];
// The same page: interrupted (9402), the monthly allowance used up (9422), internal (9424, 9516-9518),
// unreachable (9504, 9505, 9510), over the processing limit (9522), timed out (9529).
const SERVICE_CODES = [9402, 9422, 9424, 9504, 9505, 9510, 9516, 9517, 9518, 9522, 9529];

// The binding reaches the Images service twice per upload: .info() measures the photo, .output() re-encodes it.
describe.each(["info", "output"] as const)("when the Images binding fails in .%s()", (step) => {
  /** An owner's upload of a good photo, whose IMAGES call of this step the test Worker makes fail with `code` (null: a TypeError). */
  async function uploadWhileImagesFails(code: number | null) {
    const owner = await h.signIn();
    await h.call("POST", "/__test/images-fails", { body: { step, code } });
    const res = await h.call("POST", `/api/sites/${owner.siteId}/uploads`, { cookie: owner.cookie, body: upload(await png(400, 300), "x.png") });
    const stored = await (await h.db()).prepare("SELECT COUNT(*) AS n FROM uploads WHERE site_id = ?").bind(owner.siteId).first<{ n: number }>();
    return { res, stored: stored?.n };
  }

  it.each(FILE_FAULT_CODES)("blames the photo for Images error %i with 422 image_rejected", async (code) => {
    const { res, stored } = await uploadWhileImagesFails(code);
    expect(res.status).toBe(422);
    expect((await json<ErrorJson>(res)).error.code).toBe("image_rejected");
    expect(stored).toBe(0);
  });

  it.each(SERVICE_CODES)("answers Images error %i as our failure (500 internal), never as the owner's photo", async (code) => {
    const { res, stored } = await uploadWhileImagesFails(code);
    expect(res.status).toBe(500);
    expect((await json<ErrorJson>(res)).error.code).toBe("internal");
    expect(stored).toBe(0);
  });

  it("answers a failure that is no Images error as 500 internal, and logs it as one", async () => {
    const { res, stored } = await uploadWhileImagesFails(null);
    expect(res.status).toBe(500);
    expect(stored).toBe(0);
    const line = h.logLines().filter((l) => l["route"] === "POST /api/sites/:siteId/uploads").at(-1);
    expect(line).toMatchObject({ status: 500, code: "internal", error: "TypeError" });
  });
});

describe("photo references and deletion", () => {
  it("accepts facts that use this site's own upload, flags outside or resized URLs, and soft-deletes", async () => {
    const owner = await h.signIn();
    const view = await json<UploadView>(
      await h.call("POST", `/api/sites/${owner.siteId}/uploads`, { cookie: owner.cookie, body: upload(await png(400, 300), "x.png") }),
    );
    const photo = { url: view.url, alt: "New water heater in a garage", width: 400, height: 300 };
    const ok = await h.call("PATCH", `/api/sites/${owner.siteId}/draft`, { cookie: owner.cookie, body: { rev: 1, facts: { ...VALID_FACTS, heroPhoto: photo } } });
    expect((await json<{ issues: SiteView["issues"] }>(ok)).issues.photos).toEqual([]);

    const outside = { ...photo, url: "https://evil.example/x.webp" };
    const resized = { ...photo, width: 800 };
    const bad = await h.call("PATCH", `/api/sites/${owner.siteId}/draft`, {
      cookie: owner.cookie,
      body: { rev: 2, facts: { ...VALID_FACTS, heroPhoto: outside, photos: [resized] } },
    });
    const issues = (await json<{ issues: SiteView["issues"] }>(bad)).issues.photos;
    expect(issues.map((i) => [i.path.join("."), i.code])).toEqual([
      ["facts.heroPhoto.url", "photo_ref"],
      ["facts.photos.0.url", "photo_ref"],
    ]);

    expect((await h.call("DELETE", `/api/sites/${owner.siteId}/uploads/${view.id}`, { cookie: owner.cookie })).status).toBe(204);
    expect((await h.call("DELETE", `/api/sites/${owner.siteId}/uploads/${view.id}`, { cookie: owner.cookie })).status).toBe(404);
    const after = await json<SiteView>(await h.call("GET", `/api/sites/${owner.siteId}`, { cookie: owner.cookie }));
    expect(after.uploads).toEqual([]);
    expect(await media(`${owner.siteId}/${view.id}.webp`)).not.toBeNull();
  });

  it("cannot delete another owner's photo, through its own site's path or the other site's", async () => {
    const a = await h.signIn();
    const b = await h.signIn();
    const photo = await json<UploadView>(await h.call("POST", `/api/sites/${b.siteId}/uploads`, { cookie: b.cookie, body: upload(await png(400, 300), "x.png") }));
    // Upload ids are public (they are in the photo's address), so A may know B's.
    for (const siteId of [a.siteId, b.siteId]) {
      const res = await h.call("DELETE", `/api/sites/${siteId}/uploads/${photo.id}`, { cookie: a.cookie });
      expect(res.status).toBe(404);
      expect((await json<ErrorJson>(res)).error.code).toBe("not_found");
    }
    const view = await json<SiteView>(await h.call("GET", `/api/sites/${b.siteId}`, { cookie: b.cookie }));
    expect(view.uploads.map((u) => u.id)).toEqual([photo.id]);
    const row = await (await h.db()).prepare("SELECT deleted_at FROM uploads WHERE id = ?").bind(photo.id).first<{ deleted_at: number | null }>();
    expect(row).toEqual({ deleted_at: null });
  });
});
