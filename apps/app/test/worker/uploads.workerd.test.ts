import { LIMITS, mediaUrl, type SiteView, type UploadView } from "@asksite/core";
import { describe, expect, it } from "vitest";
import { MAX_PART_HEADER_BYTES, MAX_PARTS } from "../../src/worker/multipart.ts";
import { BROWSER_BOUNDARIES, browserContentType, browserMultipart, encode, geckoBoundary, joined, type BrowserPart } from "../support/browsers.ts";
import { VALID_FACTS } from "../support/facts.ts";
import { APP_ORIGIN, awayFromMinuteBoundary, json, ROOT, useAppHarness } from "../support/harness.ts";
import { animatedWebp, jpeg, jpegWithGps, latin1, png, truncatedJpeg, upload } from "../support/images.ts";

const h = useAppHarness();

type ErrorJson = { error: { code: string; message?: string } };

/** The answer to every upload refused as multipart (P4-17 Condition 3, P4-15 follow-up 2): one plain sentence, never the reason. */
const didNotWork = { code: "bad_request", message: "That upload didn't work. Please try again." };

/** The request's one log line of the last upload POST. */
const lastUploadLine = () => h.logLines().filter((line) => line["route"] === "POST /api/sites/:siteId/uploads").at(-1);

/** An upload POST of a body the test encoded itself, with the Content-Type it chooses. */
const postRaw = (owner: { siteId: string; cookie: string }, contentType: string, body: Uint8Array) =>
  h.server.fetch(`${APP_ORIGIN}/api/sites/${owner.siteId}/uploads`, { method: "POST", headers: { Origin: APP_ORIGIN, Cookie: owner.cookie, "Content-Type": contentType }, body });

async function media(key: string) {
  const env = (await h.server.getWorker().getEnv()) as { MEDIA: { get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> } | null> } };
  return env.MEDIA.get(key);
}

/** The keys of every object MEDIA holds for a site. */
async function mediaKeys(siteId: string): Promise<string[]> {
  const env = (await h.server.getWorker().getEnv()) as { MEDIA: { list(options: { prefix: string }): Promise<{ objects: Array<{ key: string }> }> } };
  return (await env.MEDIA.list({ prefix: `${siteId}/` })).objects.map((object) => object.key);
}

/** The options of every .transform() and .output() the Worker has asked of IMAGES, oldest first (the test Worker records them). */
async function imagesCalls(): Promise<Array<Record<string, unknown>>> {
  return json<Array<Record<string, unknown>>>(await h.call("GET", "/__test/images-calls"));
}

type UploadRow = { id: string; width: number; height: number; bytes: number; created_at: number; deleted_at: number | null };

/** Every uploads row of a site, deleted ones included (the 150 total cap counts them all), oldest first. */
async function uploadRows(siteId: string): Promise<UploadRow[]> {
  const db = await h.db();
  const { results } = await db.prepare("SELECT id, width, height, bytes, created_at, deleted_at FROM uploads WHERE site_id = ? ORDER BY created_at").bind(siteId).all<UploadRow>();
  return results;
}

const shape = (row: UploadRow) => ({ width: row.width, height: row.height, bytes: row.bytes, deleted: row.deleted_at !== null });

