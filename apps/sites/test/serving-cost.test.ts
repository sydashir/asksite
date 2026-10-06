import { livePageKey, livePointerKey, mediaKey, pageCacheUrl, mediaUrl } from "@asksite/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.ts";
import worker from "../src/index.ts";

// What a request costs, counted: the handler run in Node against counting fakes of LIVE, MEDIA, D1 and the
// edge cache (the workerd harness cannot count reads). The fake cache adds "age" and "cf-cache-status" to
// every hit, as Cloudflare's does, to show which headers a hit hands on.
const ROOT = "asksite.example";
const SLUG = "joes-plumbing";
const SITE = "11111111-1111-4111-8111-111111111111";
const V1 = "22222222-2222-4222-8222-222222222222";
const V2 = "44444444-4444-4444-8444-444444444444";
const UPLOAD = "33333333-3333-4333-8333-333333333333";

const counts: Record<string, number> = {};
const bump = (key: string) => (counts[key] = (counts[key] ?? 0) + 1);

type Obj = { body: string; customMetadata?: Record<string, string> };
const live = new Map<string, Obj>();
const media = new Map<string, Obj>();
let siteRow: { indexable: number; live_version_id: string } | null = { indexable: 1, live_version_id: V1 };
let uploadRow: { ok: number } | null = { ok: 1 };
let onGet: ((key: string) => void) | null = null;

const bucket = (name: string, store: Map<string, Obj>) => ({
  async head(key: string) {
    bump(`${name}.head`);
    const object = store.get(key);
    return object ? { key, customMetadata: object.customMetadata ?? {} } : null;
  },
  async get(key: string) {
    bump(`${name}.get`);
    onGet?.(key);
    const object = store.get(key);
    return object ? { key, customMetadata: object.customMetadata ?? {}, arrayBuffer: async () => new TextEncoder().encode(object.body).buffer } : null;
  },
});

const db = {
  prepare: (sql: string) => ({
    bind: (..._args: unknown[]) => ({
      async first() {
        bump("D1");
        if (sql.includes("FROM sites WHERE slug")) return siteRow;
        if (sql.includes("FROM uploads")) return uploadRow;
        return null;
      },
    }),
  }),
};

const cacheStore = new Map<string, { body: ArrayBuffer; status: number; headers: [string, string][] }>();
const fakeCache = {
  async match(request: Request) {
    bump("cache.match");
    const hit = cacheStore.get(request.url);
    if (hit === undefined) return undefined;
    const headers = new Headers(hit.headers);
    headers.set("cf-cache-status", "HIT");
    headers.set("age", "7");
    return new Response(hit.body, { status: hit.status, headers });
  },
  async put(request: Request, response: Response) {
    bump("cache.put");
    cacheStore.set(request.url, { body: await response.arrayBuffer(), status: response.status, headers: [...response.headers] });
  },
};

const env = (root = ROOT) =>
  ({
    ROOT_DOMAIN: root,
    LIVE: bucket("LIVE", live),
    MEDIA: bucket("MEDIA", media),
    DB: db,
    SECURITY_TXT_EXPIRES: "2027-09-24T00:00:00.000Z",
    ENVIRONMENT: "development",
  }) as unknown as Env;

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (promise: Promise<unknown>) => pending.push(promise), passThroughOnException() {} } as unknown as ExecutionContext;
type IncomingRequest = Parameters<typeof worker.fetch>[0];

async function call(url: string, init: RequestInit = {}, root = ROOT) {
  for (const key of Object.keys(counts)) delete counts[key];
  const response = await worker.fetch(new Request(url, init) as IncomingRequest, env(root), ctx);
  await Promise.all(pending.splice(0));
  return { response, ops: { ...counts } };
}

const at = (path: string) => `https://${SLUG}.${ROOT}${path}`;
const photo = `https://media.${ROOT}/${SITE}/${UPLOAD}.webp`;
const names = (headers: Headers) => [...headers.keys()].sort();

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal("caches", { default: fakeCache });
});
afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
beforeEach(() => {
  cacheStore.clear();
  live.clear();
  media.clear();
  siteRow = { indexable: 1, live_version_id: V1 };
  uploadRow = { ok: 1 };
  onGet = null;
  live.set(livePointerKey(SLUG), { body: "", customMetadata: { siteId: SITE, versionId: V1, businessName: "Joes Plumbing" } });
  for (const page of ["home", "services"] as const) live.set(livePageKey(SLUG, V1, page), { body: `<p>${page}</p>` });
  media.set(mediaKey(SITE, UPLOAD), { body: "RIFFxxxxWEBP" });
});

