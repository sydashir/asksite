export type UrlScheme = "http:" | "https:" | "tel:" | "mailto:";

export const LINK_SCHEMES: readonly UrlScheme[] = ["http:", "https:", "tel:", "mailto:"];

// Control characters and whitespace are rejected up front: the URL parser silently strips
// tabs and newlines ("java\tscript:" parses as "javascript:"), so we never let it normalise.
const CONTROL_OR_SPACE = /[\u0000- \u007f]/;

/** True only for an absolute URL whose scheme is in `allowed`. Relative and protocol-relative URLs are rejected. */
export function isSafeUrl(input: string, allowed: readonly UrlScheme[] = LINK_SCHEMES): boolean {
  if (input === "" || CONTROL_OR_SPACE.test(input)) return false;
  if (!URL.canParse(input)) return false;
  return (allowed as readonly string[]).includes(new URL(input).protocol);
}
