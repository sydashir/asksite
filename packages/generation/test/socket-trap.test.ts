import { spawn } from "node:child_process";
import dns from "node:dns";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

// The socket-level network guard, test/support/socket-trap.mjs, the second layer under net-trap.mjs. Checked three
// ways: (a) in a child node started with BOTH layers preloaded, through paths that never touch globalThis.fetch;
// (b) on a stand-in socket prototype and dns module whose "real" functions are mocks; (c) on the real modules of this
// worker. Nothing here can reach a network: the child checks both layers' markers before it opens anything, the
// stand-ins make no I/O, and every real call outside loopback goes to a .invalid name (RFC 6761 section 6.4: it never
// resolves) after the trap's markers have been checked.

const MARK = Symbol.for("asksite.socketTrap");
const SOCKET_TRAP_PATH = fileURLToPath(new URL("./support/socket-trap.mjs", import.meta.url));
const NET_TRAP_PATH = fileURLToPath(new URL("./support/net-trap.mjs", import.meta.url));

type Callback = (error: Error | null, ...answer: unknown[]) => void;
interface Targets {
  socketPrototype?: object;
  dnsModule?: object;
}
interface SocketTrap {
  isLoopbackAddress(address: unknown): boolean;
  installSocketTrap(targets?: Targets): void;
}
// A variable specifier, so TypeScript does not look for a declaration file for the plain .mjs module. Importing it
// patches this worker's node:net and node:dns, which no test in this file depends on either way; other test files do
// not see it, as vitest runs each test file in its own worker by default (isolate: true).
const loadTrap = async (): Promise<SocketTrap> => (await import(SOCKET_TRAP_PATH)) as SocketTrap;

// net's own argument normalizer (net.js normalizeArgs, exported as _normalizeArgs): it marks the array it returns.
const normalizeArgs = (net as unknown as { _normalizeArgs(args: unknown[]): unknown[] })._normalizeArgs;

const markOf = (fn: unknown): unknown => (fn as Record<symbol, unknown>)[MARK];
const nextTick = (): Promise<void> => new Promise((resolve) => process.nextTick(resolve));

/** Captures the trap's stderr lines instead of printing them; restore it in a finally. */
const quietStderr = () => vi.spyOn(process.stderr, "write").mockImplementation(() => true);

// Every folder this file creates is removed afterwards.
const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

interface StandInSocket {
  connect(...args: unknown[]): unknown;
}
const LOOPBACK_ANSWERS = [
  { address: "::1", family: 6 },
  { address: "127.0.0.1", family: 4 },
];
const PROMISIFY_ARGS = Symbol("customPromisifyArgs");

/** A stand-in for net.Socket.prototype and node:dns. Every "real" function is a mock: nothing here opens a socket. */
function standIn() {
  const connect = vi.fn(function (this: unknown, ..._args: unknown[]) {
    return this;
  });
  const destroy = vi.fn();
  const socketPrototype = { connect, destroy };
  // Takes (name, callback) or (name, options, callback), as dns.lookup does.
  const lookup = vi.fn((_name: unknown, options: unknown, callback?: Callback) => {
    const done = (typeof options === "function" ? options : callback) as Callback;
    if ((options as { all?: boolean } | undefined)?.all === true) done(null, LOOPBACK_ANSWERS);
    else done(null, "127.0.0.1", 4);
  });
  Object.defineProperty(lookup, PROMISIFY_ARGS, { value: ["address", "family"] });
  const promisesLookup = vi.fn(async (_name: unknown, options?: unknown) => ((options as { all?: boolean } | undefined)?.all === true ? LOOPBACK_ANSWERS : { address: "127.0.0.1", family: 4 }));
  const answerNothing = async (..._args: unknown[]): Promise<string[][]> => [];
  const queries = { resolve4: vi.fn(), reverse: vi.fn(), lookupService: vi.fn(), resolverResolve6: vi.fn(), resolveTxt: vi.fn(answerNothing), resolverResolveTxt: vi.fn(answerNothing) };
  class Resolver {
    resolve6(...args: unknown[]): unknown {
      return queries.resolverResolve6(...args);
    }
  }
  class PromisesResolver {
    resolveTxt(...args: unknown[]): unknown {
      return queries.resolverResolveTxt(...args);
    }
  }
  const dnsModule = {
    lookup,
    lookupService: queries.lookupService,
    resolve4: queries.resolve4,
    reverse: queries.reverse,
    Resolver,
    promises: { lookup: promisesLookup, resolveTxt: queries.resolveTxt, Resolver: PromisesResolver },
  };
  const socket = Object.create(socketPrototype) as StandInSocket;
  return { connect, destroy, socketPrototype, socket, lookup, promisesLookup, queries, dnsModule };
}

