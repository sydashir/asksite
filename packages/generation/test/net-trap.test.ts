import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

// The process-level network guard, test/support/net-trap.mjs, checked three ways: (a) in a child node started with it
// preloaded through NODE_OPTIONS, (b) in this vitest worker when the run itself preloads it, (c) its allowlist and its
// fetch on a stand-in global. Nothing here can reach a network: the child checks the trap is in place before it builds
// any adapter, the stand-in's "real fetch" is a mock, and the one real-global call below goes to a .invalid host (RFC
// 6761 section 6.4: it never resolves) after the trap's marker has been checked.

const MARK = Symbol.for("asksite.netTrap");
const TRAP_PATH = fileURLToPath(new URL("./support/net-trap.mjs", import.meta.url));

// Read before any test below imports net-trap.mjs into this worker, so it shows only what a NODE_OPTIONS preload did.
const fetchAtStart = globalThis.fetch;
const markedAtStart = (fetchAtStart as unknown as Record<symbol, unknown>)[MARK] === true;

interface FetchHolder {
  fetch: typeof fetch;
}
interface NetTrap {
  isAllowed(url: string): boolean;
  installNetTrap(target: FetchHolder): typeof fetch;
}
// A variable specifier, so TypeScript does not look for a declaration file for the plain .mjs module. Importing it
// installs the trap in this worker too, which no other test in this file depends on either way; other test files do not
// see it, as vitest runs each test file in its own isolated worker by default (isolate: true).
const loadTrap = async (): Promise<NetTrap> => (await import(TRAP_PATH)) as NetTrap;

const markOf = (fn: unknown): unknown => (fn as Record<symbol, unknown>)[MARK];

/** Captures the trap's stderr lines instead of printing them; restore it in a finally. */
const quietStderr = () => vi.spyOn(process.stderr, "write").mockImplementation(() => true);

// Every folder this file creates is removed afterwards.
const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

// The child's script. It stops with exit code 3 BEFORE loading any adapter when the trap is not on globalThis.fetch, so
// it cannot send a request without it. It then imports net-trap.mjs a second time (a different query makes Node evaluate
// the module again) and calls fetch and both real adapters, built WITHOUT an injected fetch.
const PROBE = `const MARK = Symbol.for("asksite.netTrap");
const [trapUrl, srcUrl] = process.argv.slice(2);
if (globalThis.fetch?.[MARK] !== true) {
  process.exitCode = 3;
} else {
  const trap = globalThis.fetch;
  await import(trapUrl + "?second-import");
  const { AnthropicProvider } = await import(new URL("providers/anthropic.ts", srcUrl).href);
  const { OpenAICompatibleProvider } = await import(new URL("providers/openai-compatible.ts", srcUrl).href);
  const { ProviderError } = await import(new URL("provider.ts", srcUrl).href);
  const { AI_DRAFT_JSON_SCHEMA } = await import(new URL("wire-schema.ts", srcUrl).href);
  const outcome = (promise) => promise.then(
    () => ({ resolved: true }),
    (error) => (error instanceof ProviderError ? { name: error.name, kind: error.kind } : { name: error.name, message: error.message }),
  );
  const request = { system: "s", user: "u", jsonSchema: AI_DRAFT_JSON_SCHEMA, maxOutputTokens: 16, signal: new AbortController().signal };
  const result = {
    sameTrapAfterSecondImport: globalThis.fetch === trap,
    invalidHost: await outcome(fetch("https://example.invalid/")),
    anthropic: await outcome(new AnthropicProvider({ apiKey: "sk-ant-MARKER-net-trap", model: "claude-haiku-4-5" }).generate(request)),
    compatible: await outcome(new OpenAICompatibleProvider({ baseUrl: "https://api.groq.com/openai/v1", apiKey: "gsk-MARKER-net-trap", model: "openai/gpt-oss-120b" }).generate(request)),
  };
  process.stdout.write(JSON.stringify(result) + "\\n");
}
`;

