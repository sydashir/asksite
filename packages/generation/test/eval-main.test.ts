import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// The command's entry (additions E): the package script runs eval/main.ts, which runs cli.ts's main(); cli.ts only
// exports. Each test starts a new node whose environment holds PATH and the preloads only (no key variable of any
// kind) with both network traps preloaded, then a check that ends the child with exit code 3, before any eval module
// loads, unless both traps are in place. Nothing here can send a request, and a blocked one would print a trap line on
// the child's standard error, which every test checks.

const PACKAGE_DIR = fileURLToPath(new URL("../", import.meta.url));
const MAIN = fileURLToPath(new URL("../eval/main.ts", import.meta.url));
const CLI = fileURLToPath(new URL("../eval/cli.ts", import.meta.url));
const NET_TRAP = fileURLToPath(new URL("./support/net-trap.mjs", import.meta.url));
const SOCKET_TRAP = fileURLToPath(new URL("./support/socket-trap.mjs", import.meta.url));

const TRAPS_IN_PLACE = `import dns from "node:dns";
import net from "node:net";
const netTrap = globalThis.fetch?.[Symbol.for("asksite.netTrap")] === true;
const socketTrap = [net.Socket.prototype.connect, dns.lookup, dns.promises.lookup].every((fn) => fn?.[Symbol.for("asksite.socketTrap")] === true);
if (!netTrap || !socketTrap) process.exit(3);
`;

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** NODE_OPTIONS for a child: both traps, then the check that they are in place. */
function preloads(): string {
  const dir = mkdtempSync(join(tmpdir(), "asksite-eval-main-"));
  made.push(dir);
  const check = join(dir, "traps-in-place.mjs");
  writeFileSync(check, TRAPS_IN_PLACE);
  return `--import=${NET_TRAP} --import=${SOCKET_TRAP} --import=${check}`;
}

/** Runs `node <file> <args>` in the package folder, as the package script does, with no key in its environment. */
function run(file: string, args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env = { PATH: process.env.PATH ?? "", NODE_OPTIONS: preloads() };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { cwd: PACKAGE_DIR, env, stdio: ["ignore", "pipe", "pipe"], timeout: 25_000 });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("eval/main.ts, the command's entry (additions E)", () => {
  it("is what the package script runs", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.eval).toBe("node --env-file-if-exists=../../.env eval/main.ts");
  });

  it("is reached from the root script with the inner pnpm silenced, so it does not print the arguments again (fix round #14)", () => {
    const root = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    expect(root.scripts["eval:generation"]).toBe("pnpm --silent --filter @asksite/generation run eval");
  });

  it("makes a dry run by default: exit code 0, the dry-run header, no key present, nothing sent", async () => {
    const { code, stdout, stderr } = await run(MAIN, []);
    expect(code, stderr).toBe(0);
    const lines = stdout.trimEnd().split("\n");
    expect(lines[0]).toBe("Dry run: nothing is sent. A live run needs --live and --max-usd <US$>, the most it may spend.");
    expect(lines.filter((line) => line.includes("key present: yes"))).toEqual([]);
    expect(lines.at(-1)).toMatch(/^No model keys found: nothing to run\./);
    expect(stderr).toBe("");
  });

  it("refuses --live without --max-usd: exit code 2, the refusal alone, nothing built or sent", async () => {
    const { code, stdout, stderr } = await run(MAIN, ["--live"]);
    expect(code, stderr).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toBe("--live needs --max-usd <US$>, the most this run may spend, such as --max-usd 5. Nothing was sent.\n");
  });
});

describe("eval/cli.ts (additions E)", () => {
  it("only exports main(): run on its own, it prints nothing and sends nothing", async () => {
    expect(await run(CLI, [])).toEqual({ code: 0, stdout: "", stderr: "" });
  });
});
