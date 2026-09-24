import { slugIssue } from "./slug.ts";

// The only place R2 keys and public URLs are built. `root` is ROOT_DOMAIN: host[:port].

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
