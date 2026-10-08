// pnpm check:predeploy: the local go-live gate. It FAILS while anything is unready and lists what is missing by
// FIELD NAME, never by value: no line it prints is built from a config value, a build message or a guard's input.
// Local only (not in CI): it reads the four wrangler.jsonc files, runs both release guards on them, builds the app
// and admin PRODUCTION bundles (vite build --mode production; it never deploys) and reads their output, then rebuilds
// both in development mode so no deployable production build is left behind (F5: .wrangler/deploy/config.json points a
// bare `wrangler deploy` at the last build). See docs/runbooks/go-live.md.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { PLACEHOLDER_DATABASE_ID, PLACEHOLDER_DOMAIN } from "./deploy-check.ts";

export const APPS = ["app", "admin", "sites", "generator"] as const;
type App = (typeof APPS)[number];
const BUILT = ["app", "admin"] as const;
type Built = (typeof BUILT)[number];
const DAY = 86_400_000;

/** Vars that must hold a real value before go-live (#1, #2, #28; the Access values, F5). */
const MUST_BE_FILLED: Record<string, readonly string[]> = {
  app: ["ADMIN_NOTIFY_EMAILS", "SUPPORT_EMAIL", "TURNSTILE_SITE_KEY"],
  admin: ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "ADMIN_EMAILS", "SUPPORT_EMAIL"],
};

/** What the check needs from the build tooling, so the tests can run without building. */
export interface Builder {
  /** vite build --mode production for the app; true when it succeeded. */
  production(app: Built): boolean;
  /** Rebuilds in development mode and confirms the output is undeployable to production; true when it is. */
  restoreLocal(app: Built): boolean;
}

export interface PredeployInput {
  /** The folder that holds apps/<name>/wrangler.jsonc. */
  root: string;
  /** This repository's root: where the release guards live. */
  repoRoot: string;
  now: number;
  builder: Builder;
  /** The build output folder of the app or admin. */
  distDir(app: Built): string;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const isBlank = (value: unknown): boolean => typeof value !== "string" || value.trim() === "";

/** Every string value that holds the placeholder domain, as a field path. */
function placeholderPaths(value: unknown, path: string): string[] {
  if (typeof value === "string") return value.includes(PLACEHOLDER_DOMAIN) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((item, i) => placeholderPaths(item, `${path}[${i}]`));
  if (isObject(value)) return Object.entries(value).flatMap(([key, item]) => placeholderPaths(item, path === "" ? key : `${path}.${key}`));
  return [];
}

const databaseId = (config: Json): unknown => (Array.isArray(config["d1_databases"]) && isObject(config["d1_databases"][0]) ? config["d1_databases"][0]["database_id"] : undefined);
const varsOf = (config: Json): Json => (isObject(config["vars"]) ? config["vars"] : {});
const senderName = (config: Json): string | null => {
  const from = varsOf(config)["MAIL_FROM"];
  return typeof from === "string" ? from.split("<")[0]!.trim() : null;
};

/** One Worker's config problems. Field names and fixed words only. */
function workerProblems(app: App, config: Json, now: number): string[] {
  const at = `apps/${app}:`;
  const vars = varsOf(config);
  const problems = placeholderPaths(config, "").map((path) => `${at} ${path} holds the placeholder domain`);
  if (Array.isArray(config["d1_databases"])) {
    config["d1_databases"].forEach((db, i) => {
      if (isObject(db) && db["database_id"] === PLACEHOLDER_DATABASE_ID) problems.push(`${at} d1_databases[${i}].database_id is the all-zero placeholder`);
    });
  }
  for (const name of MUST_BE_FILLED[app] ?? []) {
    if (!(name in vars)) problems.push(`${at} vars.${name} is missing`);
    else if (isBlank(vars[name])) problems.push(`${at} vars.${name} is empty`);
  }
  // Decided 2026-10-01: refused, never trimmed (the release guards refuse the same).
  for (const [name, value] of Object.entries(vars)) {
    if (typeof value === "string" && value !== value.trim()) problems.push(`${at} vars.${name} has whitespace around it`);
  }
  const expires = vars["SECURITY_TXT_EXPIRES"];
  if (typeof expires === "string") {
    const days = (Date.parse(expires) - now) / DAY;
    if (!(days >= 30 && days <= 366)) problems.push(`${at} vars.SECURITY_TXT_EXPIRES is not 30 to 366 days ahead`);
  }
  return problems;
}

/** Runs one release guard on a config. Relays its one fixed message only when it is a plain refusal. */
function guardProblem(repoRoot: string, app: Built, configPath: string): string | null {
  const run = spawnSync(process.execPath, [join(repoRoot, "apps", app, "release-guard.ts"), configPath], { encoding: "utf8" });
  if (run.status === 0) return null;
  const lines = (run.stderr ?? "").split("\n").filter((line) => line.trim() !== "");
  const plain = run.status === 1 && lines.length > 0 && !lines.some((line) => /^\s+at /.test(line));
  return plain ? `release guard (${app}) refused: ${lines[lines.length - 1]}` : `release guard (${app}) did not run (exit ${String(run.status)}): run it by hand`;
}

/** The node: modules a bundle imports, by import syntax only (a word in a string or comment is not an import). */
export function nodeImports(js: string): string[] {
  const found = new Set<string>();
  for (const match of js.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["'](node:[A-Za-z0-9_/]+)["']/g)) found.add(match[1]!);
  return [...found].sort();
}

function walk(dir: string, visit: (path: string, name: string) => void): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, visit);
    else visit(path, entry);
  }
}

