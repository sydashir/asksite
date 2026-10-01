// Process-level network guard for every Node process an agent starts (NET-TRAP brief and fix r1, 2026-09-27): the
// fetch layer. socket-trap.mjs is the second, independent layer under it. Load both BEFORE any other module through
// NODE_OPTIONS, with the provider variables removed (global-constraints.md L2):
//
//   env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_CUSTOM_HEADERS -u ANTHROPIC_BASE_URL -u ANTHROPIC_LOG -u OPENAI_COMPAT_API_KEY CLOUDFLARE_CF_FETCH_ENABLED=false WRANGLER_SEND_METRICS=false ASKSITE_NET_TRAP=required NODE_OPTIONS="--import=/Users/ashir/Documents/workk2/asksite-plan3/packages/generation/test/support/net-trap.mjs --import=/Users/ashir/Documents/workk2/asksite-plan3/packages/generation/test/support/socket-trap.mjs" pnpm ...
//
// Node preloads an --import module "into the main thread as well as any worker threads, forked processes, or clustered
// processes" (Node 25.6.1 doc/api/cli.md:1602-1611), and --import is allowed in NODE_OPTIONS (cli.md:3616), which every
// child that inherits the environment gets, vitest's forked test workers included.
//
// On import it replaces globalThis.fetch with a trap that lets through ONLY data: and blob: URLs, and http(s) URLs whose
// hostname, as `new URL(url).hostname` gives it, is exactly localhost, 127.0.0.1 or [::1] (the URL Standard serializes an
// IPv6 host with its brackets and lowercases a domain). Everything else is refused before any I/O, any .invalid host
// and any *.localhost name included (Node sends a *.localhost name to the system resolver, which on this Mac is not
// local): one stderr line `net-trap: blocked <hostname>` (never the path, query, headers, body or a key) and a promise
// rejected with a TypeError, as fetch itself rejects. The real fetch lives only in the closure. The trap carries
// Symbol.for("asksite.netTrap") for identity checks; importing this module again (or calling installNetTrap again)
// leaves an existing trap as it is instead of wrapping it.
//
// Why the global covers both adapters (checked on 2026-09-27):
// - @anthropic-ai/sdk 0.128.0 takes fetch from the global when a client is built, unless one is passed (client.mjs:113
//   `this.fetch = options.fetch ?? Shims.getDefaultFetch()`; internal/shims.mjs:1-6 returns the global `fetch`). It imports
//   no undici, node:http, node:https, node:http2, node:net, node:tls, node:dns or node:dgram (grep over its 388
//   .mjs/.js/.cjs files). Its Node built-in imports are exactly: internal/node.mjs:6-12 child_process, crypto, fs, os,
//   path, stream, util; tools/agent-toolset/node.mjs:33-38 fs/promises, fs, path, child_process, crypto, readline;
//   tools/memory/node.mjs:2-4 fs/promises, path, crypto; and the same in each file's .js twin. (internal/uploads.mjs:8
//   names node:buffer only inside an error message.)
// - OpenAICompatibleProvider calls the global fetch at call time (src/providers/openai-compatible.ts:143).
// - Nothing in packages/generation/src imports node:http, node:https, node:net or undici (grep).
// NOT trapped here (socket-trap.mjs checks the TCP leg of each of the first five; see its header for what neither sees):
// - node:http, node:https, node:net, node:tls, http2, the global WebSocket and undici's own fetch: none calls
//   globalThis.fetch.
// - A redirect answered by an allowed local server: the real fetch follows it without coming back here, unless the
//   caller sets redirect "manual" (both adapters do). socket-trap.test.ts proves the socket layer stops the remote leg.
// - init.dispatcher, or a global undici dispatcher such as a proxy agent, which sends an allowed URL's connection
//   somewhere else (Node's bundled undici keeps init.dispatcher, internal/deps/undici/undici.js:11060).
// - undici's global origin (Symbol.for("undici.globalOrigin.1")): the trap parses the URL with no base, but the real
//   fetch parses it against that origin (undici.js:11057-11063, 6059-6060), so "http:localhost/x" could mean another
//   host. Nothing here sets it (grep).
// - A fetch saved before this module ran.
// - Worker threads started with eval: true or with an env that lacks NODE_OPTIONS (they skip --import preloads), and
//   modules preloaded with --require, which run before --import (cli.md:1608).

const MARK = Symbol.for("asksite.netTrap");
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const NO_NETWORK_SCHEMES = new Set(["data:", "blob:"]);
// The getter that reads a Request's own URL: a "url" property set on one instance cannot disguise its destination.
const requestUrl = Object.getOwnPropertyDescriptor(Request.prototype, "url").get;

const parse = (url) => {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
};

/** Whether a request to this URL may go on to the real fetch. */
export function isAllowed(url) {
  const parsed = parse(url);
  if (parsed === undefined) return false;
  if (NO_NETWORK_SCHEMES.has(parsed.protocol)) return true;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return LOOPBACK_HOSTS.has(parsed.hostname);
}

/**
 * What fetch would be asked for: a Request as it is, any other input (string, URL, anything with a toString) as the URL
 * text fetch would read from it. That text is checked AND passed on, so an input cannot change between the two. The URL
 * is "" when it cannot be read.
 */
function destination(input) {
  try {
    if (input instanceof Request) return { input, url: requestUrl.call(input) };
    const url = String(input);
    return { input: url, url };
  } catch {
    return { input, url: "" };
  }
}

/** Replaces target.fetch with the trap, unless it is one already. Returns the trap in place. */
export function installNetTrap(target = globalThis) {
  if (target.fetch?.[MARK] === true) return target.fetch;
  const realFetch = target.fetch;
  async function netTrapFetch(input, init) {
    const checked = destination(input);
    if (isAllowed(checked.url)) return realFetch(checked.input, init);
    const host = parse(checked.url)?.hostname || "(no host)";
    process.stderr.write(`net-trap: blocked ${host}\n`);
    throw new TypeError(`net-trap: blocked request to ${host}`);
  }
  Object.defineProperty(netTrapFetch, MARK, { value: true });
  target.fetch = netTrapFetch;
  return netTrapFetch;
}

installNetTrap();
