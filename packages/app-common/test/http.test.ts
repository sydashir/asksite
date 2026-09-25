import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  API_HEADERS,
  ApiError,
  apiHeaders,
  handleError,
  handleNotFound,
  rateLimit,
  readBytes,
  readJson,
  requireOrigin,
  reviewPageHeaders,
  secondsUntilUtcMidnight,
  type RateLimiter,
} from "../src/http.ts";

const ORIGIN = "https://app.asksite.example";

function makeApp(limiter: RateLimiter = { limit: async () => ({ success: true }) }) {
  const app = new Hono();
  app.use("/api/*", apiHeaders(), requireOrigin(() => ORIGIN));
  app.get("/api/ok", (c) => c.json({ ok: true }));
  app.post("/api/echo", async (c) => c.json(await readJson(c, z.strictObject({ name: z.string().max(5) }), 64)));
  app.post("/api/limited", async (c) => {
    await rateLimit(limiter, "key");
    return c.json({ ok: true });
  });
  app.get("/api/boom", () => {
    throw new Error("secret detail");
  });
  app.get("/api/framed", (c) => c.text("page", 200, { "X-Frame-Options": "SAMEORIGIN" }));
  app.notFound(handleNotFound);
  app.onError(handleError);
  return app;
}

const post = (path: string, body: string, headers: Record<string, string> = {}) =>
  makeApp().request(path, { method: "POST", body, headers: { Origin: ORIGIN, "Content-Type": "application/json", ...headers } });

describe("apiHeaders", () => {
  it("sets the API security headers on success, error and not-found responses", async () => {
    for (const path of ["/api/ok", "/api/boom", "/api/nope"]) {
      const res = await makeApp().request(path);
      for (const [name, value] of Object.entries(API_HEADERS)) expect(res.headers.get(name)).toBe(value);
    }
  });

  it("keeps a header the route set itself", async () => {
    const res = await makeApp().request("/api/framed");
    expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("sends HSTS only in production (Plan 2 decision 8: never from a localhost host)", async () => {
    const production = await makeApp().request("/api/ok", {}, { ENVIRONMENT: "production" });
    expect(production.headers.get("Strict-Transport-Security")).toBe("max-age=31536000; includeSubDomains");
    for (const env of [undefined, { ENVIRONMENT: "development" }]) {
      expect((await makeApp().request("/api/ok", {}, env)).headers.get("Strict-Transport-Security")).toBeNull();
    }
  });
});

describe("errors", () => {
  it("returns an ErrorBody with the status from ERROR_STATUS", async () => {
    const res = await makeApp().request("/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "Not found" } });
  });

  it("hides the message of an unexpected error", async () => {
    const res = await makeApp().request("/api/boom");
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain("secret detail");
    expect(JSON.parse(body)).toEqual({ error: { code: "internal", message: "Something went wrong. Please try again." } });
  });

  it("carries issues, currentRev and retryAfter (with the Retry-After header)", async () => {
    const app = new Hono();
    app.get("/x", () => {
      throw new ApiError("rate_limited", "Slow down", { retryAfter: 60 });
    });
    app.onError(handleError);
    const res = await app.request("/x");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(await res.json()).toEqual({ error: { code: "rate_limited", message: "Slow down", retryAfter: 60 } });
  });
});

describe("requireOrigin", () => {
  it("lets GET through without an Origin", async () => {
    expect((await makeApp().request("/api/ok")).status).toBe(200);
  });

  it("refuses a state-changing request from another origin or with no Origin", async () => {
    for (const origin of ["https://evil.example", ""]) {
      const res = await makeApp().request("/api/echo", {
        method: "POST",
        body: '{"name":"a"}',
        headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("forbidden");
    }
  });
});

describe("readJson", () => {
  it("parses and validates a JSON body", async () => {
    const res = await post("/api/echo", '{"name":"Joe"}');
    expect(await res.json()).toEqual({ name: "Joe" });
  });

  it("refuses a body that is not declared as JSON (403, like a cross-site form)", async () => {
    const res = await post("/api/echo", '{"name":"Joe"}', { "Content-Type": "text/plain" });
    expect(res.status).toBe(403);
  });

  it("returns 413 when the body is over the limit, even without Content-Length", async () => {
    const res = await post("/api/echo", JSON.stringify({ name: "x".repeat(100) }));
    expect(res.status).toBe(413);
  });

  it("returns 400 for malformed JSON and 422 with issues for a schema failure", async () => {
    expect((await post("/api/echo", "{nope")).status).toBe(400);
    const res = await post("/api/echo", '{"name":"toolong"}');
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; issues: Array<{ path: unknown[]; code: string }> } };
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.issues[0]).toMatchObject({ path: ["name"], code: "too_big" });
  });
});

describe("readBytes", () => {
  it("stops reading as soon as the limit is passed", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(10));
        if (pulled === 100) controller.close();
      },
    });
    const request = new Request("https://x.example/", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    await expect(readBytes(request, 25)).rejects.toMatchObject({ code: "payload_too_large" });
    expect(pulled).toBeLessThan(10);
  });

  it("trusts a declared Content-Length over the limit without reading", async () => {
    const request = new Request("https://x.example/", { method: "POST", body: "abc", headers: { "Content-Length": "999" } });
    await expect(readBytes(request, 10)).rejects.toMatchObject({ code: "payload_too_large" });
  });
});

describe("rateLimit", () => {
  it("maps a refused limit to 429 rate_limited with retryAfter 60", async () => {
    const res = await makeApp({ limit: async () => ({ success: false }) }).request("/api/limited", {
      method: "POST",
      headers: { Origin: ORIGIN },
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
  });
});

describe("secondsUntilUtcMidnight", () => {
  it("counts whole seconds to the next 00:00 UTC, at least 1", () => {
    expect(secondsUntilUtcMidnight(Date.UTC(2026, 8, 24, 23, 59, 0))).toBe(60);
    expect(secondsUntilUtcMidnight(Date.UTC(2026, 8, 24, 0, 0, 0))).toBe(86_400);
    expect(secondsUntilUtcMidnight(Date.UTC(2026, 8, 24, 23, 59, 59, 999))).toBe(1);
  });
});

describe("reviewPageHeaders", () => {
  it("sandboxes the stored page and allows framing only by our own origin (§7.4)", () => {
    expect(reviewPageHeaders("asksite.example")).toEqual({
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src https://media.asksite.example; form-action 'none'; frame-ancestors 'self'",
      "X-Frame-Options": "SAMEORIGIN",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex",
      "Cache-Control": "no-store",
    });
  });
});
