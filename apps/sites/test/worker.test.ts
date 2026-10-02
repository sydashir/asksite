import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { securityTxt } from "../src/apex.ts";
import type { Env } from "../src/env.ts";
import worker from "../src/index.ts";
import { livePageKey, livePointerKey, pageCacheUrl } from "@asksite/core";
import { PAGE_IDS, PAGES } from "@asksite/site-schema";

// The handler run directly in Node: what the workerd harness cannot show. workerd itself drops a HEAD
// response's body on the wire (checked with a raw socket), so only here can a test see that the
// handler drops it too; and here each request's log line can be read.
const ROOT = "asksite.example";
const env = (expires = "2027-09-24T00:00:00.000Z") => ({ ROOT_DOMAIN: ROOT, SECURITY_TXT_EXPIRES: expires }) as Env;
const ctx = {} as ExecutionContext;
// The request type the runtime hands the handler; Node's Request has no `cf`, which the handler never reads.
type IncomingRequest = Parameters<typeof worker.fetch>[0];
const call = (url: string, init: RequestInit = {}) => worker.fetch(new Request(url, init) as IncomingRequest, env(), ctx);

let log: MockInstance<typeof console.log>;
beforeEach(() => {
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  log.mockRestore();
});

describe("the fetch handler", () => {
  it("answers HEAD with the headers and no body", async () => {
    const response = await call(`https://${ROOT}/`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(response.body).toBeNull();
  });

  it("logs one line per request: route, status and time, nothing from the request", async () => {
    await call(`https://${ROOT}/`, { headers: { "CF-Connecting-IP": "203.0.113.7", Cookie: "session=secret-cookie", "User-Agent": "probe-agent" } });
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toEqual({ worker: "asksite-sites", route: "apex", status: 200, ms: expect.any(Number) });
  });

  it("serves security.txt to GET and HEAD only", async () => {
    expect((await call(`https://${ROOT}/.well-known/security.txt`, { method: "POST", body: "x" })).status).toBe(404);
  });

  it("sends redirects and security.txt uncached, unindexed and unsniffed", async () => {
    for (const url of [`https://www.${ROOT}/a?b=1`, `https://${ROOT}/.well-known/security.txt`]) {
      const response = await call(url);
      expect(response.headers.get("cache-control"), url).toBe("no-store");
      expect(response.headers.get("x-robots-tag"), url).toBe("noindex");
      expect(response.headers.get("x-content-type-options"), url).toBe("nosniff");
    }
  });
});

describe("security.txt", () => {
  it("is not served at all when SECURITY_TXT_EXPIRES is not a date", async () => {
    const response = securityTxt(env("next year"));
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toContain("<h1>Page not found</h1>");
  });

  it("writes Expires in RFC 3339 form whatever ISO 8601 form was set", async () => {
    expect(await securityTxt(env("2027-09-24")).text()).toContain("\nExpires: 2027-09-24T00:00:00.000Z\n");
  });
});

// Pin added after Task 13's brief (test-only): with the key check removed, hashIp still throws and the
// fetch wrapper still answers 503, so only the log line shows the Worker is misconfigured (Decision 21).
describe("the contact form without IP_HASH_KEY", () => {
  it("answers 503 before touching any binding and logs the site id with the code misconfigured", async () => {
    const siteId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    const response = await call(`https://joes.${ROOT}/_f/${siteId}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "name=Al&phone=5125550199",
    });
    expect(response.status).toBe(503);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      worker: "asksite-sites", route: "form", status: 503, ms: expect.any(Number), siteId, code: "misconfigured",
    });
  });
});

// QA-2 RU(3) review I-1: live slugs are public, so a script can send a live host any number of wrong
// paths. The 404 names the business from the LIVE pointer's metadata alone and never asks D1, the one
// single-threaded database every Worker shares (Decision 24). Only here can a test count the reads.
describe("the 404 page on a live host", () => {
  it("answers a burst of wrong paths with the link, one R2 head each and no D1 query", async () => {
    const heads: string[] = [];
    const LIVE = {
      head: async (key: string) => {
        heads.push(key);
        return { customMetadata: { siteId: "7c9e6679-7425-40de-944b-e07fc1f90ae7", versionId: "v", businessName: "Joe's Plumbing" } };
      },
    };
    // A D1 that would call the site live, recording every use of the binding.
    const d1: string[] = [];
    const statement = { bind: () => statement, first: async () => ({ indexable: 1, live_version_id: "v" }) };
    const DB = new Proxy({}, { get: (_, key) => (d1.push(String(key)), () => statement) });
    const liveEnv = { ...env(), LIVE, DB } as unknown as Env;
    const paths = ["/robots.txt", "/wp-login.php", "/old-page", "/_f/not-an-id/sent", ...Array.from({ length: 196 }, (_, i) => `/x${i}`)];
    for (const [i, path] of paths.entries()) {
      const method = i % 2 === 0 ? "GET" : "HEAD";
      const response = await worker.fetch(new Request(`https://joes.${ROOT}${path}`, { method }) as IncomingRequest, liveEnv, ctx);
      expect(response.status, path).toBe(404);
      if (method === "GET") expect(await response.text(), path).toContain('<p><a href="/">Go to Joe\'s Plumbing\'s page</a></p>');
    }
    expect(d1).toEqual([]);
    expect(heads).toEqual(paths.map(() => livePointerKey("joes")));
  });
});

// A16 routing is security: the Worker never builds an R2 key from the request path. Whatever the path, every LIVE
// read is the site's pointer or one of the 5 page keys of the version the pointer names, and a slug with no pointer
// never reaches D1.
describe("page routing on a site host", () => {
  const slug = "joes";
  const SITE_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  const VERSION = "0b0c2d3e-4f50-4a6b-8c7d-8e9fa0b1c2d3";
  const POINTER = { siteId: SITE_ID, versionId: VERSION, businessName: "Joe's Plumbing" };
  const hostile = ["/../x", "/%2e%2e/x", "/services/../about", "/services%2F..%2Fabout", "//services", "/SERVICES", "/services.html", "/index.html", "/contact#x", "/services/", "/services//", "/__proto__", "/constructor"];
  const cache = new Map<string, Response>();

  beforeEach(() => {
    cache.clear();
    vi.stubGlobal("caches", { default: { match: async (request: Request) => cache.get(request.url)?.clone(), put: async (request: Request, response: Response) => void cache.set(request.url, response) } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** LIVE and D1 that record every read. `pointer` null = no pointer; `pages` are the page objects that exist. */
  function recording(pointer: Record<string, string> | null, pages: Partial<Record<string, string>> = {}, live: Record<string, unknown> | null = { indexable: 1, live_version_id: VERSION }) {
    const heads: string[] = [];
    const gets: string[] = [];
    const d1: string[] = [];
    const LIVE = {
      head: async (key: string) => (heads.push(key), pointer === null ? null : { customMetadata: pointer }),
      get: async (key: string) => (gets.push(key), key in pages ? { arrayBuffer: async () => new TextEncoder().encode(pages[key]).buffer } : null),
    };
    const statement = { bind: () => statement, first: async () => (d1.push("first"), live) };
    const DB = { prepare: () => statement };
    return { heads, gets, d1, env: { ...env(), LIVE, DB } as unknown as Env };
  }
  const waiting: Promise<unknown>[] = [];
  const request = async (siteEnv: Env, path: string, method = "GET") => {
    const response = await worker.fetch(new Request(`https://${slug}.${ROOT}${path}`, { method }) as IncomingRequest, siteEnv, { waitUntil: (p: Promise<unknown>) => waiting.push(p) } as unknown as ExecutionContext);
    await Promise.all(waiting.splice(0));
    return response;
  };

  it("reads only the pointer or a page of the pointer's version from LIVE, whatever the path", async () => {
    const { heads, gets, env: siteEnv } = recording(POINTER);
    for (const path of [...hostile, ...PAGE_IDS.map((page) => PAGES[page].path)]) for (const method of ["GET", "HEAD"]) await request(siteEnv, path, method);
    expect(heads.length + gets.length).toBeGreaterThan(0);
    const allowed = new Set([livePointerKey(slug), ...PAGE_IDS.map((page) => livePageKey(slug, VERSION, page))]);
    for (const key of [...heads, ...gets]) expect(allowed.has(key), key).toBe(true);
    expect(heads.every((key) => key === livePointerKey(slug))).toBe(true);
  });

  // The pointer and the version-scoped keys are in LIVE's namespace, not the site's URL space.
  it.each([`/${slug}`, `/${slug}/${VERSION}/home.html`, `/${slug}/${VERSION}/`, `/__v/${VERSION}/`, `/__v/${VERSION}/services`, `/${VERSION}/home.html`])(
    "never serves %s, answers the named 404, and reads no page",
    async (path) => {
      const { heads, gets, d1, env: siteEnv } = recording(POINTER, { [livePageKey(slug, VERSION, "home")]: "<p>home</p>" });
      const response = await request(siteEnv, path);
      expect(response.status).toBe(404);
      expect(await response.text()).toContain("Go to Joe's Plumbing's page");
      expect({ heads, gets, d1 }).toEqual({ heads: [livePointerKey(slug)], gets: [], d1: [] });
    },
  );

  it("answers 503 and reads no page when the pointer's version is not an id", async () => {
    for (const versionId of ["", "../x", "not-an-id", `${VERSION}/../other`, VERSION.toUpperCase()]) {
      const { gets, d1, env: siteEnv } = recording({ ...POINTER, versionId });
      for (const page of PAGE_IDS) expect((await request(siteEnv, PAGES[page].path)).status, `${versionId} ${page}`).toBe(503);
      expect({ gets, d1 }, versionId).toEqual({ gets: [], d1: [] });
    }
    const { gets, env: siteEnv } = recording({ siteId: SITE_ID });
    expect((await request(siteEnv, "/")).status).toBe(503);
    expect(gets).toEqual([]);
  });

  it("answers 503 when the pointer read fails, and never reaches D1", async () => {
    const d1: string[] = [];
    const LIVE = { head: async () => { throw new Error("R2 is unavailable"); } };
    const DB = new Proxy({}, { get: (_, key) => (d1.push(String(key)), () => { throw new Error("D1 must not be read"); }) });
    for (const page of PAGE_IDS) expect((await request({ ...env(), LIVE, DB } as unknown as Env, PAGES[page].path)).status, page).toBe(503);
    expect(d1).toEqual([]);
  });

  describe("what a request costs (Decision 24)", () => {
    it("a wrong path is one LIVE head and no D1", async () => {
      const { heads, gets, d1, env: siteEnv } = recording(POINTER);
      expect((await request(siteEnv, "/old-page")).status).toBe(404);
      expect({ heads: heads.length, gets: gets.length, d1 }).toEqual({ heads: 1, gets: 0, d1: [] });
    });

    it("a missing optional page is one get, the pointer read twice (A16-4c: once more when the page is gone), and no D1", async () => {
      const { heads, gets, d1, env: siteEnv } = recording(POINTER, { [livePageKey(slug, VERSION, "home")]: "<p>home</p>" });
      const response = await request(siteEnv, "/gallery");
      expect(response.status).toBe(404);
      expect(await response.text()).toContain("Go to Joe's Plumbing's page");
      expect({ heads: heads.length, gets, d1 }).toEqual({ heads: 2, gets: [livePageKey(slug, VERSION, "gallery")], d1: [] });
    });

    it("a missing Home page behind a pointer is a 503, with no D1", async () => {
      const { d1, env: siteEnv } = recording(POINTER);
      expect((await request(siteEnv, "/")).status).toBe(503);
      expect(d1).toEqual([]);
    });

    it("an unknown slug on any page path is one head and no D1", async () => {
      for (const page of PAGE_IDS) {
        const { heads, gets, d1, env: siteEnv } = recording(null);
        expect((await request(siteEnv, PAGES[page].path)).status, page).toBe(404);
        expect({ heads: heads.length, gets: gets.length, d1 }, page).toEqual({ heads: 1, gets: 0, d1: [] });
      }
    });

    it("an existing page is at most one D1 read per cache fill, none while it is cached", async () => {
      const { d1, env: siteEnv } = recording(POINTER, { [livePageKey(slug, VERSION, "services")]: "<p>services</p>" });
      expect((await request(siteEnv, "/services")).status).toBe(200);
      expect(d1).toHaveLength(1);
      expect((await request(siteEnv, "/services")).status).toBe(200);
      expect((await request(siteEnv, "/services", "HEAD")).status).toBe(200);
      expect(d1).toHaveLength(1);
    });
  });

  // A16-4c: an approval switches the pointer, then deletes the replaced version's pages. A view that read the old pointer
  // meets its page gone; it reads the pointer once more and serves the version that names now.
  describe("a page that vanished under the pointer it read", () => {
    const NEXT = "1b2c3d4e-5f60-4a7b-8c8d-9e0fa1b2c3d4";
    /** LIVE whose pointer names VERSION until the first page get, which first switches it to `to` and removes VERSION's pages. */
    function switching(to: Record<string, string> | null, d1: Record<string, unknown> | null = { indexable: 1, live_version_id: NEXT }) {
      let pointer: Record<string, string> | null = POINTER;
      const heads: string[] = [];
      const gets: string[] = [];
      const pages: Record<string, string> = { [livePageKey(slug, NEXT, "services")]: "<p>services v2</p>", [livePageKey(slug, VERSION, "services")]: "<p>services v1</p>" };
      const LIVE = {
        head: async (key: string) => (heads.push(key), pointer === null ? null : { customMetadata: pointer }),
        get: async (key: string) => {
          gets.push(key);
          if (gets.length === 1) {
            pointer = to; // the approval switched the pointer ...
            delete pages[livePageKey(slug, VERSION, "services")]; // ... and its cleanup removed v1's pages
          }
          return key in pages ? { arrayBuffer: async () => new TextEncoder().encode(pages[key]).buffer } : null;
        },
      };
      const statement = { bind: () => statement, first: async () => d1 };
      return { heads, gets, env: { ...env(), LIVE, DB: { prepare: () => statement } } as unknown as Env };
    }

    it("serves the new version's page, under its own cache key, not a 404", async () => {
      const { heads, gets, env: siteEnv } = switching({ ...POINTER, versionId: NEXT });
      const response = await request(siteEnv, "/services");
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("<p>services v2</p>");
      expect(gets).toEqual([livePageKey(slug, VERSION, "services"), livePageKey(slug, NEXT, "services")]);
      expect(heads).toHaveLength(2);
      expect([...cache.keys()]).toEqual([pageCacheUrl(ROOT, slug, NEXT, "services")]);
    });

    it("still checks D1 for the new version: a pointer that D1 does not confirm is a 503", async () => {
      const { env: siteEnv } = switching({ ...POINTER, versionId: NEXT }, { indexable: 1, live_version_id: VERSION });
      expect((await request(siteEnv, "/services")).status).toBe(503);
      expect(cache.size).toBe(0);
    });

    it("gives today's answer when the pointer is unchanged, gone, or names no valid version (Home 503, another page the named 404)", async () => {
      for (const [name, to] of [["unchanged", POINTER], ["gone", null], ["invalid", { ...POINTER, versionId: "../x" }]] as const) {
        const siteEnv = switching(to).env;
        const other = await request(siteEnv, "/services");
        expect(other.status, name).toBe(404);
        const home = await request(switching(to).env, "/");
        expect(home.status, name).toBe(503);
      }
    });

    it("reads the pointer again only once: a second vanish is today's answer", async () => {
      let heads = 0;
      const LIVE = {
        head: async () => ({ customMetadata: { ...POINTER, versionId: heads++ === 0 ? VERSION : NEXT } }),
        get: async () => null,
      };
      const siteEnv = { ...env(), LIVE, DB: {} } as unknown as Env;
      expect((await request(siteEnv, "/services")).status).toBe(404);
      expect(heads).toBe(2);
    });
  });

  describe("the cache", () => {
    const pages = { [livePageKey(slug, VERSION, "services")]: "<p>services</p>" };

    it("answers browsers with no-cache and keeps an edge copy for 60 s under a key that carries the version", async () => {
      const { env: siteEnv } = recording(POINTER, pages);
      const response = await request(siteEnv, "/services");
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect([...cache.keys()]).toEqual([pageCacheUrl(ROOT, slug, VERSION, "services")]);
      const edge = cache.get(pageCacheUrl(ROOT, slug, VERSION, "services"));
      expect(edge?.headers.get("cache-control")).toBe("public, s-maxage=60");
      expect(await edge?.text()).toBe("<p>services</p>");
      // The edge copy differs from the response in its Cache-Control alone.
      const others = (headers: Headers) => [...headers].filter(([name]) => name !== "cache-control");
      expect(others(edge?.headers ?? new Headers())).toEqual(others(response.headers));
    });

    it("answers a cache hit with no-cache too, and never serves it for another version", async () => {
      const first = recording(POINTER, pages);
      await request(first.env, "/services");
      const second = recording(POINTER, pages);
      const hit = await request(second.env, "/services");
      expect(hit.status).toBe(200);
      expect(hit.headers.get("cache-control")).toBe("no-cache");
      expect(await hit.text()).toBe("<p>services</p>");
      expect(second.gets).toEqual([]);
      expect(second.d1).toEqual([]);
      // The pointer now names another version: the old entry is not in its key, so it is a miss.
      const next = "1b2c3d4e-5f60-4a7b-8c8d-9e0fa1b2c3d4";
      const moved = recording({ ...POINTER, versionId: next }, { [livePageKey(slug, next, "services")]: "<p>new services</p>" }, { indexable: 1, live_version_id: next });
      expect(await (await request(moved.env, "/services")).text()).toBe("<p>new services</p>");
    });

    it("answers 404 for a cached page once the pointer is gone", async () => {
      await request(recording(POINTER, pages).env, "/services");
      expect(cache.size).toBe(1);
      const gone = recording(null);
      expect((await request(gone.env, "/services")).status).toBe(404);
    });
  });
});

// Pin added after Task 14's brief (test-only): the workerd cron test proves which leads are deleted;
// only here can a test read the run's log line (design §7.3 item 5; one line with the count).
describe("the scheduled handler", () => {
  it("waits for the deletion and logs one line with the number of leads deleted", async () => {
    const db = {
      prepare: () => ({ bind: () => ({ run: () => new Promise((done) => setTimeout(() => done({ meta: { changes: 3 } }), 5)) }) }),
    } as unknown as D1Database;
    await worker.scheduled({ scheduledTime: Date.parse("2026-09-24T07:00:00.000Z"), cron: "0 7 * * *", noRetry: () => {} }, { DB: db } as Env);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({ worker: "asksite-sites", route: "cron_lead_retention", ms: expect.any(Number), deleted: 3 });
  });
});
