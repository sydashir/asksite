import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { at, ROOT, sitesHarness } from "./support/harness.ts";

const harness = sitesHarness();
beforeAll(async () => {
  await harness.start();
}, 120_000);
afterAll(async () => {
  await harness.server.close();
});

// Request and response types come from the harness (Miniflare), not the Workers runtime types.
type Init = NonNullable<Parameters<typeof harness.server.fetch>[1]>;
type HarnessResponse = Awaited<ReturnType<typeof harness.server.fetch>>;
const get = (url: string, init: Init = {}): Promise<HarnessResponse> => harness.server.fetch(url, { redirect: "manual", ...init });

function expectFixedPage(response: HarnessResponse, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("x-robots-tag")).toBe("noindex");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-security-policy")).toBe(
    `default-src 'none'; style-src 'unsafe-inline'; img-src https://media.${ROOT}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  );
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}

describe("apex", () => {
  it("serves the placeholder page with the abuse contact", async () => {
    const response = await get(`https://${ROOT}/`);
    expectFixedPage(response, 200);
    const body = await response.text();
    expect(body).toContain("<h1>Websites for local trades</h1>");
    expect(body).toContain('href="mailto:abuse@localhost"');
  });

  it("never sends HSTS for a localhost root (it would force https on every local project)", async () => {
    expect((await get(`https://${ROOT}/`)).headers.get("strict-transport-security")).toBeNull();
  });

  it("serves security.txt with Contact and Expires", async () => {
    const response = await get(`https://${ROOT}/.well-known/security.txt`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(await response.text()).toBe("Contact: mailto:security@localhost\nExpires: 2027-09-24T00:00:00.000Z\nPreferred-Languages: en\n");
  });

  it("answers any other apex path or method with the 404 page", async () => {
    expectFixedPage(await get(`https://${ROOT}/admin`), 404);
    expectFixedPage(await get(`https://${ROOT}/`, { method: "POST", body: "x" }), 404);
  });

  it("answers HEAD with headers and no body", async () => {
    const response = await get(`https://${ROOT}/`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(await response.text()).toBe("");
  });
});

describe("www", () => {
  it("redirects every path to the apex home page", async () => {
    const response = await get(`https://www.${ROOT}/some/path?q=1`);
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(`https://${ROOT}/`);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
  });
});

// A15 minor 7: the pages name no icon, so browsers ask every page's host for /favicon.ico. An empty
// answer they keep for a week, with no D1 or R2 read, instead of the 404 page on every visit.
describe("/favicon.ico", () => {
  it.each([`https://${ROOT}/favicon.ico`, at("joes", "/favicon.ico")])("%s is an empty 204 that browsers may keep for a week", async (url) => {
    for (const method of ["GET", "HEAD"]) {
      const response = await get(url, { method });
      expect(response.status, method).toBe(204);
      expect(response.headers.get("cache-control"), method).toBe("public, max-age=604800");
      expect(response.headers.get("x-robots-tag"), method).toBe("noindex");
      expect(await response.text(), method).toBe("");
    }
  });

  it("is still the 404 page for other methods and for hosts we do not serve", async () => {
    expectFixedPage(await get(at("joes", "/favicon.ico"), { method: "POST", body: "x" }), 404);
    expectFixedPage(await get(`https://a.b.${ROOT}/favicon.ico`), 404);
  });
});

describe("hosts we do not serve", () => {
  it.each([`app.${ROOT}`, `admin.${ROOT}`, `a.b.${ROOT}`, `jo.${ROOT}`, "joes.localhost:8790", "joes.example.com"])("%s gets the 404 page", async (host) => {
    expectFixedPage(await get(`https://${host}/`), 404);
  });

  it("a site host has only the 5 page paths, /favicon.ico and the form routes", async () => {
    for (const path of ["/", "/services", "/about", "/gallery", "/contact"]) {
      const response = await get(at("joes", path));
      expect(response.status, path).not.toBe(301);
      expect(response.headers.get("location"), path).toBeNull();
    }
    expect((await get(at("joes", "/favicon.ico"))).status).toBe(204);
    expectFixedPage(await get(at("joes", "/_f/not-an-id/sent")), 404);
    for (const path of ["/wp-admin", "/index.html", "/Services", "//services", "/services//", "/home", "/old-page"]) {
      expectFixedPage(await get(at("joes", path)), 404);
    }
  });

  it("sends a trailing slash on a non-Home page path to the page, uncached", async () => {
    for (const path of ["/services", "/about", "/gallery", "/contact"]) {
      for (const method of ["GET", "HEAD"]) {
        const response = await get(at("joes", `${path}/`), { method });
        expect(response.status, path).toBe(301);
        expect(response.headers.get("location"), path).toBe(at("joes", path));
        expect(response.headers.get("cache-control"), path).toBe("no-store");
        expect(response.headers.get("x-robots-tag"), path).toBe("noindex");
      }
    }
  });
});
