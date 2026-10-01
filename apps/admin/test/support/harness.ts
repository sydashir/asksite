import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll } from "vitest";
import { createTestHarness } from "wrangler";

export const ADMIN_ORIGIN = "https://admin.localhost:8788";
export const TEAM = "https://test-team.cloudflareaccess.com";
export const AUD = "test-aud";

/** A signing key standing in for Cloudflare Access; the Worker trusts its public half (TEST_ACCESS_JWKS). */
const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
export const ACCESS_JWKS = { keys: [{ ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256" }] };

export async function accessToken(claims: { email?: string; aud?: string; iss?: string; expiresIn?: string; noExpiry?: boolean; noEmail?: boolean } = {}): Promise<string> {
  const jwt = new SignJWT(claims.noEmail === true ? {} : { email: claims.email ?? "admin@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(claims.iss ?? TEAM)
    .setAudience(claims.aud ?? AUD)
    .setIssuedAt();
  if (claims.noExpiry !== true) jwt.setExpirationTime(claims.expiresIn ?? "5m");
  return jwt.sign(privateKey);
}

export interface CallOptions {
  body?: unknown;
  token?: string | null;
  origin?: string | null;
  host?: string;
  /** More request headers, sent as given (a browser's Fetch Metadata, say). */
  headers?: Record<string, string>;
}

export const VALID_FACTS = {
  businessName: "Joe's Plumbing",
  trade: "plumbing",
  phone: "+15125550142",
  email: "office@joesplumbing.example",
  location: { city: "Austin", state: "TX" },
  serviceArea: { places: ["Austin"] },
  services: [{ name: "Drain cleaning" }],
} as const;

export function useAdminHarness(vars: Record<string, string> = {}) {
  const server = createTestHarness({
    workers: [{ configPath: new URL("../wrangler.test.jsonc", import.meta.url), vars: { TEST_ACCESS_JWKS: JSON.stringify(ACCESS_JWKS), ...vars } }],
  });
  // Explicit timeout: starting the local runtime takes a few seconds, whichever Vitest config runs this.
  beforeAll(async () => {
    await server.listen();
    await server.getWorker().applyD1Migrations("DB");
  }, 120_000);
  afterAll(async () => {
    await server.close();
  });

  async function call(method: string, path: string, options: CallOptions = {}): Promise<Response> {
    const headers: Record<string, string> = {};
    const token = options.token === undefined ? await accessToken() : options.token;
    if (token !== null) headers["Cf-Access-Jwt-Assertion"] = token;
    if (options.origin !== null) headers["Origin"] = options.origin ?? ADMIN_ORIGIN;
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    Object.assign(headers, options.headers);
    // The fetch under server.fetch (undici) always sets Sec-Fetch-Mode to its own mode, "cors". Miniflare's
    // entry Worker puts back a mode sent as MF-Sec-Fetch-Mode (its pass-through for the Vite plugin), so the
    // Worker sees the mode the test asked for (checked with an echo Worker: "navigate" arrives only this way).
    const mode = options.headers?.["Sec-Fetch-Mode"];
    if (mode !== undefined) headers["MF-Sec-Fetch-Mode"] = mode;
    return server.fetch(`https://${options.host ?? "admin.localhost:8788"}${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
  }

  async function db(): Promise<D1Like> {
    return ((await server.getWorker().getEnv()) as { DB: D1Like }).DB;
  }

  async function r2(name: "WORK" | "LIVE" | "MEDIA"): Promise<R2Like> {
    return ((await server.getWorker().getEnv()) as Record<string, R2Like>)[name]!;
  }

  /** An owner with a site waiting for review. */
  async function pendingSite(facts: object = VALID_FACTS, extra: { reviewsAreReal?: boolean } = {}) {
    const email = `owner${Math.random().toString(36).slice(2, 9)}@example.com`;
    const slug = `site-${Math.random().toString(36).slice(2, 9)}`;
    const res = await call("POST", "/__test/sites", { body: { email, slug, facts, ...extra }, token: null });
    const ids = (await res.json()) as { ownerId: string; siteId: string; versionId: string; htmlSha256: string };
    return { ...ids, email, slug };
  }

  async function outbox(to: string): Promise<Array<{ subject: string; text: string; tag: string }>> {
    const database = await db();
    for (let i = 0; i < 40; i += 1) {
      const { results } = await database.prepare("SELECT subject, text, tag FROM dev_outbox WHERE to_addr = ? ORDER BY id").bind(to).all<{ subject: string; text: string; tag: string }>();
      if (results.length > 0) return results;
      await new Promise((r) => setTimeout(r, 100));
    }
    return [];
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

  // waitUntilCount and backgroundDone are lane A's (apps/app/test/support/harness.ts:136-148), read from the test
  // Worker's /__test/wait-until.
  async function waitUntilSeen(path: string): Promise<{ count: number; pending: number }> {
    return (await call("GET", `/__test/wait-until?path=${encodeURIComponent(path)}`, { token: null })).json() as Promise<{ count: number; pending: number }>;
  }

  /** How many promises requests to `path` have handed to ctx.waitUntil so far. */
  async function waitUntilCount(path: string): Promise<number> {
    return (await waitUntilSeen(path)).count;
  }

  /** Waits until every promise requests to `path` handed to ctx.waitUntil has settled. */
  async function backgroundDone(path: string): Promise<void> {
    await eventually(() => waitUntilSeen(path), (seen) => seen.pending === 0, `the background work of ${path}`);
  }

  return { server, call, db, r2, pendingSite, outbox, logLines, waitUntilCount, backgroundDone };
}

/** Polls `read` every 100 ms until `done` accepts its value (at most 5 s); lane A's harness helper of the same name. */
async function eventually<T>(read: () => T | Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 50; i += 1) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      run(): Promise<{ meta: { changes: number } }>;
      first<T = Record<string, unknown>>(): Promise<T | null>;
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
    };
  };
}

export interface R2Like {
  get(key: string): Promise<{ text(): Promise<string>; customMetadata?: Record<string, string> } | null>;
  put(key: string, value: string): Promise<unknown>;
}

export async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
