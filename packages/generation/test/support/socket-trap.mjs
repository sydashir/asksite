// Socket-level network guard: the second, independent layer under net-trap.mjs (NET-TRAP fix r1, 2026-09-27). Load
// both, before any other module, through NODE_OPTIONS with the provider variables removed (global-constraints.md L2):
//
//   env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_CUSTOM_HEADERS -u ANTHROPIC_BASE_URL -u ANTHROPIC_LOG -u OPENAI_COMPAT_API_KEY CLOUDFLARE_CF_FETCH_ENABLED=false WRANGLER_SEND_METRICS=false ASKSITE_NET_TRAP=required NODE_OPTIONS="--import=/Users/ashir/Documents/workk2/asksite-plan3/packages/generation/test/support/net-trap.mjs --import=/Users/ashir/Documents/workk2/asksite-plan3/packages/generation/test/support/socket-trap.mjs" pnpm ...
//
// On import it patches this thread's node:net and node:dns. Line numbers below are Node 25.6.1's own lib sources, read
// from the running binary:
// - net.Socket.prototype.connect, where every TCP and TLS client connection starts: net.connect/createConnection call
//   it (net.js:236-246), and tls.connect calls it on a TLSSocket, whose prototype is net.Socket.prototype
//   (internal/tls/wrap.js:623, 1779). A connection goes on only to an IPC path (net takes the pipe branch whenever
//   options.path is truthy, net.js:1332-1352), to a loopback address literal (127.0.0.0/8 or ::1, checked with
//   net.BlockList, which also matches the IPv4-mapped IPv6 form; net skips the lookup for a literal, net.js:1419), or
//   to the name localhost (net's default host, net.js:1379) through a lookup that passes on only loopback answers (net
//   calls `options.lookup || dns.lookup` with (host, options, callback), and the callback gets (err, address, family),
//   or (err, addresses) with all: true: net.js:1451-1476, dns.md). Anything else is refused before any lookup or I/O,
//   "LOCALHOST", "localhost." and "[::1]" included (net sends those to the resolver as names: isIP gives 0). A refusal
//   is one stderr line `socket-trap: blocked <host>` (never the port, the path or any data), then, as net does when
//   a lookup fails, the socket is left connecting (net.js:1344) and destroyed on the next tick with
//   Error("socket-trap: blocked connection to <host>") (net.js:1488, 1624-1626), so http, https, tls and undici see an
//   ordinary connection error.
// - dns.lookup and dns.promises.lookup (node:dns/promises is the same object): only localhost, whose answers must be
//   loopback, and loopback literals, which dns.lookup answers without the resolver (dns.js:205-213). Any other name gets
//   `socket-trap: blocked lookup of <name>` and never reaches getaddrinfo.
// - dns.resolve*, dns.reverse, dns.lookupService and the Resolver methods, callback and promise forms: refused for
//   every name, localhost included. resolve* and reverse "always perform a DNS query on the network" (dns.md,
//   Implementation considerations), and lookupService asks getnameinfo. No package in node_modules/.pnpm that Plan 3
//   runs calls them (grep: only lookup is used, by undici's dns interceptor, proxy agents and vite).
// Then module.syncBuiltinESMExports(), so `import { lookup } from "node:dns"` sees the patched functions (module.md).
// Every patched function carries Symbol.for("asksite.socketTrap") and the real function's own symbol properties
// (util.promisify reads dns.lookup's); the real function lives only in the closure. Importing this module again, or
// calling installSocketTrap again, patches nothing twice.
//
// Covered, because the connection itself is checked: undici's own fetch (Miniflare's cf.json request, miniflare
// dist/src/index.js:68040, 68160; wrangler's metrics, wrangler-dist/cli.js:157359; both reach net.connect/tls.connect
// in undici 7.29.0 lib/core/connect.js:86, 108); node:http and node:https (the http Agent calls net.createConnection,
// _http_agent.js:240, the https Agent tls.connect, https.js:367; wrangler's npm update check uses https.get,
// cli.js:58291); http2 (internal/http2/core.js:3568-3571); Node's global fetch and WebSocket (its bundled undici
// 7.21.0 connects through tls.connect/net.connect, internal/deps/undici/undici.js:3162, 3181); an init.dispatcher or a
// global undici dispatcher; a redirect the real fetch follows from an allowed local server; a fetch saved before
// net-trap.mjs loaded.
// NOT covered:
// - other programs: workerd is a separate binary (wrangler's test harness sends a Worker's fetch back to Node's
//   globalThis.fetch, cli.js:368848-368850, where both layers see it), and so are curl and any non-Node child process;
// - worker threads started with eval: true or with an env that lacks NODE_OPTIONS: they do not run --import preloads
//   (seen by marker on Node 25.6.1), so their node:net and node:dns are the real ones;
// - modules preloaded with --require, which run before --import (cli.md:1608), and any code that saved the real
//   connect or lookup before this module ran;
// - UDP (node:dgram) sent to an address literal (a name goes through the patched dns.lookup, internal/dgram.js:37);
// - native addons, and wherever the process behind an allowed IPC path forwards.

import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

const MARK = Symbol.for("asksite.socketTrap");
const LOCAL_NAME = "localhost";
const LOOPBACK = new net.BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");
// net's own argument normalizer (net.js:282-314, exported as _normalizeArgs; tls.connect uses it too,
// internal/tls/wrap.js:1616) and the unregistered symbol it marks its result with. Socket.prototype.connect takes an
// array as already normalized only when it carries that exact symbol (net.js:1295), so the trap reads it the same way.
const normalizeArgs = net._normalizeArgs;
const NORMALIZED = typeof normalizeArgs === "function" ? Object.getOwnPropertySymbols(normalizeArgs([]))[0] : undefined;
if (NORMALIZED === undefined) throw new Error("socket-trap: net._normalizeArgs is missing, so connect arguments cannot be read as net reads them");
// The dns functions that ask a DNS server (or getnameinfo) themselves.
const QUERY = /^(resolve|reverse$|lookupService$)/;