describe("photos of a taken-down site", () => {
  it("reads R2 first, asks D1 only for a stored photo, and then keeps the 404 for 60 s: the second request costs no R2 and no D1", async () => {
    siteRow = null;
    uploadRow = null; // SERVABLE joins sites on taken_down_at IS NULL, so a down site's photo has no row
    const first = await call(photo);
    expect(first.response.status).toBe(404);
    expect([first.ops["MEDIA.get"], first.ops["D1"], first.ops["cache.put"]]).toEqual([1, 1, 1]);
    expect(cacheStore.get(mediaUrl(ROOT, SITE, UPLOAD))?.headers).toContainEqual(["cache-control", "public, s-maxage=60"]);

    const second = await call(`${photo}?x=1`);
    expect(second.response.status).toBe(404);
    expect(second.ops["MEDIA.get"] ?? 0).toBe(0);
    expect(second.ops["D1"] ?? 0).toBe(0);
    expect(second.response.headers.get("cache-control")).toBe("no-store");
    expect(second.response.headers.get("x-robots-tag")).toBe("noindex");
    expect(second.response.headers.get("age")).toBeNull();
    expect(second.response.headers.get("cf-cache-status")).toBeNull();
  });

  it("never asks D1 about an id with no stored photo (Decision 24), and caches nothing for it", async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { response, ops } = await call(`https://media.${ROOT}/${SITE}/${crypto.randomUUID()}.webp`);
      expect(response.status).toBe(404);
      expect(ops["D1"] ?? 0).toBe(0);
      expect(ops["MEDIA.get"]).toBe(1);
      expect(ops["cache.put"] ?? 0).toBe(0);
    }
  });

  it("reads R2 once for a live site's photo (1 D1, 1 MEDIA.get) and serves it", async () => {
    const { response, ops } = await call(photo);
    expect(response.status).toBe(200);
    expect([ops["D1"], ops["MEDIA.get"]]).toEqual([1, 1]);
  });

  it("does not cache a stored photo's 503 when D1 fails", async () => {
    const failing = { ...env(), DB: { prepare: () => ({ bind: () => ({ first: async () => Promise.reject(new Error("d1 down")) }) }) } } as unknown as Env;
    const response = await worker.fetch(new Request(photo) as IncomingRequest, failing, ctx);
    await Promise.all(pending.splice(0));
    expect(response.status).toBe(503);
    expect(cacheStore.size).toBe(0);
  });
});

describe("edge-copy headers", () => {
  it("a photo hit sends exactly the header names a fresh photo sends", async () => {
    const fresh = (await call(photo)).response;
    const hit = (await call(photo)).response;
    expect(hit.status).toBe(200);
    expect(names(hit.headers)).toEqual(names(fresh.headers));
    expect(hit.headers.get("age")).toBeNull();
    expect(hit.headers.get("cf-cache-status")).toBeNull();
    expect(hit.headers.get("cache-control")).toBe(fresh.headers.get("cache-control"));
    expect(await hit.text()).toBe("RIFFxxxxWEBP");
  });

  it.each([1, 0])("a page hit sends exactly the header names a fresh page sends (indexable %i)", async (indexable) => {
    siteRow = { indexable, live_version_id: V1 };
    const fresh = (await call(at("/services"))).response;
    const hit = (await call(at("/services"))).response;
    expect(hit.status).toBe(200);
    expect(names(hit.headers)).toEqual(names(fresh.headers));
    expect(hit.headers.get("age")).toBeNull();
    expect(hit.headers.get("cf-cache-status")).toBeNull();
    expect(hit.headers.get("cache-control")).toBe("no-cache");
    expect(hit.headers.get("x-robots-tag")).toBe(indexable === 1 ? null : "noindex");
    expect(await hit.text()).toBe("<p>services</p>");
  });
});