/** Runs PROBE in a new node with net-trap.mjs preloaded and every provider key variable removed from its environment. */
function runProbe(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), "asksite-net-trap-"));
  made.push(dir);
  const script = join(dir, "probe.mjs");
  writeFileSync(script, PROBE);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("ANTHROPIC_") && name !== "OPENAI_COMPAT_API_KEY"));
  const args = [script, pathToFileURL(TRAP_PATH).href, new URL("../src/", import.meta.url).href];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env: { ...env, NODE_OPTIONS: `--import=${TRAP_PATH}` }, stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("net-trap preload in a child node process", () => {
  it("blocks fetch and both adapters built without an injected fetch, logging the host only", async () => {
    const { code, stdout, stderr } = await runProbe();
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      sameTrapAfterSecondImport: true,
      invalidHost: { name: "TypeError", message: "net-trap: blocked request to example.invalid" },
      // The SDK wraps a failed fetch in APIConnectionError (client.mjs:575), which anthropic.ts's kindOf makes
      // "unavailable"; openai-compatible.ts turns a fetch that throws into "unavailable" too.
      anthropic: { name: "ProviderError", kind: "unavailable" },
      compatible: { name: "ProviderError", kind: "unavailable" },
    });
    expect(stderr.split("\n").filter((line) => line.startsWith("net-trap:"))).toEqual([
      "net-trap: blocked example.invalid",
      "net-trap: blocked api.anthropic.com",
      "net-trap: blocked api.groq.com",
    ]);
    expect(stderr).not.toContain("MARKER");
  });
});

describe("net-trap preload in this vitest worker", () => {
  it.runIf(process.env.NODE_OPTIONS?.includes("net-trap.mjs"))("is on globalThis.fetch before this file loads it, and a second import keeps it", async () => {
    expect(markedAtStart).toBe(true);
    await loadTrap();
    expect(globalThis.fetch).toBe(fetchAtStart);
  });
});

describe("isAllowed", () => {
  // What `new URL(url).hostname` returns decides: the URL Standard lowercases a special URL's domain ("LOCALHOST" is
  // "localhost", the host fetch connects to, so it is allowed) and keeps the brackets on an IPv6 address ("[::1]").
  it.each(["http://localhost:8787/x", "https://localhost/", "http://LOCALHOST/", "http://127.0.0.1:1/", "http://[::1]:8787/", "http://x.localhost/", "https://a.b.localhost/", "data:text/plain,hi", "blob:nodedata:0f"])(
    "allows %s",
    async (url) => {
      const { isAllowed } = await loadTrap();
      expect(isAllowed(url)).toBe(true);
    },
  );

  it.each([
    "https://api.anthropic.com/v1/messages",
    "https://api.groq.com/openai/v1/chat/completions",
    "https://example.invalid/",
    "http://localhost.evil.com/",
    "http://127.0.0.1.nip.io/",
    "http://evil.com/localhost",
    "http://user@localhost@evil.com/",
    "http://localhost:80@evil.com/",
    "http://evil.com#@localhost",
    "http://evil.com\\@localhost/",
    "http://evillocalhost/",
    "http://localhost./",
    "http://0.0.0.0/",
    "http://127.0.0.2/",
    "ws://localhost/",
    "file:///etc/hosts",
    "/relative",
    "",
  ])("blocks %s", async (url) => {
    const { isAllowed } = await loadTrap();
    expect(isAllowed(url)).toBe(false);
  });
});

