import { Brief, LIMITS, PatchDraftBody, SECTION_IDS, toIssues } from "@asksite/core";
import { DAYS, Facts, HIDEABLE_SECTIONS } from "@asksite/site-schema";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  API_HEADERS,
  ApiError,
  apiHeaders,
  DRAFT_JSON_MAX_BYTES,
  handleError,
  handleNotFound,
  JSON_MAX_DEPTH,
  JSON_MAX_ITEMS,
  JSON_MAX_KEYS,
  MAX_ISSUES,
  noteLog,
  rateLimit,
  readBytes,
  readJson,
  requireOrigin,
  reviewPageHeaders,
  secondsUntilUtcMidnight,
  type RateLimiter,
} from "../src/http.ts";
import * as appCommon from "../src/index.ts";

const ORIGIN = "https://app.asksite.example";
const LIST = z.strictObject({ items: z.array(z.string()) });

type ErrorJson = { error: { code: string; message: string; issues?: Array<{ path: unknown[]; code: string; message: string }> } };

/** Runs `run` with console.log captured and returns the JSON log lines it wrote. */
async function logLines(run: () => unknown): Promise<Array<Record<string, unknown>>> {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await run();
    return log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
  } finally {
    log.mockRestore();
  }
}

function makeApp(limiter: RateLimiter = { limit: async () => ({ success: true }) }) {
  const app = new Hono();
  app.use("/api/*", apiHeaders(), requireOrigin(() => ORIGIN));
  app.get("/api/ok", (c) => c.json({ ok: true }));
  app.get("/api/items/:id", (c) => c.json({ ok: true }));
  app.post("/api/list", async (c) => c.json(await readJson(c, LIST)));
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

describe("one log line per request", () => {
  it("logs a normal request once: route pattern, status and duration", async () => {
    const lines = await logLines(() => makeApp().request("/api/ok"));
    expect(lines).toEqual([{ route: "GET /api/ok", status: 200, ms: expect.any(Number) }]);
  });

  it("logs an ApiError request once, with its code (422 and 403)", async () => {
    expect(await logLines(() => post("/api/echo", '{"name":"toolong"}'))).toEqual([
      { route: "POST /api/echo", status: 422, ms: expect.any(Number), code: "validation_failed" },
    ]);
    expect(await logLines(() => post("/api/echo", '{"name":"Joe"}', { Origin: "https://evil.example" }))).toEqual([
      { route: "POST /api/*", status: 403, ms: expect.any(Number), code: "forbidden" },
    ]);
  });

  it("logs an unexpected error once, as internal with the error's class name and never its message", async () => {
    const lines = await logLines(() => makeApp().request("/api/boom"));
    expect(lines).toEqual([{ route: "GET /api/boom", status: 500, ms: expect.any(Number), code: "internal", error: "Error" }]);
    expect(JSON.stringify(lines)).not.toContain("secret detail");
  });

  it("logs a not-found once, with code not_found", async () => {
    expect(await logLines(() => makeApp().request("/api/nope"))).toEqual([
      { route: "GET /api/*", status: 404, ms: expect.any(Number), code: "not_found" },
    ]);
  });

  it("logs the route pattern, never the raw path or query", async () => {
    const lines = await logLines(() => makeApp().request("/api/items/tok_SECRET123?email=owner%40private.example"));
    expect(lines).toEqual([{ route: "GET /api/items/:id", status: 200, ms: expect.any(Number) }]);
    expect(JSON.stringify(lines)).not.toMatch(/SECRET123|private\.example/);
  });

  it("logs once even when apiHeaders itself fails on the answer (a Response with immutable headers)", async () => {
    const app = new Hono();
    app.use("/api/*", apiHeaders());
    app.get("/api/moved", () => Response.redirect("https://app.asksite.example/", 302));
    app.onError(handleError);
    let res: Response | undefined;
    const lines = await logLines(async () => {
      res = await app.request("/api/moved");
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ route: "GET /api/moved", status: res?.status });
  });

  it("adds a route's own fields to its one line, when it answers and when it refuses (noteLog)", async () => {
    const app = new Hono();
    app.use("/api/*", apiHeaders());
    app.get("/api/noted", (c) => {
      noteLog(c, { event: "kept" });
      return c.json({ ok: true });
    });
    app.post("/api/refused", (c) => {
      noteLog(c, { turnstile: "missing" });
      throw new ApiError("forbidden", "Please complete the security check and try again.");
    });
    app.onError(handleError);
    expect(await logLines(() => app.request("/api/noted"))).toEqual([{ route: "GET /api/noted", status: 200, ms: expect.any(Number), event: "kept" }]);
    expect(await logLines(() => app.request("/api/refused", { method: "POST" }))).toEqual([
      { route: "POST /api/refused", status: 403, ms: expect.any(Number), code: "forbidden", turnstile: "missing" },
    ]);
  });

  it("outside apiHeaders, handleError still logs each error exactly once", async () => {
    const app = new Hono();
    app.get("/x", () => {
      throw new ApiError("rate_limited", "Slow down", { retryAfter: 60 });
    });
    app.get("/y", () => {
      throw new TypeError("secret detail");
    });
    app.onError(handleError);
    expect(await logLines(() => app.request("/x"))).toEqual([{ route: "GET /x", status: 429, code: "rate_limited" }]);
    const lines = await logLines(() => app.request("/y"));
    expect(lines).toEqual([{ route: "GET /y", status: 500, code: "internal", error: "TypeError" }]);
    expect(JSON.stringify(lines)).not.toContain("secret detail");
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

describe("requireOrigin when the expected origin is not configured (fails closed)", () => {
  function appReading(env: Record<string, string>) {
    const app = new Hono();
    app.use("/api/*", apiHeaders(), requireOrigin((c) => c.env.APP_ORIGIN));
    app.get("/api/ok", (c) => c.json({ ok: true }));
    app.post("/api/echo", (c) => c.json({ ok: true }));
    app.notFound(handleNotFound);
    app.onError(handleError);
    return (path: string, method: string) => app.request(path, { method }, env);
  }

  for (const [state, env] of [["missing", {}], ["empty", { APP_ORIGIN: "" }]] as const) {
    it(`refuses GET and POST alike when APP_ORIGIN is ${state}: 403 forbidden and one log line naming the event and route`, async () => {
      const send = appReading(env);
      for (const [method, path] of [["GET", "/api/ok"], ["POST", "/api/echo"]] as const) {
        let res: Response | undefined;
        const lines = await logLines(async () => {
          res = await send(path, method); // the POST carries no Origin header: undefined must never equal undefined
        });
        expect(res?.status).toBe(403);
        expect(((await res?.json()) as ErrorJson).error.code).toBe("forbidden");
        expect(lines).toEqual([{ route: `${method} /api/*`, status: 403, ms: expect.any(Number), code: "forbidden", event: "origin_not_configured" }]);
      }
      let head: Response | undefined;
      await logLines(async () => {
        head = await send("/api/ok", "HEAD");
      });
      expect(head?.status).toBe(403);
    });
  }
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

  it("says a JSON body is too large to save, whether the Content-Length says so or the count does", async () => {
    for (const headers of [{}, { "Content-Length": "999" }]) {
      const res = await post("/api/echo", JSON.stringify({ name: "x".repeat(100) }), headers);
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: { code: "payload_too_large", message: "That is too large to save." } });
    }
  });

  it(`returns at most the first MAX_ISSUES (${MAX_ISSUES}) issues, in order`, async () => {
    const value = { items: Array.from({ length: 60 }, (_, i) => i) }; // 60 numbers: one issue each
    const all = toIssues(LIST.safeParse(value).error!);
    expect(all).toHaveLength(60);
    const res = await post("/api/list", JSON.stringify(value));
    expect(res.status).toBe(422);
    const { error } = (await res.json()) as ErrorJson;
    expect(error.issues).toEqual(all.slice(0, 50));
    expect(error.issues?.map((issue) => issue.path)).toEqual(Array.from({ length: 50 }, (_, i) => ["items", i]));
  });

  it("returns every issue when there are fewer than MAX_ISSUES", async () => {
    const value = { items: [1, 2, 3] };
    const res = await post("/api/list", JSON.stringify(value));
    expect(((await res.json()) as ErrorJson).error.issues).toEqual(toIssues(LIST.safeParse(value).error!));
  });
});

describe("DRAFT_JSON_MAX_BYTES", () => {
  it("holds the facts, brief and edits parts at their limits plus 4 KiB, so it never refuses a draft whose parts fit (A8c)", () => {
    expect(DRAFT_JSON_MAX_BYTES).toBeGreaterThanOrEqual(LIMITS.factsJsonMaxBytes + LIMITS.briefJsonMaxBytes + LIMITS.editsJsonMaxBytes + 4096);
  });
});

describe("readJson's shape guard (P4-6)", () => {
  /** Posts `value` to a route that reads it with readJson(schema, max) and echoes what it got. */
  async function readThrough<T>(schema: z.ZodType<T>, value: unknown, max?: number) {
    const app = new Hono();
    app.post("/api/in", async (c) => c.json({ value: await readJson(c, schema, max) }));
    app.onError(handleError);
    let res: Response | undefined;
    await logLines(async () => {
      res = await app.request("/api/in", { method: "POST", body: JSON.stringify(value), headers: { "Content-Type": "application/json" } });
    });
    return res!;
  }

  /** Reads `value` with a schema that accepts anything and counts how often zod ran. */
  async function guarded(value: unknown) {
    let zodRuns = 0;
    const counting = z.unknown().refine(() => {
      zodRuns += 1;
      return true;
    });
    const res = await readThrough(counting, value);
    return { res, zodRuns };
  }

  const refused = (path: unknown[], message: string) => ({ error: { code: "validation_failed", message, issues: [{ path, code: "too_big", message }] } });
  const keys = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));
  /** `levels` objects nested inside each other: { a: { a: … {} } }. */
  const nested = (levels: number): unknown => (levels === 1 ? {} : { a: nested(levels - 1) });

  it("has the limits 64 items, 64 keys and 16 levels, exported from app-common", () => {
    expect([JSON_MAX_ITEMS, JSON_MAX_KEYS, JSON_MAX_DEPTH, MAX_ISSUES]).toEqual([64, 64, 16, 50]);
    expect([appCommon.JSON_MAX_ITEMS, appCommon.JSON_MAX_KEYS, appCommon.JSON_MAX_DEPTH, appCommon.MAX_ISSUES]).toEqual([64, 64, 16, 50]);
  });

  it("refuses a list of 65 items with one clear issue, before zod runs", async () => {
    const { res, zodRuns } = await guarded({ list: Array.from({ length: 65 }, (_, i) => i) });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(refused(["list"], "A list has more than 64 items"));
    expect(zodRuns).toBe(0);
  });

  it("refuses an object of 65 keys with one clear issue, before zod runs", async () => {
    const { res, zodRuns } = await guarded({ outer: { inner: keys(65) } });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(refused(["outer", "inner"], "An object has more than 64 keys"));
    expect(zodRuns).toBe(0);
  });

  it("refuses 17 levels of nesting with one clear issue, before zod runs", async () => {
    const { res, zodRuns } = await guarded(nested(17));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(refused(Array.from({ length: 16 }, () => "a"), "The data is nested more than 16 levels deep"));
    expect(zodRuns).toBe(0);
  });

  it("lets a body exactly at each limit through to zod", async () => {
    for (const value of [{ list: Array.from({ length: 64 }, (_, i) => i) }, keys(64), nested(16)]) {
      const { res, zodRuns } = await guarded(value);
      expect(res.status).toBe(200);
      expect(zodRuns).toBe(1);
    }
  });

  it("lets the largest valid draft body through (every list at its schema maximum)", async () => {
    const photo = (i: number) => ({ url: `https://media.asksite.example/s/p${i}.jpg`, alt: `Finished job ${i}`, width: 1200, height: 800, caption: `Job ${i}` });
    const names = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);
    const facts = {
      businessName: "Joe's Plumbing",
      trade: "plumbing",
      phone: "+15125550142",
      email: "joe@example.com",
      location: { streetAddress: "1 Main St", city: "Austin", state: "TX", postalCode: "78701" },
      serviceArea: { places: names(30, "Town"), note: "Within 25 miles of downtown Austin" },
      hours: DAYS.map((day) => ({ days: [day], opens: "08:00", closes: "17:00" })),
      services: names(12, "Service").map((name) => ({ name, startingPrice: 89 })),
      licences: names(5, "License").map((label, i) => ({ label, number: `L-${i}` })),
      insured: true,
      yearFounded: 1998,
      emergency247: true,
      freeEstimates: true,
      testimonials: names(12, "Customer").map((name) => ({ quote: "Great work.", name, location: "Austin" })),
      heroPhoto: photo(0),
      photos: Array.from({ length: 12 }, (_, i) => photo(i + 1)),
      socialLinks: [
        { network: "facebook", url: "https://www.facebook.com/joes" },
        { network: "instagram", url: "https://www.instagram.com/joes" },
        { network: "google", url: "https://g.page/joes" },
        { network: "yelp", url: "https://www.yelp.com/biz/joes" },
        { network: "nextdoor", url: "https://nextdoor.com/pages/joes" },
        { network: "youtube", url: "https://www.youtube.com/@joes" },
        { network: "linkedin", url: "https://www.linkedin.com/company/joes" },
      ],
    };
    const brief = {
      tone: "friendly",
      goal: "call",
      differentiator: "Same-day service",
      notes: "Family owned.",
      comments: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`q${i}`, "A note"])), // Brief allows 20
      reviewsAreReal: true,
    };
    const edits = {
      baseGenerationId: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
      copy: {
        heroHeadline: "Plumbing done right",
        heroSubheadline: "Fast and friendly",
        ctaText: "Call now",
        about: "About us",
        sectionIntros: { services: "What we do", gallery: "Our work", faq: "Questions", contact: "Get in touch" },
        serviceDescriptions: Object.fromEntries(facts.services.map((service) => [service.name, "What this includes"])),
        faq: Array.from({ length: 8 }, (_, i) => ({ question: `Question ${i}?`, answer: "Yes." })),
      },
      order: [...SECTION_IDS],
      hidden: [...HIDEABLE_SECTIONS],
      theme: { palette: "navy-orange", font: "clean" },
    };
    expect(Facts.safeParse(facts).success).toBe(true);
    expect(Brief.safeParse(brief).success).toBe(true);
    const body = { rev: 1, facts, brief, edits };
    expect(PatchDraftBody.safeParse(body).success).toBe(true);
    const res = await readThrough(PatchDraftBody, body);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { value: unknown }).value).toEqual(body);
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

  /** A request whose body arrives as chunks of these sizes, with no Content-Length; `cancelled` records a cancel. */
  function streamed(sizes: number[]) {
    const state = { cancelled: false };
    const chunks = [...sizes];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const size = chunks.shift();
        if (size === undefined) controller.close();
        else controller.enqueue(new Uint8Array(size));
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return { request: new Request("https://x.example/", { method: "POST", body, duplex: "half" } as RequestInit), state };
  }

  it("accepts a body of exactly the limit and refuses one byte more", async () => {
    expect((await readBytes(streamed([10, 10, 5]).request, 25)).byteLength).toBe(25);
    await expect(readBytes(streamed([10, 10, 6]).request, 25)).rejects.toMatchObject({ code: "payload_too_large" });
    const declared = new Request("https://x.example/", { method: "POST", body: "abc", headers: { "Content-Length": "3" } });
    expect(new TextDecoder().decode(await readBytes(declared, 3))).toBe("abc");
  });

  it("cancels the request stream once the limit is passed", async () => {
    const { request, state } = streamed([10, 10, 10, 10]);
    await expect(readBytes(request, 25)).rejects.toMatchObject({ code: "payload_too_large" });
    expect(state.cancelled).toBe(true);
  });

  it("says an upload is too large to upload, whether the Content-Length says so or the count does", async () => {
    const declared = new Request("https://x.example/", { method: "POST", body: "abc", headers: { "Content-Length": "999" } });
    for (const request of [declared, streamed([10, 10, 10]).request]) {
      await expect(readBytes(request, 25)).rejects.toMatchObject({ code: "payload_too_large", message: "That is too large to upload" });
    }
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
