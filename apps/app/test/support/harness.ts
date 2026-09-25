import { afterAll, beforeAll } from "vitest";
import { createTestHarness } from "wrangler";

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

  return { server, call, db, invite, signIn };
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