/** Installs the trap on a fresh stand-in and returns it. */
async function trapped() {
  const { installSocketTrap } = await loadTrap();
  const stand = standIn();
  installSocketTrap({ socketPrototype: stand.socketPrototype, dnsModule: stand.dnsModule });
  return stand;
}

/** The [options, callback] array the stand-in's real connect received on its first call. */
const passedOn = (connect: { mock: { calls: unknown[][] } }): [Record<string, unknown>, unknown] => connect.mock.calls[0]?.[0] as [Record<string, unknown>, unknown];

/** Calls a callback-style function and resolves with what it called back with. */
const calledBack = (start: (done: Callback) => void): Promise<unknown[]> => new Promise((resolve) => start((...answer) => resolve(answer)));

describe("isLoopbackAddress", () => {
  it.each(["127.0.0.1", "127.0.0.0", "127.255.255.254", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1"])("allows %s", async (address) => {
    const { isLoopbackAddress } = await loadTrap();
    expect(isLoopbackAddress(address)).toBe(true);
  });

  // Names are not addresses: "localhost" is checked by its answers, and "127.1" or "[::1]" are names to net (isIP
  // gives 0), which it would send to the resolver.
  it.each([
    "128.0.0.1",
    "126.255.255.255",
    "0.0.0.0",
    "10.0.0.1",
    "192.0.2.1",
    "::",
    "::2",
    "fe80::1",
    "::ffff:10.0.0.1",
    "localhost",
    "127.1",
    "2130706433",
    "[::1]",
    "",
  ])("blocks %s", async (address) => {
    const { isLoopbackAddress } = await loadTrap();
    expect(isLoopbackAddress(address)).toBe(false);
  });

  it("blocks anything that is not a string without reading it", async () => {
    const { isLoopbackAddress } = await loadTrap();
    const disguised = {
      toString: () => {
        throw new Error("read");
      },
    };
    for (const value of [undefined, null, 2130706433, disguised]) expect(isLoopbackAddress(value)).toBe(false);
  });
});

