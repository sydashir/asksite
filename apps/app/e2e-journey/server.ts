// The journey server: the whole product in ONE local Workers runtime (wrangler's createTestHarness).
// The sites, app, admin and generator Workers run from their own wrangler.jsonc files with their
// .dev.vars.example values, share one in-memory D1, R2 and queue, and are served over https on port
// 8789 for every host (app.localhost, admin.localhost, <slug>.localhost, media.localhost) through
// router.ts. One runtime, because four `wrangler dev` processes sharing one local D1 file fail now
// and then under concurrent access with a local-only "internal error" (plan decision 28). A runtime
// serves the static files of one Worker only (the first with assets), so only the app keeps its
// assets here; the journey uses the admin's API.
//
// The journey costs nothing and sends nothing: it refuses to start when a model or mail key is set in
// the environment, or when any Worker's values name a real mailer or a real model provider.
// Port 8789 is shared with the sites e2e and `pnpm dev`: it is checked on both loopback addresses
// BEFORE the build (`--check-port`), and the proxy listens on both, so a clash is loud, never a
// request that reaches another server. Nothing is ever stopped for it.
//
// Playwright starts it after building the app (playwright.journey.config.ts). Stop: SIGTERM or Ctrl+C.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { parseDevVars } from "../build-config.ts";

export const PORT = 8789;
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const OUT = fileURLToPath(new URL("../.wrangler/journey/", import.meta.url));
const WORKERS = ["sites", "app", "admin", "generator"] as const;
type WorkerName = (typeof WORKERS)[number];
const SECRETS = new Set(["RESEND_API_KEY", "IP_HASH_KEY", "TURNSTILE_SECRET_KEY", "ANTHROPIC_API_KEY", "OPENAI_COMPAT_API_KEY"]);
/** Keys that would make the journey spend money or send real email. */
const FORBIDDEN_ENV = ["ANTHROPIC_API_KEY", "OPENAI_COMPAT_API_KEY", "RESEND_API_KEY"] as const;
const LOOPBACK = ["127.0.0.1", "::1"] as const;
/** An address family this machine does not have is skipped; any other error (EADDRINUSE) is a clash. */
const NO_SUCH_ADDRESS = new Set(["EADDRNOTAVAIL", "EAFNOSUPPORT"]);

interface Config {
  main: string;
  assets?: { directory: string };
  d1_databases?: Array<{ migrations_dir?: string }>;
  routes?: unknown;
  triggers?: unknown;
}

/** The production config with absolute paths, without routes (router.ts picks the Worker) or cron, over https. */
export function journeyConfig(config: Config, dir: string): Config & { dev: { local_protocol: "https" } } {
  const abs = (path: string) => fileURLToPath(new URL(path, `file://${dir}/`));
  const { routes: _routes, triggers: _triggers, ...rest } = config;
  return {
    ...rest,
    main: abs(config.main),
    ...(config.assets === undefined ? {} : { assets: { ...config.assets, directory: abs(config.assets.directory) } }),
    ...(config.d1_databases === undefined
      ? {}
      : { d1_databases: config.d1_databases.map((db) => (db.migrations_dir === undefined ? db : { ...db, migrations_dir: abs(db.migrations_dir) })) }),
    dev: { local_protocol: "https" },
  };
}

/** Why the journey must not start, or null. Reads only whether a variable is set, never its value. */
export function unsafeEnvironment(env: NodeJS.ProcessEnv): string | null {
  const set = FORBIDDEN_ENV.filter((name) => env[name] !== undefined && env[name] !== "");
  return set.length === 0 ? null : `${set.join(", ")} is set in the environment. The journey makes no real model call and sends no real email: run it with those variables removed (env -u ...).`;
}

/** Why a Worker's loaded values must not be used, or null: every mailer is the log mailer and every model the fake one. */
export function unsafeValues(name: WorkerName, values: Record<string, string>): string | null {
  if (name !== "generator" && values["MAILER"] !== "log") return `apps/${name} would use a real mailer: its .dev.vars.example must set MAILER=log`;
  if ((name === "generator" || name === "admin") && values["MODEL_PROVIDER"] !== "fake") return `apps/${name} would use a real model: its .dev.vars.example must set MODEL_PROVIDER=fake`;
  return null;
}

function workerValues(name: WorkerName): Record<string, string> {
  const values = parseDevVars(readFileSync(`${REPO}apps/${name}/.dev.vars.example`, "utf8"));
  const problem = unsafeValues(name, values);
  if (problem !== null) throw new Error(`journey server: ${problem}`);
  return values;
}

