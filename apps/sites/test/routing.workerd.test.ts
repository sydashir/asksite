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

describe("hosts we do not serve", () => {
  it.each([`app.${ROOT}`, `admin.${ROOT}`, `a.b.${ROOT}`, `jo.${ROOT}`, "joes.localhost:8790", "joes.example.com"])("%s gets the 404 page", async (host) => {
    expectFixedPage(await get(`https://${host}/`), 404);
  });

  it("a site host has only / and the form routes", async () => {
    expectFixedPage(await get(at("joes", "/wp-admin")), 404);
    expectFixedPage(await get(at("joes", "/_f/not-an-id/sent")), 404);
  });
});
