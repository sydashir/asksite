// pnpm dev: builds the shared stylesheet, applies D1 migrations to the local state and starts every
// Worker that exists under apps/ with `wrangler dev` over https (design §10.1). All Workers share one
// local state folder, so D1, R2 and the queue are shared exactly as in production.
//
// Usage: pnpm dev                       (every Worker present)
//        pnpm dev --only sites          (a subset, by folder name)
//        pnpm dev --persist-to <dir>    (another local state folder; default .wrangler/state)
//
// Conventions for every Worker folder apps/<name>/:
// - wrangler.jsonc is plain JSON (no comments) and holds the PRODUCTION values;
// - .dev.vars.example holds the development values; it is copied to .dev.vars when that is missing;
// - a "build" script in its package.json, if any, runs first (e.g. a Vite client build);
// - `wrangler dev` rewrites every request's Host to the first route's zone when routes are present,
//   which breaks Host routing locally (verified with wrangler 4.138.0), so it runs a generated
//   apps/<name>/wrangler.dev.jsonc (gitignored): the same config without "routes".
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface DevWorker {
  name: string;
  port: number;
  inspectorPort: number;
  https: boolean;
}

export const DEV_WORKERS: readonly DevWorker[] = [
  { name: "sites", port: 8789, inspectorPort: 9239, https: true },
  { name: "app", port: 8787, inspectorPort: 9237, https: true },
  { name: "admin", port: 8788, inspectorPort: 9238, https: true },
  { name: "generator", port: 8790, inspectorPort: 9240, https: false },
];

const REPO = resolve(import.meta.dirname, "..");
const WRANGLER = join(REPO, "node_modules", ".bin", "wrangler");

/** The production config without "routes": the only difference between production and `pnpm dev`. */
export function devConfig(config: Record<string, unknown>): Record<string, unknown> {
  const { routes: _routes, ...rest } = config;
  return rest;
}

export function devArgs(worker: DevWorker, configFile: string, persistTo: string): string[] {
  return [
    "dev",
    "--config", configFile,
    "--port", String(worker.port),
    "--inspector-port", String(worker.inspectorPort),
    "--persist-to", persistTo,
    "--show-interactive-dev-session=false",
    ...(worker.https ? ["--local-protocol", "https"] : []),
  ];
}

/** Copies .dev.vars.example to .dev.vars when .dev.vars is missing. Returns true when it copied. */
export function ensureDevVars(dir: string): boolean {
  const target = join(dir, ".dev.vars");
  if (existsSync(target)) return false;
  copyFileSync(join(dir, ".dev.vars.example"), target);
  return true;
}

/** Writes apps/<name>/wrangler.dev.jsonc next to the real config (so relative paths stay valid). */
export function writeDevConfig(dir: string): string {
  const config = JSON.parse(readFileSync(join(dir, "wrangler.jsonc"), "utf8")) as Record<string, unknown>;
  const file = join(dir, "wrangler.dev.jsonc");
  writeFileSync(file, `${JSON.stringify(devConfig(config), null, 2)}\n`);
  return file;
}

// stdin is closed so wrangler never waits for an answer: with no terminal to read from it prints its
// "About to apply … continue?" question and answers it itself. With stdin inherited from a real
// terminal it waits for Y/n, and `pnpm dev` stops (verified in a pseudo-terminal, wrangler 4.138.0).
function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: REPO, stdio: ["ignore", "inherit", "inherit"] });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
}

export function parseOptions(argv: readonly string[]): { only: string[] | null; persistTo: string } {
  let only: string[] | null = null;
  let persistTo = ".wrangler/state";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--only") only = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (argv[i] === "--persist-to") persistTo = argv[++i] ?? persistTo;
    else throw new Error(`Unknown option ${argv[i]}. Use --only <names> or --persist-to <dir>.`);
  }
  return { only, persistTo };
}

function main(): void {
  const { only, persistTo } = parseOptions(process.argv.slice(2));
  const workers = DEV_WORKERS.filter((w) => existsSync(join(REPO, "apps", w.name, "wrangler.jsonc")) && (only === null || only.includes(w.name)));
  if (workers.length === 0) throw new Error("No Worker to start: check --only and the apps/ folder");

  run("pnpm", ["build:css"]);
  const configs = new Map<string, string>();
  for (const worker of workers) {
    const dir = join(REPO, "apps", worker.name);
    if (ensureDevVars(dir)) console.log(`created apps/${worker.name}/.dev.vars from .dev.vars.example`);
    configs.set(worker.name, writeDevConfig(dir));
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string; scripts?: Record<string, string> };
    if (pkg.scripts?.["build"] !== undefined) run("pnpm", ["--filter", pkg.name, "run", "build"]);
  }
  // Every Worker binds the same D1 database, so one migration run covers them all.
  run(WRANGLER, ["d1", "migrations", "apply", "asksite", "--local", "--persist-to", persistTo, "--config", configs.get(workers[0]?.name ?? "") ?? ""]);

  const children: ChildProcess[] = [];
  let stopping = false;
  const stop = (code: number) => {
    if (stopping) return;
    stopping = true;
    // The wranglers share this process group, so a signal to the whole group (Ctrl+C, or Playwright
    // stopping its web server) reaches them and their workerd directly; this covers a signal sent
    // to this process alone. wrangler stops its own workerd on SIGTERM.
    for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
    let waiting = children.filter((c) => c.exitCode === null).length;
    if (waiting === 0) process.exit(code);
    for (const child of children) child.once("exit", () => --waiting === 0 && process.exit(code));
    setTimeout(() => process.exit(code), 10_000).unref();
  };
  process.on("SIGINT", () => stop(0));
  process.on("SIGTERM", () => stop(0));

  for (const worker of workers) {
    const child = spawn(WRANGLER, devArgs(worker, configs.get(worker.name) ?? "", persistTo), { cwd: REPO, stdio: "inherit" });
    child.once("exit", (code) => {
      if (!stopping) {
        console.error(`apps/${worker.name} stopped (exit ${code}); stopping the others`);
        stop(1);
      }
    });
    children.push(child);
    console.log(`apps/${worker.name}: ${worker.https ? "https" : "http"}://localhost:${worker.port}`);
  }
  console.log("Sites: https://<slug>.localhost:8789/  Photos: https://media.localhost:8789/  Stop with Ctrl+C.");
}

if (import.meta.main) main();