/** The row a photo that fails in the transform leaves (P4-14): no size, already deleted, counted toward the 150 total. */
const COUNTED_FAILURE = { width: 0, height: 0, bytes: 0, deleted: true };

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
    // That transform is counted as an already-deleted upload, so the 150 total cap bounds them (P4-14).
    expect((await uploadRows(owner.siteId)).map(shape)).toEqual([COUNTED_FAILURE]);
  });

  it("refuses a photo the image service did not re-encode as WebP (422 image_rejected, counted, nothing stored): the metadata stripping relies on WebP", async () => {
    const owner = await h.signIn();
    await h.call("POST", "/__test/images-output-format", { body: { format: "image/jpeg" } });
    const res = await h.call("POST", `/api/sites/${owner.siteId}/uploads`, { cookie: owner.cookie, body: upload(await jpegWithGps(800, 600)) });
    expect(res.status).toBe(422);
    expect((await json<ErrorJson>(res)).error.code).toBe("image_rejected");
    // The transform ran, so it is counted like any other the file made fail (P4-14).
    expect((await uploadRows(owner.siteId)).map(shape)).toEqual([COUNTED_FAILURE]);
    expect(await mediaKeys(owner.siteId)).toEqual([]);
  });

  it("refuses a photo over 10 MB with the photo's 413", async () => {
    const owner = await h.signIn();
    const big = new Uint8Array(LIMITS.uploadMaxBytes + 1);
    big.set([0xff, 0xd8, 0xff]);
    const res = await h.call("POST", `/api/sites/${owner.siteId}/uploads`, { cookie: owner.cookie, body: upload(big) });
    expect(res.status).toBe(413);
    expect((await json<ErrorJson>(res)).error).toEqual({ code: "payload_too_large", message: "That photo is over 10 MB. Please choose a smaller one." });
  });

  it("refuses a body over the photo's 10 MB plus the 16 KiB multipart allowance with 413 before parsing it (the byte cap), declared or streamed", async () => {
    const owner = await h.signIn();
    const path = `/api/sites/${owner.siteId}/uploads`;
    // A file this big is over the cap once its multipart wrapper is around it.
    const file = new Uint8Array(LIMITS.uploadMaxBytes + 16 * 1024);
    file.set([0xff, 0xd8, 0xff]);
    const declared = await h.call("POST", path, { cookie: owner.cookie, body: upload(file) });
    expect(declared.status).toBe(413);
    expect((await json<ErrorJson>(declared)).error).toEqual({ code: "payload_too_large", message: "That is too large to upload" });
    // The same body as a stream with no Content-Length: the bytes are counted as they arrive.
    const encoded = new Request("https://encode.invalid/", { method: "POST", body: upload(file) });
    // The harness's own RequestInit (undici's, which has `duplex`), not Node's global one.
    const init: Parameters<typeof h.server.fetch>[1] = {
      method: "POST",
      headers: { Origin: APP_ORIGIN, Cookie: owner.cookie, "Content-Type": encoded.headers.get("Content-Type") ?? "" },
      body: encoded.body,
      duplex: "half",
    };
    const streamed = await h.server.fetch(`${APP_ORIGIN}${path}`, init);
    expect(streamed.status).toBe(413);
    expect((await json<ErrorJson>(streamed)).error).toEqual({ code: "payload_too_large", message: "That is too large to upload" });
  });

  it("refuses a photo over 50 million pixels with 422 image_rejected once measured, before any transform and with no row (§8 step 2)", async () => {
    const owner = await h.signIn();
    const before = (await imagesCalls()).length;
    const res = await h.call("POST", `/api/sites/${owner.siteId}/uploads`, { cookie: owner.cookie, body: upload(await jpeg(7100, 7100)) });
    expect(res.status).toBe(422);
    expect((await json<ErrorJson>(res)).error).toEqual({ code: "image_rejected", message: "That photo is too large. Please choose a smaller one." });
    expect((await imagesCalls()).length).toBe(before);
    expect(await uploadRows(owner.siteId)).toEqual([]);
  });

  it("refuses a body that is not multipart with 403", async () => {
    const owner = await h.signIn();
    const res = await h.call("POST", `/api/sites/${owner.siteId}/uploads`, { cookie: owner.cookie, body: { file: "x" } });
    expect(res.status).toBe(403);
  });

  it("stops an owner at UPLOAD_RL, 20 uploads a minute (429 rate_limited, Retry-After 60), before the body is looked at", async () => {
    const owner = await h.signIn();
    await awayFromMinuteBoundary();
    const statuses: number[] = [];
    let last: Response | undefined;
    for (let i = 0; i < 21; i += 1) {
      // A JSON body: refused at the content-type check right after the rate limit, so each try costs nothing.
      last = await h.call("POST", `/api/sites/${owner.siteId}/uploads`, { cookie: owner.cookie, body: { file: "x" } });
      statuses.push(last.status);
    }
    expect(statuses).toEqual([...Array.from({ length: 20 }, () => 403), 429]);
    expect((await json<ErrorJson>(last!)).error.code).toBe("rate_limited");
    expect(last!.headers.get("Retry-After")).toBe("60");
  });

  it("refuses a multipart body with no file part with 400 bad_request: a field named file that is text, or no field named file", async () => {
    const owner = await h.signIn();
    const textField = new FormData();
    textField.append("file", "not a file");
    const otherName = new FormData();
    otherName.append("photo", new File([await png(400, 300)], "x.png", { type: "image/png" }));
    for (const body of [textField, otherName]) {
      const res = await h.call("POST", `/api/sites/${owner.siteId}/uploads`, { cookie: owner.cookie, body });
      expect(res.status).toBe(400);
      expect((await json<ErrorJson>(res)).error).toEqual({ code: "bad_request", message: "Choose a photo to upload" });
    }
    expect(await uploadRows(owner.siteId)).toEqual([]);
  });

  describe("a multipart body shaped to make the parse slow is refused before it is parsed (P4-15 d)", () => {
    // P4-17 Condition 3, for every refusal here (P4-15 follow-up 2): the owner reads one plain sentence, and the
    // reason is only on the request's log line.

    it(`refuses more than MAX_PARTS (${MAX_PARTS}) parts with 400, noting too_many_parts on the request's log line`, async () => {
      const owner = await h.signIn();
      const form = upload(await png(400, 300), "x.png", "image/png");
      for (let i = 0; i < MAX_PARTS; i += 1) form.append(`field${i}`, "x");
      const res = await h.call("POST", `/api/sites/${owner.siteId}/uploads`, { cookie: owner.cookie, body: form });
      expect(res.status).toBe(400);
      expect((await json<ErrorJson>(res)).error).toEqual(didNotWork);
      expect(lastUploadLine()).toMatchObject({ status: 400, code: "bad_request", event: "multipart_refused", reason: "too_many_parts" });
      expect(await uploadRows(owner.siteId)).toEqual([]);
    });

    it(`refuses a part whose headers run past MAX_PART_HEADER_BYTES (${MAX_PART_HEADER_BYTES}) with 400, noting part_header_too_long`, async () => {
      const owner = await h.signIn();
      const form = upload(await png(400, 300), `${"a".repeat(MAX_PART_HEADER_BYTES)}.png`, "image/png");
      const res = await h.call("POST", `/api/sites/${owner.siteId}/uploads`, { cookie: owner.cookie, body: form });
      expect(res.status).toBe(400);
      expect((await json<ErrorJson>(res)).error).toEqual(didNotWork);
      expect(lastUploadLine()).toMatchObject({ status: 400, code: "bad_request", event: "multipart_refused", reason: "part_header_too_long" });
      expect(await uploadRows(owner.siteId)).toEqual([]);
    });

    it(`still stores a photo sent with up to ${MAX_PARTS - 1} other fields`, async () => {
      const owner = await h.signIn();
      const form = upload(await png(400, 300), "x.png", "image/png");
      for (let i = 0; i < MAX_PARTS - 1; i += 1) form.append(`field${i}`, "x");
      const res = await h.call("POST", `/api/sites/${owner.siteId}/uploads`, { cookie: owner.cookie, body: form });
      expect(res.status).toBe(201);
      expect((await uploadRows(owner.siteId)).map(shape)).toEqual([{ width: 400, height: 300, bytes: expect.any(Number), deleted: false }]);
    });

    // Bodies encoded here, so the test picks the boundary, the line ends and what comes before or inside a part.
    const photoPart = (photo: Uint8Array): BrowserPart => ({ name: "file", filename: "x.png", type: "image/png", content: photo });
    const fields = (count: number): BrowserPart[] => Array.from({ length: count }, (_, i) => ({ name: `field${i}`, value: "x" }));

    // Each body below parses in workerd to a stored photo when the guard lets it through (P4-15 review I1, I2).
    it.each<[name: string, reason: string, request: (photo: Uint8Array) => [contentType: string, body: Uint8Array]]>([
      // The parser reads REAL from these two headers; a looser read of the boundary let their extra parts through.
      ["a boundary= inside an earlier parameter's quoted value", "boundary_not_accepted", (photo) => ['multipart/form-data; x="; boundary=DECOY"; boundary=REAL', browserMultipart("REAL", [photoPart(photo), ...fields(MAX_PARTS)])]],
      ["a quoted boundary with a backslash escape", "boundary_not_accepted", (photo) => ['multipart/form-data; boundary="RE\\AL"', browserMultipart("REAL", [photoPart(photo), ...fields(MAX_PARTS)])]],
      // RFC 2046 5.1.1: a boundary "must be no longer than 70 characters"; the parser's search costs its length.
      ["a boundary of 71 characters", "boundary_not_accepted", (photo) => [`multipart/form-data; boundary=${"b".repeat(71)}`, browserMultipart("b".repeat(71), [photoPart(photo)])]],
      // With the browser's header: a --REAL-- inside a line is no delimiter to the parser, which reads on.
      ["a --boundary-- inside a line of the first part", "too_many_parts", (photo) => ["multipart/form-data; boundary=REAL", browserMultipart("REAL", [{ name: "note", value: "xx--REAL--yy" }, photoPart(photo), ...fields(MAX_PARTS - 1)])]],
      ["a preamble before the first delimiter", "no_leading_delimiter", (photo) => ["multipart/form-data; boundary=REAL", joined(encode("preamble\r\n"), browserMultipart("REAL", [photoPart(photo)]))]],
    ])("refuses %s with 400, noting %s", async (_, reason, request) => {
      const owner = await h.signIn();
      const [contentType, body] = request(await png(400, 300));
      const res = await postRaw(owner, contentType, body);
      expect(res.status).toBe(400);
      const text = await res.text();
      expect((JSON.parse(text) as ErrorJson).error).toEqual(didNotWork);
      // The reason is for the log line only: nothing in the answer names it.
      expect(text).not.toContain(reason);
      expect(lastUploadLine()).toMatchObject({ status: 400, code: "bad_request", event: "multipart_refused", reason });
      expect(await uploadRows(owner.siteId)).toEqual([]);
    });

    it("still stores a photo sent with a 70-character boundary of RFC 2046's characters, or with bare LF line ends, as the parser reads both", async () => {
      const owner = await h.signIn();
      const longest = `'()+_,-./:=?${"Z".repeat(58)}`;
      expect(longest).toHaveLength(70);
      const photo = await png(400, 300);
      for (const [contentType, body] of [
        [`multipart/form-data; boundary=${longest}`, browserMultipart(longest, [photoPart(photo)])],
        ["multipart/form-data; boundary=REAL", browserMultipart("REAL", [photoPart(photo)], "\n")],
      ] as const) {
        const res = await postRaw(owner, contentType, body);
        expect(res.status, contentType).toBe(201);
      }
      expect(await uploadRows(owner.siteId)).toHaveLength(2);
    });
  });

  describe("stores a photo sent as each browser encodes it: its Content-Type and body as the engine's source writes them (P4-17 Condition 1)", () => {
    // The encodings, with their sources, are in test/support/browsers.ts: the guard lets each through, the parser reads it, the photo is stored.
    async function stored(boundary: string): Promise<void> {
      const owner = await h.signIn();
      const body = browserMultipart(boundary, [{ name: "file", filename: "photo.png", type: "image/png", content: await png(400, 300) }]);
      const res = await postRaw(owner, browserContentType(boundary), body);
      expect(res.status, boundary).toBe(201);
      expect(await json<UploadView>(res)).toMatchObject({ width: 400, height: 300 });
      expect((await uploadRows(owner.siteId)).map(shape)).toEqual([{ width: 400, height: 300, bytes: expect.any(Number), deleted: false }]);
    }

    it.each(BROWSER_BOUNDARIES)("%s", async (_, draw) => {
      await stored(draw());
    });

    it("Firefox's shortest and longest boundaries, 23 and 53 characters", async () => {
      await stored(geckoBoundary(0n, 0n));
      await stored(geckoBoundary(2n ** 64n - 1n, 2n ** 64n - 1n));
    });
  });

  it("refuses a multipart body that cannot be parsed with 400 bad_request and the same plain sentence, not as a server failure", async () => {
    const owner = await h.signIn();
    const part = '------b\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\nÿØÿ';
    // With the reason each request's log line gives: the guard refuses three of these bodies; the part that never
    // closes passes it, and then formData() cannot parse it (readForm's 400, which notes no reason).
    const bodies: Array<[contentType: string, body: string, reason: string | undefined]> = [
      ["multipart/form-data; boundary=----b", "not multipart at all", "no_leading_delimiter"],
      ["multipart/form-data; boundary=----b", part, undefined],
      ["multipart/form-data;", part, "boundary_not_accepted"],
      ["multipart/form-data; boundary=----b", "", "no_leading_delimiter"],
    ];
    const answers: Array<[number, ErrorJson["error"], unknown]> = [];
    for (const [contentType, body] of bodies) {
      const res = await h.server.fetch(`${APP_ORIGIN}/api/sites/${owner.siteId}/uploads`, {
        method: "POST",
        headers: { Origin: APP_ORIGIN, Cookie: owner.cookie, "Content-Type": contentType },
        body,
      });
      answers.push([res.status, (await json<ErrorJson>(res)).error, lastUploadLine()?.["reason"]]);
    }
    expect(answers).toEqual(bodies.map(([, , reason]) => [400, didNotWork, reason]));
  });

  it("stops at 40 kept photos and at 150 uploads in total (429 upload_limit_reached)", async () => {
    const db = await h.db();
    const kept = await h.signIn();
    for (let i = 0; i < 40; i += 1) {
      await db.prepare("INSERT INTO uploads (id, site_id, width, height, bytes, created_at) VALUES (?, ?, 400, 300, 1, 1)").bind(crypto.randomUUID(), kept.siteId).run();
    }
    const before = (await imagesCalls()).length;
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
    // Both were refused by the pre-check, before any transform: a refused upload costs nothing (§8 step 2).
    expect((await imagesCalls()).length).toBe(before);
  });

  describe("when another upload takes the last slot after the pre-check passed, the exact INSERT still refuses (§8 step 2)", () => {
    /**
     * A site one upload short of the cap, whose last slot the test Worker fills just before the route's INSERT:
     * after its pre-check, as a parallel upload would. "kept" fills the 40 kept photos, "total" the 150 uploads.
     */
    async function oneShortOf(cap: "kept" | "total") {
      const owner = await h.signIn();
      const db = await h.db();
      const [seeded, deletedAt] = cap === "kept" ? [LIMITS.uploadsPerSite - 1, null] : [LIMITS.uploadsPerSiteTotal - 1, 2];
      for (let i = 0; i < seeded; i += 1) {
        await db.prepare("INSERT INTO uploads (id, site_id, width, height, bytes, created_at, deleted_at) VALUES (?, ?, 400, 300, 1, 1, ?)").bind(crypto.randomUUID(), owner.siteId, deletedAt).run();
      }
      await h.call("POST", "/__test/take-last-upload-slot", { body: { siteId: owner.siteId, deleted: cap === "total" } });
      return owner;
    }

    const counts = async (siteId: string) => {
      const rows = await uploadRows(siteId);
      return { total: rows.length, kept: rows.filter((row) => row.deleted_at === null).length };
    };

    it.each(["kept", "total"] as const)("at the %s cap: 429 upload_limit_reached after the transform, and nothing stored", async (cap) => {
      const owner = await oneShortOf(cap);
      const before = (await imagesCalls()).length;
      const res = await h.call("POST", `/api/sites/${owner.siteId}/uploads`, { cookie: owner.cookie, body: upload(await png(400, 300), "x.png") });
      expect(res.status).toBe(429);
      expect((await json<ErrorJson>(res)).error.code).toBe("upload_limit_reached");
      expect(res.headers.get("Retry-After")).toBe("86400");
      // The pre-check passed, so the photo was transformed: only the INSERT refused it.
      expect((await imagesCalls()).slice(before).map((call) => Object.keys(call))).toEqual([["transform"], ["output"]]);
      // Only the upload that took the slot is new; no object was stored for the refused one.
      expect(await counts(owner.siteId)).toEqual(cap === "kept" ? { total: LIMITS.uploadsPerSite, kept: LIMITS.uploadsPerSite } : { total: LIMITS.uploadsPerSiteTotal, kept: 0 });
      expect(await mediaKeys(owner.siteId)).toEqual([]);
    });

    // The failure row goes through the same conditional INSERT, so either cap refuses it (P4-14; the refused arm at
    // routes/uploads.ts is otherwise reached only in this race).
    it.each(["kept", "total"] as const)("at the %s cap, a photo that fails in the transform is refused as over the limit, not counted (P4-14)", async (cap) => {
      const owner = await oneShortOf(cap);
      const res = await h.call("POST", `/api/sites/${owner.siteId}/uploads`, { cookie: owner.cookie, body: upload(await truncatedJpeg(800, 600)) });
      expect(res.status).toBe(429);
      expect((await json<ErrorJson>(res)).error.code).toBe("upload_limit_reached");
      expect(res.headers.get("Retry-After")).toBe("86400");
      expect(await counts(owner.siteId)).toEqual(cap === "kept" ? { total: LIMITS.uploadsPerSite, kept: LIMITS.uploadsPerSite } : { total: LIMITS.uploadsPerSiteTotal, kept: 0 });
    });
  });

  it("counts every photo that fails in the transform, so sending one again and again stops at the 150 total cap (429 upload_limit_reached)", async () => {
    const db = await h.db();
    const owner = await h.signIn();
    for (let i = 0; i < 148; i += 1) {
      await db.prepare("INSERT INTO uploads (id, site_id, width, height, bytes, created_at, deleted_at) VALUES (?, ?, 400, 300, 1, 1, 2)").bind(crypto.randomUUID(), owner.siteId).run();
    }
    const broken = await truncatedJpeg(800, 600);
    for (let i = 0; i < 2; i += 1) {
      const res = await h.call("POST", `/api/sites/${owner.siteId}/uploads`, { cookie: owner.cookie, body: upload(broken) });
      expect([res.status, (await json<ErrorJson>(res)).error.code]).toEqual([422, "image_rejected"]);
    }
    const before = (await imagesCalls()).length;
    const full = await h.call("POST", `/api/sites/${owner.siteId}/uploads`, { cookie: owner.cookie, body: upload(broken) });
    expect(full.status).toBe(429);
    expect((await json<ErrorJson>(full)).error.code).toBe("upload_limit_reached");
    expect(full.headers.get("Retry-After")).toBe("86400");
    // Refused by the pre-check: the file never reached the Images service again.
    expect((await imagesCalls()).length).toBe(before);
    expect((await uploadRows(owner.siteId)).map(shape).slice(148)).toEqual([COUNTED_FAILURE, COUNTED_FAILURE]);
  });

  it("hands storing the row and the photo to waitUntil as well, so a client that goes away cannot leave a row without its photo", async () => {
    const owner = await h.signIn();
    const path = `/api/sites/${owner.siteId}/uploads`;
    const before = await h.waitUntilCount(path);
    const res = await h.call("POST", path, { cookie: owner.cookie, body: upload(await png(400, 300), "x.png") });
    expect(res.status).toBe(201);
    expect(await h.waitUntilCount(path)).toBe(before + 1);
    await h.backgroundDone(path);
  });

  describe("keeps the work from the transform to the row that counts it running, should the client go away (P4-15 follow-up 1)", () => {
    // The local runtime finishes a request's work after its client has gone (test-worker.ts), so a disconnect cannot
    // be made here. The test Worker notes instead, as each step's result comes back, how many waitUntil promises the
    // request had handed over and how many of them still ran. Inside one runToEnd, the transform's .output() (the
    // first billed Images call: .info() is not billed) and the INSERT that counts it both come back while that one
    // promise runs; a step outside it comes back with none running, or under a second promise.
    const underOneRunToEnd = [
      { step: "output", waitUntil: 1, pending: 1 },
      { step: "insert", waitUntil: 1, pending: 1 },
    ];

    /** An owner's upload whose steps the test Worker notes: its status, the steps and the site's upload rows. */
    async function uploadNotingSteps(photo: Uint8Array) {
      const owner = await h.signIn();
      const path = `/api/sites/${owner.siteId}/uploads`;
      await h.call("POST", "/__test/watch-steps", { body: { path } });
      const res = await h.call("POST", path, { cookie: owner.cookie, body: upload(photo) });
      const steps = await json<unknown[]>(await h.call("GET", `/__test/steps?path=${encodeURIComponent(path)}`));
      return { status: res.status, steps, rows: (await uploadRows(owner.siteId)).map(shape) };
    }

    it("for a photo it stores (201)", async () => {
      expect(await uploadNotingSteps(await jpeg(800, 600))).toEqual({ status: 201, steps: underOneRunToEnd, rows: [{ width: 800, height: 600, bytes: expect.any(Number), deleted: false }] });
    });

    it("for a photo that fails in the transform (422, counted)", async () => {
      expect(await uploadNotingSteps(await truncatedJpeg(800, 600))).toEqual({ status: 422, steps: underOneRunToEnd, rows: [COUNTED_FAILURE] });
    });

    it("for a transform that answers another format than WebP (422, counted)", async () => {
      await h.call("POST", "/__test/images-output-format", { body: { format: "image/jpeg" } });
      expect(await uploadNotingSteps(await jpeg(800, 600))).toEqual({ status: 422, steps: underOneRunToEnd, rows: [COUNTED_FAILURE] });
    });
  });

  it("removes the row again when the photo cannot be stored (500 internal, nothing left behind)", async () => {
    const owner = await h.signIn();
    await h.call("POST", "/__test/media-put-fails");
    const res = await h.call("POST", `/api/sites/${owner.siteId}/uploads`, { cookie: owner.cookie, body: upload(await png(400, 300), "x.png") });
    expect(res.status).toBe(500);
    expect((await json<ErrorJson>(res)).error.code).toBe("internal");
    expect(await uploadRows(owner.siteId)).toEqual([]);
    expect(await mediaKeys(owner.siteId)).toEqual([]);
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
    return { res, rows: (await uploadRows(owner.siteId)).map(shape) };
  }

  // Only a transform the file made fail is counted (P4-14): .info() is not billed, and a service failure is ours.
  it.each(FILE_FAULT_CODES)("blames the photo for Images error %i with 422 image_rejected", async (code) => {
    const { res, rows } = await uploadWhileImagesFails(code);
    expect(res.status).toBe(422);
    expect((await json<ErrorJson>(res)).error.code).toBe("image_rejected");
    expect(rows).toEqual(step === "output" ? [COUNTED_FAILURE] : []);
  });

  it.each(SERVICE_CODES)("answers Images error %i as our failure (500 internal), never as the owner's photo, and counts no upload", async (code) => {
    const { res, rows } = await uploadWhileImagesFails(code);
    expect(res.status).toBe(500);
    expect((await json<ErrorJson>(res)).error.code).toBe("internal");
    expect(rows).toEqual([]);
  });

  it("answers a failure that is no Images error as 500 internal, and logs it as one", async () => {
    const { res, rows } = await uploadWhileImagesFails(null);
    expect(res.status).toBe(500);
    expect(rows).toEqual([]);
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

  it("keeps the row a failed transform leaves out of sight: not listed, not usable as a photo, never served, no kept slot, passed over by a takedown purge", async () => {
    const owner = await h.signIn();
    const db = await h.db();
    const res = await h.call("POST", `/api/sites/${owner.siteId}/uploads`, { cookie: owner.cookie, body: upload(await truncatedJpeg(800, 600)) });
    expect(res.status).toBe(422);
    const rows = await uploadRows(owner.siteId);
    expect(rows.map(shape)).toEqual([COUNTED_FAILURE]);
    const failed = rows[0]!;

    // The site view and the photo check read only uploads with deleted_at IS NULL. The photo below has the
    // row's own address and sizes, so only the row being deleted can make it "not one of your uploads".
    expect((await json<SiteView>(await h.call("GET", `/api/sites/${owner.siteId}`, { cookie: owner.cookie }))).uploads).toEqual([]);
    const ghost = { url: mediaUrl(ROOT, owner.siteId, failed.id), alt: "New water heater in a garage", width: 0, height: 0 };
    const saved = await h.call("PATCH", `/api/sites/${owner.siteId}/draft`, { cookie: owner.cookie, body: { rev: 1, facts: { ...VALID_FACTS, heroPhoto: ghost } } });
    const issues = (await json<{ issues: SiteView["issues"] }>(saved)).issues.photos;
    expect(issues.map((i) => [i.path.join("."), i.code])).toEqual([["facts.heroPhoto.url", "photo_ref"]]);

    // Nothing was stored, and the sites Worker reads MEDIA before D1 (Plan 2 serveMedia), so the row is never served.
    expect(await media(`${owner.siteId}/${failed.id}.webp`)).toBeNull();

    // It takes none of the 40 kept slots: with 39 kept photos, the 40th still uploads.
    for (let i = 0; i < 39; i += 1) {
      await db.prepare("INSERT INTO uploads (id, site_id, width, height, bytes, created_at) VALUES (?, ?, 400, 300, 1, 1)").bind(crypto.randomUUID(), owner.siteId).run();
    }
    expect((await h.call("POST", `/api/sites/${owner.siteId}/uploads`, { cookie: owner.cookie, body: upload(await png(400, 300), "x.png") })).status).toBe(201);

    // A takedown's media purge marks only uploads with deleted_at IS NULL (Plan 2 takeDown, the same statement).
    const purge = await db.prepare("UPDATE uploads SET deleted_at = ? WHERE site_id = ? AND deleted_at IS NULL").bind(Date.now() + 60_000, owner.siteId).run();
    expect(purge.meta.changes).toBe(40);
    expect((await uploadRows(owner.siteId)).find((row) => row.id === failed.id)?.deleted_at).toBe(failed.deleted_at);
  });
});
