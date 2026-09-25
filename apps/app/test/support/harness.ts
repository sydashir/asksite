import { afterAll, beforeAll } from "vitest";
import { createTestHarness } from "wrangler";
import { TURNSTILE_DUMMY_TOKEN, type SiteverifyCall } from "./turnstile.ts";

export const APP_ORIGIN = "https://app.localhost:8787";
export const ROOT = "localhost:8789";

export interface CallOptions {
  body?: unknown;
  cookie?: string;
  origin?: string | null;
  headers?: Record<string, string>;
  ip?: string;
}

export interface SignedIn {
  cookie: string;
  ownerId: string;
  siteId: string;
  email: string;
}

let ipCounter = 0;
/** A fresh documentation-range address per sign-in, so the 10-per-minute AUTH_RL never trips by accident. */
export const nextIp = (): string => `198.51.100.${(ipCounter++ % 250) + 1}`;

/**
 * The local rate limiter counts in fixed windows aligned to the wall-clock minute (miniflare's
 * ratelimit-object: `epoch = Math.floor(Date.now() / (period * 1e3))`), so a burst that crosses :00
 * starts a fresh count. Before a burst that must land in one window, this waits (at most 1 s more than
 * `needMs`) until the clock is at least 1 s past and `needMs` before a minute boundary.
 */
export async function awayFromMinuteBoundary(needMs = 5_000): Promise<void> {
  const ms = Date.now() % 60_000;
  const wait = ms < 1_000 ? 1_000 - ms : ms > 60_000 - needMs ? 61_000 - ms : 0;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

/** Starts the app Worker (with fakes) in the local runtime for one test file. */
export function useAppHarness() {
  const server = createTestHarness({ workers: [{ configPath: new URL("../wrangler.test.jsonc", import.meta.url) }] });

  // Explicit timeout: starting the local runtime takes a few seconds, whichever Vitest config runs this.
  beforeAll(async () => {
    await server.listen();
    await server.getWorker().applyD1Migrations("DB");
  }, 120_000);
  afterAll(async () => {
    await server.close();
  });

  async function call(method: string, path: string, options: CallOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { ...options.headers };
    if (options.origin !== null) headers["Origin"] = options.origin ?? APP_ORIGIN;
    if (options.cookie !== undefined) headers["Cookie"] = options.cookie;
    if (options.ip !== undefined) headers["CF-Connecting-IP"] = options.ip;
    let body: string | ArrayBuffer | undefined;
    if (options.body instanceof FormData) {
      // Encode the multipart body here: the harness's own fetch cannot serialise Node's FormData.
      const encoded = new Request("https://encode.invalid/", { method: "POST", body: options.body });
      headers["Content-Type"] = encoded.headers.get("Content-Type") ?? "";
      body = await encoded.arrayBuffer();
    } else if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    return server.fetch(`${APP_ORIGIN}${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
  }

  /** POST /api/auth/login from a fresh address, with a Turnstile token the fake siteverify accepts unless told otherwise (null: no token). */
  async function login(email: string, options: { ip?: string; turnstile?: string | null } = {}): Promise<Response> {
    const token = options.turnstile === undefined ? TURNSTILE_DUMMY_TOKEN : options.turnstile;
    return call("POST", "/api/auth/login", { body: { email }, ip: options.ip ?? nextIp(), headers: token === null ? {} : { "x-turnstile-token": token } });
  }

  /** What the fake siteverify has been sent, oldest first (test/support/fakes.ts). */
  async function siteverifyCalls(): Promise<SiteverifyCall[]> {
    return (await call("GET", "/__test/siteverify")).json() as Promise<SiteverifyCall[]>;
  }

  async function waitUntilSeen(path: string): Promise<{ count: number; pending: number }> {
    return (await call("GET", `/__test/wait-until?path=${encodeURIComponent(path)}`)).json() as Promise<{ count: number; pending: number }>;
  }

  /** How many promises requests to `path` have handed to ctx.waitUntil so far. */
  async function waitUntilCount(path: string): Promise<number> {
    return (await waitUntilSeen(path)).count;
  }

  /** Waits until every promise requests to `path` handed to ctx.waitUntil has settled. */
  async function backgroundDone(path: string): Promise<void> {
    await eventually(() => waitUntilSeen(path), (seen) => seen.pending === 0, `the background work of ${path}`);
  }

  /** The Worker's JSON log lines since the harness started or server.clearLogs(). */
  function logLines(): Array<Record<string, unknown>> {
    return server.getLogs().flatMap((entry) => {
      try {
        const line: unknown = JSON.parse(entry.message);
        return typeof line === "object" && line !== null ? [line as Record<string, unknown>] : [];
      } catch {
        return [];
      }
    });
  }

  async function db(): Promise<D1Like> {
    const env = (await server.getWorker().getEnv()) as { DB: D1Like };
    return env.DB;
  }

  async function invite(email: string): Promise<string> {
    const res = await call("POST", "/__test/invites", { body: { email } });
    return ((await res.json()) as { token: string }).token;
  }

  /** Invite + accept: a new owner with a new draft site and a session cookie. */
  async function signIn(email = `owner${Math.random().toString(36).slice(2, 10)}@example.com`): Promise<SignedIn> {
    const token = await invite(email);
    const res = await call("POST", "/api/auth/invite/accept", { body: { token }, ip: nextIp() });
    if (res.status !== 200) throw new Error(`accept failed: ${res.status} ${await res.text()}`);
    const { owner, siteId } = (await res.json()) as { owner: { id: string }; siteId: string };
    const cookie = (res.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
    return { cookie, ownerId: owner.id, siteId, email };
  }

  return { server, call, db, invite, signIn, login, siteverifyCalls, waitUntilCount, backgroundDone, logLines };
}

/** Polls `read` every 100 ms until `done` accepts its value (at most 5 s). */
export async function eventually<T>(read: () => T | Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 50; i += 1) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The part of D1Database the tests use (the Worker's own types stay out of the Node test build). */
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      run(): Promise<{ meta: { changes: number } }>;
      first<T = Record<string, unknown>>(): Promise<T | null>;
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
    };
  };
}

export async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Signs in and fills the questionnaire with valid answers. Returns the owner and the draft's rev. */
export async function readyOwner(h: ReturnType<typeof useAppHarness>, facts: unknown, brief: unknown) {
  const owner = await h.signIn();
  const res = await h.call("PATCH", `/api/sites/${owner.siteId}/draft`, { cookie: owner.cookie, body: { rev: 1, facts, brief } });
  if (res.status !== 200) throw new Error(`draft save failed: ${res.status}`);
  return { ...owner, rev: 2 };
}

/** Requests the first build and finishes it like the generator would. */
export async function builtOwner(h: ReturnType<typeof useAppHarness>, facts: unknown, brief: unknown) {
  const owner = await readyOwner(h, facts, brief);
  const res = await h.call("POST", `/api/sites/${owner.siteId}/generations`, { cookie: owner.cookie, body: {} });
  const { generation } = (await res.json()) as { generation: { id: string } };
  await h.call("POST", `/__test/generations/${generation.id}/finish`, { body: { status: "succeeded" } });
  return { ...owner, generationId: generation.id };
}
