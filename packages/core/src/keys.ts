import { isPageId, PAGES, type PageId } from "@asksite/site-schema";
import { isId } from "./ids.ts";
import { slugIssue } from "./slug.ts";

// The only place R2 keys and public URLs are built. `root` is ROOT_DOMAIN: host[:port].

// Today's single-page LIVE key. A16-2 moves its callers to livePointerKey and livePageKey, then removes it.
export const liveKey = (slug: string) => `${slug}.html`;
export const versionKey = (siteId: string, versionId: string) => `versions/${siteId}/${versionId}.html`;
export const mediaKey = (siteId: string, uploadId: string) => `${siteId}/${uploadId}.webp`; // in MEDIA
export const siteUrl = (root: string, slug: string) => `https://${slug}.${root}/`;
export const formActionUrl = (root: string, slug: string, siteId: string) => `https://${slug}.${root}/_f/${siteId}`;
/** The owner app's in-browser preview renders with this before a slug is chosen ("preview" is reserved;
 *  the sandboxed preview can never submit the form anyway). */
export const previewFormActionUrl = (root: string, slug: string | null, siteId: string) =>
  formActionUrl(root, slug ?? "preview", siteId);
export const mediaUrl = (root: string, siteId: string, uploadId: string) => `https://media.${root}/${siteId}/${uploadId}.webp`;

// A16 + U2 (user, 2026-10-01: all pages switch together and a visitor never sees two versions mixed).
// LIVE holds one small pointer per site, naming its live version, and the approved pages at immutable keys under
// the slug and that version id: writing the pointer switches every page at once. WORK keeps Home at today's key.
// Slugs and ids never contain "/" or ".", so no key of one site can be another site's key or the pointer. Only the
// 5 page ids, and for LIVE pages only a real version id, are accepted: a request path or a damaged pointer can
// never choose a key.
function knownPage(page: PageId): PageId {
  if (!isPageId(page)) throw new Error("Unknown page id");
  return page;
}
/** The site's live pointer: an empty object whose customMetadata names the live version (and the business). */
export const livePointerKey = (slug: string) => slug;
/** Every LIVE page object of a site sits under this prefix; the pointer does not. */
export const liveSitePrefix = (slug: string) => `${slug}/`;
export function livePageKey(slug: string, versionId: string, page: PageId): string {
  if (!isId(versionId)) throw new Error("Unknown version id");
  return `${liveSitePrefix(slug)}${versionId}/${knownPage(page)}.html`;
}
export const versionPageKey = (siteId: string, versionId: string, page: PageId) =>
  knownPage(page) === "home" ? versionKey(siteId, versionId) : `versions/${siteId}/${versionId}/${page}.html`;
/** A page's public URL, also its canonical URL: siteUrl for Home, else https://<slug>.<root>/<page>. */
export const publicPageUrl = (root: string, slug: string, page: PageId) => `https://${slug}.${root}${PAGES[knownPage(page)].path}`;
/** The site URL the owner app's preview renders with before a slug is chosen (as previewFormActionUrl). */
export const previewSiteUrl = (root: string, slug: string | null) => siteUrl(root, slug ?? "preview");

export type HostKind =
  | { kind: "apex" }
  | { kind: "www" }
  | { kind: "media" }
  | { kind: "site"; slug: string }
  | { kind: "unknown" };

/**
 * host = URL.host (lower-case, includes a non-default port); root = ROOT_DOMAIN.
 * host === root -> apex; "www." + root -> www; "media." + root -> media;
 * "<label>." + root where <label> has no "." and slugIssue(label) === null -> site;
 * anything else (deeper subdomains, reserved labels such as "app", other domains, a port mismatch) -> unknown.
 */
export function parseHost(host: string, root: string): HostKind {
  const h = host.toLowerCase();
  const r = root.toLowerCase();
  if (h === r) return { kind: "apex" };
  if (!h.endsWith(`.${r}`)) return { kind: "unknown" };
  const label = h.slice(0, h.length - r.length - 1);
  if (label === "www") return { kind: "www" };
  if (label === "media") return { kind: "media" };
  if (!label.includes(".") && slugIssue(label) === null) return { kind: "site", slug: label };
  return { kind: "unknown" };
}