function workerInput(name: WorkerName) {
  const dir = `${REPO}apps/${name}`;
  const { assets, ...rest } = JSON.parse(readFileSync(`${dir}/wrangler.jsonc`, "utf8")) as Config;
  const config: Config = name === "app" && assets !== undefined ? { ...rest, assets } : rest;
  if (config.assets !== undefined) {
    // The build bakes the media host into _headers; it must be this server's.
    const headers = `${dir}/dist/client/_headers`;
    if (!existsSync(headers) || !readFileSync(headers, "utf8").includes(`https://media.localhost:${PORT}`))
      throw new Error(`apps/${name} is not built for localhost:${PORT}: run its "build" script (ROOT_DOMAIN from .dev.vars or .dev.vars.example)`);
  }
  const configPath = `${OUT}${name}.jsonc`;
  writeFileSync(configPath, JSON.stringify(journeyConfig(config, dir), null, 2));
  const values = workerValues(name);
  // One port for every host, so the origins in links and Origin checks use it too.
  if ("APP_ORIGIN" in values) values["APP_ORIGIN"] = `https://app.localhost:${PORT}`;
  if ("ADMIN_ORIGIN" in values) values["ADMIN_ORIGIN"] = `https://admin.localhost:${PORT}`;
  const entries = Object.entries(values);
  return {
    configPath,
    vars: Object.fromEntries(entries.filter(([key]) => !SECRETS.has(key))),
    secrets: Object.fromEntries(entries.filter(([key]) => SECRETS.has(key))),
  };
}

/** Listens on PORT at one loopback address. Resolves true when listening, false when this machine has no such address. */
function listenOn(server: Server, host: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => (NO_SUCH_ADDRESS.has(err.code ?? "") ? resolve(false) : reject(err)));
    server.listen(PORT, host, () => resolve(true));
  });
}

const clashMessage = (err: NodeJS.ErrnoException, host: string) =>
  `journey server: cannot listen on port ${PORT} at ${host} (${err.code ?? err.message}). Whatever holds it, such as pnpm dev or another test run, must finish first: wait and run again. Nothing was stopped.`;

/** Fails fast, before the build, when either loopback address already has a listener on PORT. */
async function checkPortFree(): Promise<void> {
  for (const host of LOOPBACK) {
    const probe = createServer();
    try {
      await listenOn(probe, host);
    } catch (err) {
      console.error(clashMessage(err as NodeJS.ErrnoException, host));
      process.exit(1);
    }
    await new Promise((resolve) => probe.close(resolve));
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const router = {
    config: {
      name: "journey-router",
      main: fileURLToPath(new URL("router.ts", import.meta.url)),
      compatibility_date: "2026-09-21",
      compatibility_flags: ["no_nodejs_compat", "no_nodejs_compat_v2"],
      services: [
        { binding: "APP", service: "asksite-app" },
        { binding: "ADMIN", service: "asksite-admin" },
        { binding: "SITES", service: "asksite-sites" },
      ],
      dev: { local_protocol: "https" as const },
    },
  };
  const server = createTestHarness({ root: REPO, workers: [router, ...WORKERS.map(workerInput)] });
  const { url } = await server.listen();
  await server.getWorker("asksite-app").applyD1Migrations("DB");
  // The runtime listens on a random port; this forwards the fixed one to it byte for byte (TLS
  // included), so browsers see https://<host>:8789 and the Workers see the real Host header.
  const forward = (socket: Socket) => {
    const upstream = connect(Number(url.port), "127.0.0.1");
    const close = () => {
      socket.destroy();
      upstream.destroy();
    };
    socket.on("error", close);
    upstream.on("error", close);
    socket.pipe(upstream).pipe(socket);
  };
  const proxies: Server[] = [];
  const stop = async (code = 0) => {
    for (const proxy of proxies) proxy.close();
    await server.close();
    process.exit(code);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  // Both loopback addresses: a listener on either one is a loud clash, and a browser that resolves
  // *.localhost to ::1 first still reaches this server.
  for (const host of LOOPBACK) {
    const proxy = createServer(forward);
    try {
      if (await listenOn(proxy, host)) proxies.push(proxy);
    } catch (err) {
      console.error(clashMessage(err as NodeJS.ErrnoException, host));
      await stop(1);
    }
  }
  console.log(`journey server ready: https://app.localhost:${PORT}/`);
}

if (import.meta.main) {
  const refusal = unsafeEnvironment(process.env);
  if (refusal !== null) {
    console.error(`journey server: ${refusal}`);
    process.exit(1);
  }
  if (process.argv.includes("--check")) {
    // Before the build: the same refusals as the start, for every Worker's values, then the port.
    for (const name of WORKERS) workerValues(name);
    await checkPortFree();
  } else await main();
}
