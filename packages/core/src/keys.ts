import { isPageId, PAGES, type PageId } from "@asksite/site-schema";
import { isId } from "./ids.ts";
import { slugIssue } from "./slug.ts";

// The only place R2 keys and public URLs are built. `root` is ROOT_DOMAIN: host[:port].

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
// The builders accept only a slug of the right shape (not "/" or "."; a reserved word is accepted, so a site whose
// slug later became reserved can still be served and taken down), a real id and one of the 5 page ids, each a
// string. So no key of one site is another site's key, its pointer, or under its prefix, and a request path or a
// damaged pointer cannot shape a key or a takedown's prefix delete.
function knownPage(page: PageId): PageId {
  if (!isPageId(page)) throw new Error("Unknown page id");
  return page;
}
function knownSlug(slug: string): string {
  if (typeof slug !== "string" || slugIssue(slug) === "invalid") throw new Error("Invalid slug");
  return slug;
}
function knownId(id: string, what: "site" | "version"): string {
  if (typeof id !== "string" || !isId(id)) throw new Error(`Unknown ${what} id`);
  return id;
}
/** The site's live pointer: an empty object whose customMetadata names the live version (and the business). */
export const livePointerKey = (slug: string) => knownSlug(slug);
/** Every LIVE page object of a site sits under this prefix; the pointer does not. */
export const liveSitePrefix = (slug: string) => `${knownSlug(slug)}/`;
export const livePageKey = (slug: string, versionId: string, page: PageId) =>
  `${liveSitePrefix(slug)}${knownId(versionId, "version")}/${knownPage(page)}.html`;
export function versionPageKey(siteId: string, versionId: string, page: PageId): string {
  const site = knownId(siteId, "site");
  const version = knownId(versionId, "version");
  return knownPage(page) === "home" ? versionKey(site, version) : `versions/${site}/${version}/${page}.html`;
}
/** A page's public URL, also its canonical URL: siteUrl for Home, else https://<slug>.<root>/<page>. */
export const publicPageUrl = (root: string, slug: string, page: PageId) => `https://${slug}.${root}${PAGES[knownPage(page)].path}`;
/** The sites Worker's edge-cache key for a page of a version: the version id is in the PATH, not a query (a zone's
 *  cache-key settings can strip a query string), so a cached page can never be served for another version. */
export const pageCacheUrl = (root: string, slug: string, versionId: string, page: PageId) =>
  `https://${knownSlug(slug)}.${root}/__v/${knownId(versionId, "version")}${PAGES[knownPage(page)].path}`;
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