describe("installNetTrap on a stand-in global", () => {
  const REMOTE = "https://api.anthropic.com/v1/messages?key=sk-MARKER";
  const BLOCKED = /^net-trap: blocked request to api\.anthropic\.com$/;

  // The stand-in's "real fetch" is a mock: nothing in this block can make a request.
  const standIn = () => {
    const realFetch = vi.fn<(input: unknown, init?: unknown) => Promise<Response>>(async () => new Response("local"));
    return { realFetch, target: { fetch: realFetch as unknown as typeof fetch } };
  };

  it("marks the trap for identity checks and keeps the real fetch only in its closure", async () => {
    const { installNetTrap } = await loadTrap();
    const { realFetch, target } = standIn();
    const trap = installNetTrap(target);
    expect(target.fetch).toBe(trap);
    expect(trap).not.toBe(realFetch);
    expect(markOf(trap)).toBe(true);
    expect(Reflect.ownKeys(trap).map((key) => Reflect.get(trap, key))).not.toContain(realFetch);
  });

  it.each([
    ["a string", () => REMOTE],
    ["a URL", () => new URL(REMOTE)],
    ["a Request", () => new Request(REMOTE, { method: "POST", body: "sk-MARKER" })],
  ])("blocks %s to a remote host before any I/O and writes one stderr line with the host only", async (_label, input) => {
    const { installNetTrap } = await loadTrap();
    const { realFetch, target } = standIn();
    installNetTrap(target);
    const stderr = quietStderr();
    try {
      const call = target.fetch(input(), { headers: { "x-api-key": "sk-MARKER" } });
      await expect(call).rejects.toBeInstanceOf(TypeError);
      await expect(call).rejects.toThrowError(BLOCKED);
      expect(stderr.mock.calls).toEqual([["net-trap: blocked api.anthropic.com\n"]]);
    } finally {
      stderr.mockRestore();
    }
    expect(realFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["a string for 127.0.0.1", () => "http://127.0.0.1:8787/v1"],
    ["a URL for localhost", () => new URL("http://localhost/x")],
    ["a data: URL", () => "data:text/plain,hi"],
    ["a Request for [::1]", () => new Request("http://[::1]:8787/", { method: "POST", body: "{}" })],
  ])("passes %s on to the real fetch", async (_label, make) => {
    const { installNetTrap } = await loadTrap();
    const { realFetch, target } = standIn();
    installNetTrap(target);
    const input = make();
    const init = { method: "POST" };
    const stderr = quietStderr();
    try {
      expect(await (await target.fetch(input, init)).text()).toBe("local");
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
    expect(realFetch).toHaveBeenCalledTimes(1);
    // A Request goes on as it is; any other input goes on as the exact text that was checked.
    expect(realFetch.mock.calls[0]?.[0]).toBe(input instanceof Request ? input : String(input));
    expect(realFetch.mock.calls[0]?.[1]).toBe(init);
  });

  it("reads a Request's own URL, so a shadowing url property cannot disguise a remote host", async () => {
    const { installNetTrap } = await loadTrap();
    const { realFetch, target } = standIn();
    installNetTrap(target);
    const disguised = new Request(REMOTE);
    Object.defineProperty(disguised, "url", { value: "http://localhost/" });
    const stderr = quietStderr();
    try {
      await expect(target.fetch(disguised)).rejects.toThrowError(BLOCKED);
    } finally {
      stderr.mockRestore();
    }
    expect(realFetch).not.toHaveBeenCalled();
  });

  it("passes on the text it checked, so an input cannot change between the check and the call", async () => {
    const { installNetTrap } = await loadTrap();
    const { realFetch, target } = standIn();
    installNetTrap(target);
    let reads = 0;
    const shifting = { toString: () => (reads++ === 0 ? "http://localhost/" : REMOTE) };
    await target.fetch(shifting as unknown as string);
    expect(realFetch.mock.calls[0]?.[0]).toBe("http://localhost/");
  });

  it("blocks an input it cannot read as a URL", async () => {
    const { installNetTrap } = await loadTrap();
    const { realFetch, target } = standIn();
    installNetTrap(target);
    const unreadable = {
      toString: () => {
        throw new Error("unreadable");
      },
    };
    const stderr = quietStderr();
    try {
      await expect(target.fetch(unreadable as unknown as string)).rejects.toThrowError(/^net-trap: blocked request to \(no host\)$/);
      await expect(target.fetch("/relative")).rejects.toThrowError(/^net-trap: blocked request to \(no host\)$/);
      expect(stderr.mock.calls).toEqual([["net-trap: blocked (no host)\n"], ["net-trap: blocked (no host)\n"]]);
    } finally {
      stderr.mockRestore();
    }
    expect(realFetch).not.toHaveBeenCalled();
  });

  it("rejects the returned promise instead of throwing, as fetch does", async () => {
    const { installNetTrap } = await loadTrap();
    const { target } = standIn();
    installNetTrap(target);
    const stderr = quietStderr();
    try {
      const call = target.fetch(REMOTE);
      expect(call).toBeInstanceOf(Promise);
      await expect(call).rejects.toThrowError(BLOCKED);
    } finally {
      stderr.mockRestore();
    }
  });

  it("installing twice keeps the first trap (no trap in a trap)", async () => {
    const { installNetTrap } = await loadTrap();
    const { realFetch, target } = standIn();
    const first = installNetTrap(target);
    expect(installNetTrap(target)).toBe(first);
    expect(target.fetch).toBe(first);
    await target.fetch("http://localhost/");
    expect(realFetch).toHaveBeenCalledTimes(1);
  });
});

describe("net-trap.mjs on import", () => {
  it("installs itself on the real globalThis.fetch", async () => {
    await loadTrap();
    expect(markOf(globalThis.fetch)).toBe(true);
    const stderr = quietStderr();
    try {
      await expect(fetch("https://example.invalid/")).rejects.toThrowError(/^net-trap: blocked request to example\.invalid$/);
      expect(stderr.mock.calls).toEqual([["net-trap: blocked example.invalid\n"]]);
    } finally {
      stderr.mockRestore();
    }
  });
});