describe("a page the site lacks", () => {
  it("costs 3 Class B the first time and 1 (the pointer head) from then on, with no D1 and no page get", async () => {
    const first = await call(at("/about"));
    expect(first.response.status).toBe(404);
    expect([first.ops["LIVE.head"], first.ops["LIVE.get"], first.ops["D1"] ?? 0]).toEqual([2, 1, 0]);
    expect(cacheStore.get(pageCacheUrl(ROOT, SLUG, V1, "about"))?.headers).toContainEqual(["cache-control", "public, s-maxage=60"]);

    const second = await call(at("/about?x=1"));
    expect(second.response.status).toBe(404);
    expect([second.ops["LIVE.head"], second.ops["LIVE.get"] ?? 0, second.ops["D1"] ?? 0]).toEqual([1, 0, 0]);
    expect(second.response.headers.get("cache-control")).toBe("no-store");
    expect(second.response.headers.get("age")).toBeNull();
    expect(await second.response.text()).toContain("Go to Joes Plumbing's page");
  });

  it("is cached under its own version: the next version's page is read afresh", async () => {
    await call(at("/about"));
    live.set(livePointerKey(SLUG), { body: "", customMetadata: { siteId: SITE, versionId: V2, businessName: "Joes Plumbing" } });
    live.set(livePageKey(SLUG, V2, "about"), { body: "<p>about</p>" });
    live.set(livePageKey(SLUG, V2, "home"), { body: "<p>home</p>" });
    siteRow = { indexable: 1, live_version_id: V2 };
    const { response } = await call(at("/about"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<p>about</p>");
  });

  it("keeps the approval-race re-read: a pointer that moved while the page was read serves the new version, and caches no 404 under the old one", async () => {
    live.set(livePageKey(SLUG, V2, "about"), { body: "<p>about v2</p>" });
    siteRow = { indexable: 1, live_version_id: V2 };
    onGet = (key) => {
      if (key === livePageKey(SLUG, V1, "about")) live.set(livePointerKey(SLUG), { body: "", customMetadata: { siteId: SITE, versionId: V2, businessName: "Joes Plumbing" } });
    };
    const { response } = await call(at("/about"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<p>about v2</p>");
    expect(cacheStore.has(pageCacheUrl(ROOT, SLUG, V1, "about"))).toBe(false);
  });

  it("is still an uncached 503 for a missing Home", async () => {
    live.delete(livePageKey(SLUG, V1, "home"));
    for (let attempt = 0; attempt < 2; attempt++) {
      const { response, ops } = await call(at("/"));
      expect(response.status).toBe(503);
      expect(ops["cache.put"] ?? 0).toBe(0);
      expect(ops["LIVE.get"]).toBe(1);
    }
  });
});

describe("the trailing-slash 301", () => {
  it("keeps the query string (utm and gclid survive)", async () => {
    const { response, ops } = await call(at("/services/?utm_source=google&gclid=abc"));
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(at("/services?utm_source=google&gclid=abc"));
    expect(ops["LIVE.head"] ?? 0).toBe(0);
  });

  it("adds nothing when there is no query", async () => {
    expect((await call(at("/services/"))).response.headers.get("location")).toBe(at("/services"));
  });
});

describe("plain http", () => {
  const hosts = [`${SLUG}.${ROOT}`, ROOT, `media.${ROOT}`, `www.${ROOT}`];

  it.each(hosts)("sends GET and HEAD on %s to the same https URL, path and query kept, without HSTS and with no read", async (host) => {
    for (const method of ["GET", "HEAD"]) {
      const { response, ops } = await call(`http://${host}/services/x?utm=1&b=2`, { method });
      expect(response.status, method).toBe(301);
      expect(response.headers.get("location"), method).toBe(`https://${host}/services/x?utm=1&b=2`);
      expect(response.headers.get("strict-transport-security"), method).toBeNull();
      expect(response.headers.get("cache-control"), method).toBe("no-store");
      expect(response.headers.get("x-robots-tag"), method).toBe("noindex");
      expect(ops, method).toEqual({});
    }
  });

  it("answers other methods over http with the plain 400 page, and does not run the form", async () => {
    const { response, ops } = await call(`http://${SLUG}.${ROOT}/_f/${SITE}`, { method: "POST", body: "name=Ann" });
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(await response.text()).toContain("<h1>Please use https</h1>");
    expect(ops).toEqual({});
  });

  it("serves https as before", async () => {
    expect((await call(at("/"))).response.status).toBe(200);
  });

  it.each(["localhost:8789", "dev.localhost:8789"])("leaves a %s root alone (local development is http)", async (root) => {
    const host = root === "localhost:8789" ? root : `x.${root}`;
    const { response } = await call(`http://${host}/`, {}, root);
    expect(response.status).not.toBe(301);
    expect(response.status).not.toBe(400);
  });
});