/** Whether this is an IP address literal in 127.0.0.0/8 or ::1 (the IPv4-mapped IPv6 form of 127.0.0.0/8 included). */
export function isLoopbackAddress(address) {
  if (typeof address !== "string") return false;
  const family = net.isIP(address);
  return family !== 0 && LOOPBACK.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** Writes the one stderr line for a refused host and returns the error to report. Only the host, on one line. */
function refusal(host, what) {
  const label = typeof host === "string" && host !== "" ? host.replace(/\p{Cc}/gu, "?") : "(no host)";
  process.stderr.write(`socket-trap: blocked ${label}\n`);
  return new Error(`socket-trap: blocked ${what} ${label}`);
}

/** The addresses in a lookup answer: an address, an { address } record, or a list of records (all: true). */
const addressesIn = (answer) => (Array.isArray(answer) ? answer : [answer]).map((entry) => (typeof entry === "string" ? entry : entry?.address));

/** Calls lookup(name, options, callback) and passes its answer on only when every address in it is loopback. */
function loopbackOnly(lookup, name, options, callback, what) {
  return lookup(name, options, (error, ...answer) => {
    if (!error && !addressesIn(answer[0]).every(isLoopbackAddress)) callback(refusal(name, what));
    else callback(error, ...answer);
  });
}

function trapConnect(connect, dnsModule) {
  return function trappedConnect(...args) {
    const normalized = Array.isArray(args[0]) && args[0][NORMALIZED] === true ? args[0] : normalizeArgs(args);
    const [options, callback] = normalized;
    const host = options.host || LOCAL_NAME;
    if (options.path || isLoopbackAddress(host)) return connect.call(this, normalized);
    if (host === LOCAL_NAME) {
      const lookup = options.lookup || ((...rest) => dnsModule.lookup(...rest));
      const checked = (name, lookupOptions, done) => loopbackOnly(lookup, name, lookupOptions, done, "connection to");
      // The caller's options stay untouched: net reads every other option through the prototype.
      const withCheck = Object.create(options, { lookup: { value: checked, enumerable: true, writable: true, configurable: true } });
      return connect.call(this, normalizeArgs(callback ? [withCheck, callback] : [withCheck]));
    }
    const error = refusal(host, "connection to");
    this.connecting = true;
    process.nextTick(() => this.destroy(error));
    return this;
  };
}

function trapLookup(lookup) {
  return function trappedLookup(name, ...rest) {
    if (isLoopbackAddress(name)) return lookup.call(this, name, ...rest);
    const [options, callback] = typeof rest[0] === "function" ? [undefined, rest[0]] : rest;
    if (name === LOCAL_NAME && typeof callback === "function") return loopbackOnly(lookup, name, options, callback, "lookup of");
    const error = refusal(name, "lookup of");
    if (typeof callback !== "function") throw error;
    process.nextTick(callback, error);
    return {};
  };
}

function trapPromisesLookup(lookup) {
  return async function trappedLookup(name, ...rest) {
    if (isLoopbackAddress(name)) return lookup.call(this, name, ...rest);
    if (name !== LOCAL_NAME) throw refusal(name, "lookup of");
    const answer = await lookup.call(this, name, ...rest);
    if (!addressesIn(answer).every(isLoopbackAddress)) throw refusal(name, "lookup of");
    return answer;
  };
}

function refuseQuery(promised) {
  return function refusedQuery(name, ...rest) {
    const error = refusal(name, "lookup of");
    if (promised) return Promise.reject(error);
    const callback = rest.at(-1);
    if (typeof callback !== "function") throw error;
    process.nextTick(callback, error);
    return {};
  };
}

/** Replaces holder[key] with makeTrap(real), marked and carrying real's own symbol properties, unless it is a trap. */
function patch(holder, key, makeTrap) {
  const real = holder[key];
  if (typeof real !== "function" || real[MARK] === true) return;
  const trap = makeTrap(real);
  for (const symbol of Object.getOwnPropertySymbols(real)) Object.defineProperty(trap, symbol, Object.getOwnPropertyDescriptor(real, symbol));
  Object.defineProperty(trap, MARK, { value: true });
  holder[key] = trap;
}

/** Patches connect on socketPrototype and the lookup and query functions of dnsModule (the real ones by default). */
export function installSocketTrap({ socketPrototype = net.Socket.prototype, dnsModule = dns } = {}) {
  patch(socketPrototype, "connect", (connect) => trapConnect(connect, dnsModule));
  patch(dnsModule, "lookup", trapLookup);
  const promises = dnsModule.promises;
  if (promises !== undefined) patch(promises, "lookup", trapPromisesLookup);
  const queryHolders = [
    [dnsModule, false],
    [dnsModule.Resolver?.prototype, false],
    [promises, true],
    [promises?.Resolver?.prototype, true],
  ];
  for (const [holder, promised] of queryHolders) {
    if (holder === undefined) continue;
    for (const key of Object.getOwnPropertyNames(holder)) if (QUERY.test(key)) patch(holder, key, () => refuseQuery(promised));
  }
  syncBuiltinESMExports();
}

installSocketTrap();