/** #43 and #37 on one app's production build output. */
function outputProblems(app: Built, dist: string): string[] {
  const problems: string[] = [];
  const imports = new Set<string>();
  for (const entry of existsSync(dist) ? readdirSync(dist) : []) {
    const dir = join(dist, entry);
    if (entry === "client" || !statSync(dir).isDirectory()) continue;
    walk(dir, (path, name) => {
      if (/\.(?:js|mjs|cjs)$/.test(name)) for (const specifier of nodeImports(readFileSync(path, "utf8"))) imports.add(specifier);
    });
  }
  for (const specifier of [...imports].sort()) problems.push(`apps/${app}: the production Worker bundle imports ${specifier} (built without nodejs_compat)`);
  let devVars = false;
  if (existsSync(dist)) walk(dist, (_path, name) => void (devVars ||= name.startsWith(".dev.vars")));
  if (devVars) problems.push(`apps/${app}: the build output holds a .dev.vars file`);
  return problems;
}

export function predeployProblems(input: PredeployInput): string[] {
  const { root, repoRoot, now, builder, distDir } = input;
  const problems: string[] = [];
  const configs: Partial<Record<App, Json>> = {};
  for (const app of APPS) {
    const path = join(root, "apps", app, "wrangler.jsonc");
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!isObject(parsed)) throw new Error("not an object");
      configs[app] = parsed;
    } catch {
      // One fixed line: the parser's own message quotes the offending text, which may be a value.
      problems.push(`apps/${app}: wrangler.jsonc is not plain JSON`);
    }
  }
  for (const app of APPS) {
    const config = configs[app];
    if (config !== undefined) problems.push(...workerProblems(app, config, now));
  }
  const ids = new Set(APPS.flatMap((app) => (configs[app] === undefined ? [] : [String(databaseId(configs[app]))])));
  if (ids.size > 1) problems.push("d1_databases[0].database_id is not the same in every Worker");
  const names = new Set(["app", "admin", "sites"].flatMap((app) => (configs[app as App] === undefined ? [] : [senderName(configs[app as App]!)])).filter((name) => name !== null));
  if (names.size > 1) problems.push("vars.MAIL_FROM sender name is not the same in app, admin and sites");
  for (const app of BUILT) {
    if (configs[app] === undefined) continue;
    const refused = guardProblem(repoRoot, app, join(root, "apps", app, "wrangler.jsonc"));
    if (refused !== null) problems.push(refused);
  }
  for (const app of BUILT) {
    try {
      if (builder.production(app)) problems.push(...outputProblems(app, distDir(app)));
      else problems.push(`apps/${app}: the production build failed (run: pnpm --filter @asksite/${app} run build:production)`);
    } finally {
      if (!builder.restoreLocal(app)) problems.push(`apps/${app}: could not leave a local-only build behind (run: pnpm --filter @asksite/${app} run build)`);
    }
  }
  return problems;
}

export function formatReport(problems: readonly string[]): string {
  if (problems.length === 0) return "check:predeploy: ready";
  return [`check:predeploy: ${problems.length} problem${problems.length === 1 ? "" : "s"} (field names only, never values)`, ...problems.map((line) => `  - ${line}`)].join("\n");
}

/** The real builds: output is discarded, because a build message can quote a config line. */
function realBuilder(repoRoot: string): Builder {
  const pnpm = (app: Built, script: string): boolean => spawnSync("pnpm", ["--filter", `@asksite/${app}`, "run", script], { cwd: repoRoot, stdio: "ignore" }).status === 0;
  return {
    production: (app) => pnpm(app, "build:production"),
    restoreLocal: (app) => {
      if (!pnpm(app, "build")) return false;
      try {
        const redirect = join(repoRoot, "apps", app, ".wrangler", "deploy", "config.json");
        const { configPath } = JSON.parse(readFileSync(redirect, "utf8")) as { configPath: string };
        const output = JSON.parse(readFileSync(resolve(join(redirect, ".."), configPath), "utf8")) as { name?: string };
        return typeof output.name === "string" && output.name.endsWith("-local");
      } catch {
        return false;
      }
    },
  };
}

function main(): void {
  const repoRoot = resolve(import.meta.dirname, "..");
  const problems = predeployProblems({ root: repoRoot, repoRoot, now: Date.now(), builder: realBuilder(repoRoot), distDir: (app) => join(repoRoot, "apps", app, "dist") });
  console.log(formatReport(problems));
  process.exitCode = problems.length === 0 ? 0 : 1;
}

if (import.meta.main) main();
