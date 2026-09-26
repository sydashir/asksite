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
