import { ALWAYS_PAGES, PAGE_IDS, type PageId } from "@asksite/site-schema";
import { z } from "zod";
import { canonicalJson, sha256Hex } from "./tokens.ts";

/**
 * A16: the pages of a version, stored as canonicalJson in site_versions.pages_json: each page's id and the
 * SHA-256 of its exact bytes, in page order. Home, Services and Contact are always there. A row from before
 * A16 holds '[]', which this refuses, so such a version can never be approved or restored.
 */
export const VersionPages = z
  .array(z.strictObject({ page: z.enum(PAGE_IDS), sha256: z.string().regex(/^[0-9a-f]{64}$/) }))
  .min(ALWAYS_PAGES.length)
  .max(PAGE_IDS.length)
  .refine((pages) => pages.every((p, i) => i === 0 || PAGE_IDS.indexOf(p.page) > PAGE_IDS.indexOf(pages[i - 1]!.page)), {
    error: "Pages must be listed once each, in page order",
  })
  .refine((pages) => ALWAYS_PAGES.every((id) => pages.some((p) => p.page === id)), { error: "Home, Services and Contact are required" });
export type VersionPages = z.infer<typeof VersionPages>;

/** Each page with the SHA-256 of its UTF-8 bytes (what WORK and LIVE store), the other fields kept. */
export async function hashPages<T extends { page: PageId; html: string }>(pages: readonly T[]): Promise<Array<T & { sha256: string }>> {
  return Promise.all(pages.map(async (p) => ({ ...p, sha256: await sha256Hex(p.html) })));
}

/** The version's html_sha256: the SHA-256 of canonicalJson of the page ids and hashes, in order. */
export function pagesDigest(pages: VersionPages): Promise<string> {
  return sha256Hex(canonicalJson(pages.map(({ page, sha256 }) => ({ page, sha256 }))));
}
