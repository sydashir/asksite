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

/** True only for an absolute URL whose scheme is in `allowed`. Relative and protocol-relative URLs are rejected. */
export function isSafeUrl(input: string, allowed: readonly UrlScheme[] = LINK_SCHEMES): boolean {
  if (input === "" || CONTROL_OR_SPACE.test(input)) return false;
  const url = parseUrl(input);
  return url !== undefined && (allowed as readonly string[]).includes(url.protocol);
}
