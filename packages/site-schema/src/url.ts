export type UrlScheme = "http:" | "https:" | "tel:" | "mailto:";

export const LINK_SCHEMES: readonly UrlScheme[] = ["http:", "https:", "tel:", "mailto:"];

// Control characters and whitespace are rejected up front: the URL parser silently strips
// tabs and newlines ("java\tscript:" parses as "javascript:"), so we never let it normalise.
const CONTROL_OR_SPACE = /[\u0000- \u007f]/;

/**
 * The parsed absolute URL, or undefined when `input` is not one. Uses try/new URL rather than
 * URL.canParse: the owner app runs these checks in the browser, and iOS 16 Safari has no
 * URL.canParse (A9).
 */
export function parseUrl(input: string): URL | undefined {
  try {
    return new URL(input);
  } catch {
    return undefined;
  }
}

// http and https are URL "special" schemes: without "//" after the scheme, "https:facebook.com/x"
// parses on its own, but a page on https://joes.example/ resolves it to
// https://joes.example/facebook.com/x (WHATWG URL, "special relative or authority state"). So they
// must be followed by "//" (A9). tel: and mailto: are not special and never resolve against a page.
const NEEDS_SLASHES: ReadonlySet<string> = new Set(["http:", "https:"]);

/** True only for an absolute URL whose scheme is in `allowed`. Relative and protocol-relative URLs are rejected. */
export function isSafeUrl(input: string, allowed: readonly UrlScheme[] = LINK_SCHEMES): boolean {
  if (input === "" || CONTROL_OR_SPACE.test(input)) return false;
  const url = parseUrl(input);
  if (url === undefined || !(allowed as readonly string[]).includes(url.protocol)) return false;
  // The input starts with its scheme exactly (CONTROL_OR_SPACE refused anything the parser would strip).
  return !NEEDS_SLASHES.has(url.protocol) || input.startsWith("//", url.protocol.length);
}