describe("installSocketTrap on a stand-in socket and dns", () => {
  it("marks every patched function, keeps each real one only in its closure, and patches nothing twice", async () => {
    const { installSocketTrap } = await loadTrap();
    const stand = standIn();
    const { dnsModule, socketPrototype } = stand;
    const holders = [
      [socketPrototype, "connect"],
      [dnsModule, "lookup"],
      [dnsModule, "lookupService"],
      [dnsModule, "resolve4"],
      [dnsModule, "reverse"],
      [dnsModule.Resolver.prototype, "resolve6"],
      [dnsModule.promises, "lookup"],
      [dnsModule.promises, "resolveTxt"],
      [dnsModule.promises.Resolver.prototype, "resolveTxt"],
    ] as const;
    const read = (holder: object, key: string): unknown => (holder as Record<string, unknown>)[key];
    const originals = holders.map(([holder, key]) => read(holder, key));
    installSocketTrap({ socketPrototype, dnsModule });
    const patched = holders.map(([holder, key]) => read(holder, key));
    patched.forEach((fn, i) => {
      expect(fn).not.toBe(originals[i]);
      expect(markOf(fn)).toBe(true);
      expect(Reflect.ownKeys(fn as object).map((key) => Reflect.get(fn as object, key))).not.toContain(originals[i]);
    });
    installSocketTrap({ socketPrototype, dnsModule });
    expect(holders.map(([holder, key]) => read(holder, key))).toEqual(patched);
  });

  it.each([
    ["127.0.0.1 given as port and host", [80, "127.0.0.1"], { port: 80, host: "127.0.0.1" }],
    ["127.255.255.254 in options", [{ port: 80, host: "127.255.255.254" }], { port: 80, host: "127.255.255.254" }],
    ["::1 in options", [{ port: 80, host: "::1" }], { port: 80, host: "::1" }],
    ["an IPC path", ["/tmp/asksite-socket-trap.sock"], { path: "/tmp/asksite-socket-trap.sock" }],
    ["an IPC path beside a remote host, which net ignores", [{ path: "/tmp/asksite-socket-trap.sock", host: "example.invalid" }], { path: "/tmp/asksite-socket-trap.sock" }],
  ])("passes %s on to the real connect", async (_label, args, expected) => {
    const { connect, destroy, socket } = await trapped();
    const stderr = quietStderr();
    try {
      expect(socket.connect(...args)).toBe(socket);
      await nextTick();
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect.mock.contexts[0]).toBe(socket);
    expect(passedOn(connect)[0]).toMatchObject(expected);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("passes net's own normalized arguments on as the same array", async () => {
    const { connect, socket } = await trapped();
    const listener = () => {};
    const normalized = normalizeArgs([{ port: 80, host: "127.0.0.1" }, listener]);
    socket.connect(normalized);
    expect(connect.mock.calls[0]?.[0]).toBe(normalized);
  });

  it.each(["example.invalid", "api.anthropic.com", "[::1]", "127.1", "LOCALHOST", "localhost.", "0.0.0.0", "::", "192.0.2.1", "::ffff:10.0.0.1"])(
    "blocks %s before any lookup, reporting it on the next tick as net reports a failed lookup",
    async (host) => {
      const { connect, destroy, socket, lookup } = await trapped();
      const stderr = quietStderr();
      try {
        expect(socket.connect(443, host)).toBe(socket);
        // Left connecting, as net leaves a socket whose lookup fails, so a write waits instead of failing first.
        expect((socket as unknown as { connecting?: unknown }).connecting).toBe(true);
        expect(destroy).not.toHaveBeenCalled();
        await nextTick();
        expect(stderr.mock.calls).toEqual([[`socket-trap: blocked ${host}\n`]]);
      } finally {
        stderr.mockRestore();
      }
      expect(connect).not.toHaveBeenCalled();
      expect(lookup).not.toHaveBeenCalled();
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(destroy.mock.contexts[0]).toBe(socket);
      const error = destroy.mock.calls[0]?.[0] as Error;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe(`socket-trap: blocked connection to ${host}`);
    },
  );

  it("reads an array net did not normalize as net does: as the options object itself", async () => {
    const { connect, destroy, socket } = await trapped();
    const unmarked = Object.assign([{ port: 80, host: "127.0.0.1" }], { port: 80, host: "example.invalid" });
    const stderr = quietStderr();
    try {
      socket.connect(unmarked);
      await nextTick();
    } finally {
      stderr.mockRestore();
    }
    expect(connect).not.toHaveBeenCalled();
    expect((destroy.mock.calls[0]?.[0] as Error).message).toBe("socket-trap: blocked connection to example.invalid");
  });

  it("blocks a host that is not a string without reading it, and logs only one line per host", async () => {
    const { connect, destroy, socket } = await trapped();
    const disguised = {
      toString: () => {
        throw new Error("read");
      },
    };
    const stderr = quietStderr();
    try {
      socket.connect({ port: 80, host: disguised });
      socket.connect({ port: 80, host: "evil\ncom.invalid" });
      await nextTick();
      expect(stderr.mock.calls).toEqual([["socket-trap: blocked (no host)\n"], ["socket-trap: blocked evil?com.invalid\n"]]);
    } finally {
      stderr.mockRestore();
    }
    expect(connect).not.toHaveBeenCalled();
    expect(destroy.mock.calls.map(([error]) => (error as Error).message)).toEqual(["socket-trap: blocked connection to (no host)", "socket-trap: blocked connection to evil?com.invalid"]);
  });

  it("lets localhost through with a lookup that passes on only loopback answers, leaving the caller's options alone", async () => {
    const { connect, socket, lookup } = await trapped();
    const listener = () => {};
    const options = { port: 80, host: "localhost" };
    socket.connect(options, listener);
    const [passed, passedListener] = passedOn(connect);
    expect(passedListener).toBe(listener);
    expect(passed).toMatchObject({ port: 80, host: "localhost" });
    expect(options).toEqual({ port: 80, host: "localhost" });
    const check = passed.lookup as (name: string, options: object, done: Callback) => void;
    expect(await calledBack((done) => check("localhost", { all: true }, done))).toEqual([null, LOOPBACK_ANSWERS]);
    expect(await calledBack((done) => check("localhost", {}, done))).toEqual([null, "127.0.0.1", 4]);
    // No lookup of its own: net would use dns.lookup, read when it looks up.
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("defaults a missing host to localhost, as net does, and checks its lookup", async () => {
    const { connect, socket } = await trapped();
    socket.connect({ port: 80 });
    const [passed] = passedOn(connect);
    expect(passed.host).toBeUndefined();
    expect(typeof passed.lookup).toBe("function");
  });

  it.each([
    ["one address that is not loopback", [null, "192.0.2.1", 4]],
    ["a list holding one address that is not loopback", [null, [{ address: "127.0.0.1", family: 4 }, { address: "192.0.2.1", family: 4 }]]],
    ["a list holding something that is not an address", [null, [{ address: "127.0.0.1", family: 4 }, null]]],
  ])("refuses localhost when the caller's own lookup answers with %s", async (_label, answer) => {
    const { connect, socket } = await trapped();
    const own = vi.fn((_name: string, _options: object, done: Callback) => done(...(answer as [null, ...unknown[]])));
    const options = { port: 80, host: "localhost", lookup: own };
    socket.connect(options);
    const [passed] = passedOn(connect);
    expect(options.lookup).toBe(own);
    const stderr = quietStderr();
    let result: unknown[];
    try {
      result = await calledBack((done) => (passed.lookup as typeof own)("localhost", { all: true }, done));
      expect(stderr.mock.calls).toEqual([["socket-trap: blocked localhost\n"]]);
    } finally {
      stderr.mockRestore();
    }
    expect(own).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect((result[0] as Error).message).toBe("socket-trap: blocked connection to localhost");
  });

  it("passes a failed lookup's own error on unchanged", async () => {
    const { connect, socket } = await trapped();
    const failure = new Error("lookup failed");
    socket.connect({ port: 80, host: "localhost", lookup: (_name: string, _options: object, done: Callback) => done(failure) });
    const [passed] = passedOn(connect);
    expect(await calledBack((done) => (passed.lookup as (n: string, o: object, d: Callback) => void)("localhost", {}, done))).toEqual([failure]);
  });
});

describe("the stand-in dns.lookup and dns.promises.lookup", () => {
  it("lets localhost through and passes on its loopback answers", async () => {
    const { dnsModule, lookup } = await trapped();
    const trappedLookup = dnsModule.lookup as unknown as (name: string, ...rest: unknown[]) => unknown;
    expect(await calledBack((done) => trappedLookup("localhost", done))).toEqual([null, "127.0.0.1", 4]);
    expect(await calledBack((done) => trappedLookup("localhost", { all: true }, done))).toEqual([null, LOOPBACK_ANSWERS]);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(await dnsModule.promises.lookup("localhost")).toEqual({ address: "127.0.0.1", family: 4 });
    expect(await dnsModule.promises.lookup("localhost", { all: true })).toEqual(LOOPBACK_ANSWERS);
  });

  it("refuses localhost when the resolver answers with an address that is not loopback", async () => {
    const { dnsModule, lookup, promisesLookup } = await trapped();
    lookup.mockImplementation((_name, _options, done) => done?.(null, "192.0.2.1", 4));
    promisesLookup.mockImplementation(async () => [{ address: "127.0.0.1", family: 4 }, { address: "192.0.2.1", family: 4 }]);
    const stderr = quietStderr();
    try {
      const [error] = await calledBack((done) => (dnsModule.lookup as unknown as (name: string, done: Callback) => void)("localhost", done));
      expect((error as Error).message).toBe("socket-trap: blocked lookup of localhost");
      await expect(dnsModule.promises.lookup("localhost", { all: true })).rejects.toThrowError(/^socket-trap: blocked lookup of localhost$/);
      expect(stderr.mock.calls).toEqual([["socket-trap: blocked localhost\n"], ["socket-trap: blocked localhost\n"]]);
    } finally {
      stderr.mockRestore();
    }
  });

  it("passes a loopback address literal on unchanged (dns.lookup answers it without the resolver)", async () => {
    const { dnsModule, lookup, promisesLookup } = await trapped();
    const done = () => {};
    (dnsModule.lookup as unknown as (name: string, done: Callback) => void)("::1", done);
    expect(lookup.mock.calls[0]).toEqual(["::1", done]);
    await dnsModule.promises.lookup("127.0.0.1", { family: 4 });
    expect(promisesLookup.mock.calls[0]).toEqual(["127.0.0.1", { family: 4 }]);
  });

  it.each([
    ["example.invalid", "example.invalid"],
    ["api.anthropic.com", "api.anthropic.com"],
    ["LOCALHOST", "LOCALHOST"],
    ["localhost.", "localhost."],
    ["192.0.2.1", "192.0.2.1"],
    ["", "(no host)"],
  ])("refuses %j before the resolver, calling back on the next tick", async (name, label) => {
    const { dnsModule, lookup, promisesLookup } = await trapped();
    const done = vi.fn();
    const stderr = quietStderr();
    try {
      expect((dnsModule.lookup as unknown as (name: string, done: Callback) => unknown)(name, done)).toEqual({});
      expect(done).not.toHaveBeenCalled();
      await nextTick();
      await expect(dnsModule.promises.lookup(name)).rejects.toThrowError(`socket-trap: blocked lookup of ${label}`);
      expect(stderr.mock.calls).toEqual([[`socket-trap: blocked ${label}\n`], [`socket-trap: blocked ${label}\n`]]);
    } finally {
      stderr.mockRestore();
    }
    expect(done).toHaveBeenCalledTimes(1);
    expect((done.mock.calls[0]?.[0] as Error).message).toBe(`socket-trap: blocked lookup of ${label}`);
    expect(lookup).not.toHaveBeenCalled();
    expect(promisesLookup).not.toHaveBeenCalled();
  });

  it("throws when a refused lookup has no callback to report to", async () => {
    const { dnsModule, lookup } = await trapped();
    const stderr = quietStderr();
    try {
      expect(() => (dnsModule.lookup as unknown as (name: string) => unknown)("example.invalid")).toThrowError(/^socket-trap: blocked lookup of example\.invalid$/);
    } finally {
      stderr.mockRestore();
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it("keeps the real function's symbol properties, which util.promisify reads", async () => {
    const { dnsModule } = await trapped();
    expect((dnsModule.lookup as unknown as Record<symbol, unknown>)[PROMISIFY_ARGS]).toEqual(["address", "family"]);
  });
});

describe("the stand-in dns query functions", () => {
  // resolve*, reverse and lookupService always ask a DNS server on the network (dns.md, Implementation
  // considerations), so every name is refused, localhost included.
  it("refuses every callback query on the next tick without calling the real function", async () => {
    const { dnsModule, queries } = await trapped();
    const calls: [string, (done: Callback) => unknown][] = [
      ["localhost", (done) => dnsModule.resolve4("localhost", done)],
      ["127.0.0.1", (done) => dnsModule.reverse("127.0.0.1", done)],
      ["127.0.0.1", (done) => dnsModule.lookupService("127.0.0.1", 80, done)],
      ["resolver.example.invalid", (done) => new dnsModule.Resolver().resolve6("resolver.example.invalid", { ttl: true }, done)],
    ];
    const stderr = quietStderr();
    try {
      for (const [label, start] of calls) {
        const [error] = await calledBack(start);
        expect((error as Error).message).toBe(`socket-trap: blocked lookup of ${label}`);
      }
      expect(stderr.mock.calls).toEqual(calls.map(([label]) => [`socket-trap: blocked ${label}\n`]));
    } finally {
      stderr.mockRestore();
    }
    for (const query of Object.values(queries)) expect(query).not.toHaveBeenCalled();
  });

  it("rejects every promise query without calling the real function", async () => {
    const { dnsModule, queries } = await trapped();
    const stderr = quietStderr();
    try {
      await expect(dnsModule.promises.resolveTxt("localhost")).rejects.toThrowError(/^socket-trap: blocked lookup of localhost$/);
      await expect(new dnsModule.promises.Resolver().resolveTxt("resolver.example.invalid")).rejects.toThrowError(/^socket-trap: blocked lookup of resolver\.example\.invalid$/);
    } finally {
      stderr.mockRestore();
    }
    for (const query of Object.values(queries)) expect(query).not.toHaveBeenCalled();
  });

  it("throws when a refused callback query has no callback", async () => {
    const { dnsModule } = await trapped();
    const stderr = quietStderr();
    try {
      expect(() => (dnsModule.resolve4 as (name: string) => unknown)("example.invalid")).toThrowError(/^socket-trap: blocked lookup of example\.invalid$/);
    } finally {
      stderr.mockRestore();
    }
  });
});

describe("socket-trap.mjs on import", () => {
  it("installs itself on the real net.Socket.prototype.connect and node:dns, which then refuse a .invalid name", async () => {
    await loadTrap();
    for (const fn of [net.Socket.prototype.connect, dns.lookup, dns.promises.lookup, dns.resolve4, dns.promises.resolveTxt, dns.Resolver.prototype.resolve4]) expect(markOf(fn)).toBe(true);
    const stderr = quietStderr();
    try {
      const socket = net.connect(443, "import-connect.example.invalid");
      const message = await new Promise((resolve) => socket.once("error", (error) => resolve(error.message)));
      expect(message).toBe("socket-trap: blocked connection to import-connect.example.invalid");
      await expect(dns.promises.lookup("import-lookup.example.invalid")).rejects.toThrowError(/^socket-trap: blocked lookup of import-lookup\.example\.invalid$/);
      expect(stderr.mock.calls).toEqual([["socket-trap: blocked import-connect.example.invalid\n"], ["socket-trap: blocked import-lookup.example.invalid\n"]]);
    } finally {
      stderr.mockRestore();
    }
  });
});

// The child's script. It stops with exit code 3 (fetch layer) or 4 (socket layer) BEFORE it opens any socket or asks
// any resolver when a layer's marker is missing. Then it takes every path that goes around globalThis.fetch, each to
// its own .invalid name, plus a redirect from a local server that the real fetch follows, and checks that loopback,
// localhost and an IPC path still work.
const PROBE = `import dns from "node:dns";
import { lookup as esmLookup } from "node:dns";
import { lookup as esmPromisesLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { join } from "node:path";
const FETCH_MARK = Symbol.for("asksite.netTrap");
const SOCKET_MARK = Symbol.for("asksite.socketTrap");
if (globalThis.fetch?.[FETCH_MARK] !== true) {
  process.exitCode = 3;
} else if ([net.Socket.prototype.connect, dns.lookup, dns.promises.lookup].some((fn) => fn?.[SOCKET_MARK] !== true)) {
  process.exitCode = 4;
} else {
  const messageOf = (error) => (error instanceof Error ? error.message : String(error));
  const outcome = (emitter, success) => new Promise((resolve) => {
    emitter.once("error", (error) => resolve(messageOf(error)));
    emitter.once(success, () => resolve("connected"));
  });
  const calledBack = (start) => new Promise((resolve) => start((error) => resolve(error ? messageOf(error) : "resolved")));
  const settled = (promise) => promise.then(() => "resolved", messageOf);
  const text = (url) => new Promise((resolve, reject) => {
    http.get(url, (res) => { let body = ""; res.setEncoding("utf8").on("data", (chunk) => (body += chunk)).on("end", () => resolve(body)); }).on("error", reject);
  });
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === "/redirect") res.writeHead(302, { location: "https://redirect.example.invalid/" }).end();
    else res.end("local");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const ipcPath = join(process.argv[2], "ipc.sock");
  const ipc = net.createServer((socket) => socket.end("ipc"));
  await new Promise((resolve) => ipc.listen(ipcPath, resolve));
  const result = {
    httpsGet: await outcome(https.get("https://https-get.example.invalid/"), "response"),
    netConnect: await outcome(net.connect(443, "net-connect.example.invalid"), "connect"),
    dnsLookup: await calledBack((done) => dns.lookup("dns-lookup.example.invalid", done)),
    esmLookup: await calledBack((done) => esmLookup("esm-lookup.example.invalid", done)),
    promisesLookup: await settled(dns.promises.lookup("promises-lookup.example.invalid")),
    esmPromisesLookup: await settled(esmPromisesLookup("esm-promises-lookup.example.invalid")),
    resolve4: await calledBack((done) => dns.resolve4("resolve4.example.invalid", done)),
    resolverTxt: await settled(new dns.promises.Resolver().resolveTxt("resolver.example.invalid")),
    webSocket: await new Promise((resolve) => {
      const socket = new WebSocket("wss://websocket.example.invalid/");
      socket.addEventListener("error", () => resolve("error"));
      socket.addEventListener("open", () => resolve("connected"));
    }),
    redirect: await fetch("http://127.0.0.1:" + port + "/redirect").then(
      () => "resolved",
      (error) => ({ name: error.name, message: error.message, cause: messageOf(error.cause) }),
    ),
    loopbackFetch: await fetch("http://127.0.0.1:" + port + "/ok").then((res) => res.text()),
    localhostGet: await text("http://localhost:" + port + "/ok"),
    ipc: await new Promise((resolve, reject) => {
      let body = "";
      net.connect(ipcPath).setEncoding("utf8").on("data", (chunk) => (body += chunk)).on("end", () => resolve(body)).on("error", reject);
    }),
    hits,
  };
  server.closeAllConnections();
  server.close();
  ipc.close();
  process.stdout.write(JSON.stringify(result) + "\\n");
}
`;

/** Runs PROBE in a new node with both layers preloaded and every provider key variable removed from its environment. */
function runProbe(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), "asksite-socket-trap-"));
  made.push(dir);
  const script = join(dir, "probe.mjs");
  writeFileSync(script, PROBE);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("ANTHROPIC_") && name !== "OPENAI_COMPAT_API_KEY"));
  const preload = `--import=${pathToFileURL(NET_TRAP_PATH).href} --import=${pathToFileURL(SOCKET_TRAP_PATH).href}`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, dir], { env: { ...env, NODE_OPTIONS: preload }, stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("socket-trap with net-trap, both preloaded in a child node process", () => {
  it("stops every path around globalThis.fetch at the socket, and leaves loopback, localhost and IPC working", async () => {
    const { code, stdout, stderr } = await runProbe();
    expect(code, stderr).toBe(0);
    const blocked = (name: string) => `socket-trap: blocked connection to ${name}.example.invalid`;
    const refused = (name: string) => `socket-trap: blocked lookup of ${name}.example.invalid`;
    expect(JSON.parse(stdout)).toEqual({
      httpsGet: blocked("https-get"),
      netConnect: blocked("net-connect"),
      dnsLookup: refused("dns-lookup"),
      esmLookup: refused("esm-lookup"),
      promisesLookup: refused("promises-lookup"),
      esmPromisesLookup: refused("esm-promises-lookup"),
      resolve4: refused("resolve4"),
      resolverTxt: refused("resolver"),
      webSocket: "error",
      // The fetch layer lets 127.0.0.1 through, and the real fetch follows the 302 on its own: the socket layer stops
      // that second leg. undici reports a connection error as TypeError "fetch failed" with the error as its cause.
      redirect: { name: "TypeError", message: "fetch failed", cause: blocked("redirect") },
      loopbackFetch: "local",
      localhostGet: "local",
      ipc: "ipc",
      hits: ["/redirect", "/ok", "/ok"],
    });
    expect(stderr.split("\n").filter((line) => line.startsWith("socket-trap:") || line.startsWith("net-trap:"))).toEqual(
      ["https-get", "net-connect", "dns-lookup", "esm-lookup", "promises-lookup", "esm-promises-lookup", "resolve4", "resolver", "websocket", "redirect"].map(
        (name) => `socket-trap: blocked ${name}.example.invalid`,
      ),
    );
  });
});
