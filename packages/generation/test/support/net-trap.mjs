// Process-level network guard for every Node process an agent starts (NET-TRAP brief, 2026-09-27). Load it BEFORE any
// other module through NODE_OPTIONS, with the provider variables removed:
//
//   env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_CUSTOM_HEADERS -u ANTHROPIC_BASE_URL -u ANTHROPIC_LOG -u OPENAI_COMPAT_API_KEY NODE_OPTIONS="--import=/Users/ashir/Documents/workk2/asksite-plan3/packages/generation/test/support/net-trap.mjs" pnpm ...
//
// Node preloads an --import module "into the main thread as well as any worker threads, forked processes, or clustered
// processes" (Node 25.6.1 doc/api/cli.md:1602-1611), and --import is allowed in NODE_OPTIONS (cli.md:3616), which every
// child that inherits the environment gets, vitest's forked test workers included.
//
// On import it replaces globalThis.fetch with a trap that lets through ONLY data: and blob: URLs, and http(s) URLs whose
// hostname, as `new URL(url).hostname` gives it, is exactly localhost, 127.0.0.1 or [::1] (the URL Standard serializes an
// IPv6 host with its brackets and lowercases a domain), or ends with .localhost. Everything else, any .invalid host
// included, is refused before any I/O: one stderr line `net-trap: blocked <hostname>` (never the path, query, headers,
// body or a key) and a promise rejected with a TypeError, as fetch itself rejects. The real fetch lives only in the
// closure. The trap carries Symbol.for("asksite.netTrap") for identity checks; importing this module again (or calling
// installNetTrap again) leaves an existing trap as it is instead of wrapping it.
//
// Why the global covers both adapters (checked on 2026-09-27):
// - @anthropic-ai/sdk 0.128.0 takes fetch from the global when a client is built, unless one is passed (client.mjs:113
//   `this.fetch = options.fetch ?? Shims.getDefaultFetch()`; internal/shims.mjs:1-5 returns the global `fetch`). It imports
//   no undici, node:http, node:https, node:net, node:tls or node:dns (grep over the package's .mjs/.js/.cjs files; its only
//   Node built-ins are in internal/node.mjs: child_process, crypto, fs, os, path, stream and util).
// - OpenAICompatibleProvider calls the global fetch at call time (src/providers/openai-compatible.ts:143).
// - Nothing in packages/generation/src imports node:http, node:https, node:net or undici (grep).
// NOT trapped: node:http, node:https, node:net and undici's own fetch; a redirect answered by an allowed local server
// (the real fetch follows it unless the caller sets redirect "manual"); a *.localhost name goes to the system resolver,
// which RFC 6761 section 6.3 says should answer with the loopback address.

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
  return LOOPBACK_HOSTS.has(parsed.hostname) || parsed.hostname.endsWith(".localhost");
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
