import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEV_WORKERS, devArgs, devConfig, ensureDevVars, parseOptions, writeDevConfig } from "./dev.ts";

const made: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "asksite-dev-"));
  made.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe("pnpm dev helpers", () => {
  it("uses the design's local ports, https for all but the generator, and distinct inspector ports", () => {
    expect(DEV_WORKERS.map((w) => [w.name, w.port, w.https])).toEqual([
      ["sites", 8789, true], ["app", 8787, true], ["admin", 8788, true], ["generator", 8790, false],
    ]);
    expect(new Set(DEV_WORKERS.map((w) => w.inspectorPort)).size).toBe(4);
  });

  it("drops only the routes from the production config", () => {
    const config = { name: "asksite-sites", routes: [{ pattern: "*.asksite.example/*" }], vars: { A: "1" }, workers_dev: false };
    expect(devConfig(config)).toEqual({ name: "asksite-sites", vars: { A: "1" }, workers_dev: false });
  });

  it("keeps Node.js compatibility off in every Worker's dev config (A13)", () => {
    const repo = resolve(import.meta.dirname, "..");
    const present = DEV_WORKERS.filter((w) => existsSync(join(repo, "apps", w.name, "wrangler.jsonc")));
    expect(present.map((w) => w.name)).toContain("sites");
    for (const worker of present) {
      const config = JSON.parse(readFileSync(join(repo, "apps", worker.name, "wrangler.jsonc"), "utf8")) as Record<string, unknown>;
      const flags = devConfig(config)["compatibility_flags"] as string[];
      expect(flags).toEqual(expect.arrayContaining(["no_nodejs_compat", "no_nodejs_compat_v2"]));
      expect(flags.filter((flag) => flag.startsWith("nodejs"))).toEqual([]);
    }
  });

  it("writes wrangler.dev.jsonc next to the real config", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "wrangler.jsonc"), JSON.stringify({ name: "w", main: "src/index.ts", routes: [{ pattern: "x/*" }] }));
    const file = writeDevConfig(dir);
    expect(file).toBe(join(dir, "wrangler.dev.jsonc"));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ name: "w", main: "src/index.ts" });
  });

  it("builds the wrangler dev arguments", () => {
    const [sites, , , generator] = DEV_WORKERS;
    expect(devArgs(sites!, "apps/sites/wrangler.dev.jsonc", ".wrangler/state")).toEqual([
      "dev", "--config", "apps/sites/wrangler.dev.jsonc", "--port", "8789", "--inspector-port", "9239",
      "--persist-to", ".wrangler/state", "--show-interactive-dev-session=false", "--local-protocol", "https",
    ]);
    expect(devArgs(generator!, "g.jsonc", "s")).not.toContain("--local-protocol");
  });

  it("creates .dev.vars from the example only when it is missing", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".dev.vars.example"), "MAILER=log\n");
    expect(ensureDevVars(dir)).toBe(true);
    expect(readFileSync(join(dir, ".dev.vars"), "utf8")).toBe("MAILER=log\n");
    writeFileSync(join(dir, ".dev.vars"), "MAILER=resend\n");
    expect(ensureDevVars(dir)).toBe(false);
    expect(readFileSync(join(dir, ".dev.vars"), "utf8")).toBe("MAILER=resend\n");
  });

  it("parses --only and --persist-to and rejects anything else", () => {
    expect(parseOptions([])).toEqual({ only: null, persistTo: ".wrangler/state" });
    expect(parseOptions(["--only", "sites,app", "--persist-to", "x"])).toEqual({ only: ["sites", "app"], persistTo: "x" });
    expect(() => parseOptions(["--fast"])).toThrow("Unknown option --fast");
  });
});
