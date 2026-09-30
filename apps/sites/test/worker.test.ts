import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { securityTxt } from "../src/apex.ts";
import type { Env } from "../src/env.ts";
import worker from "../src/index.ts";

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
// paths. The 404 names the business from the LIVE object's metadata alone and never asks D1, the one
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
    const paths = ["/robots.txt", "/wp-login.php", "/contact", "/_f/not-an-id/sent", ...Array.from({ length: 196 }, (_, i) => `/x${i}`)];
    for (const [i, path] of paths.entries()) {
      const method = i % 2 === 0 ? "GET" : "HEAD";
      const response = await worker.fetch(new Request(`https://joes.${ROOT}${path}`, { method }) as IncomingRequest, liveEnv, ctx);
      expect(response.status, path).toBe(404);
      if (method === "GET") expect(await response.text(), path).toContain('<p><a href="/">Go to Joe\'s Plumbing\'s page</a></p>');
    }
    expect(d1).toEqual([]);
    expect(heads).toEqual(paths.map(() => "joes.html"));
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
