import { versionPageKey, VersionPages } from "@asksite/core";
import { PAGE_IDS } from "@asksite/site-schema";
import { z } from "zod";

const PageIdParam = z.enum(PAGE_IDS);

/** The pages a version row lists (pages_json parsed as VersionPages), or null when the list is empty ('[]', a row from before A16) or damaged. */
export function storedPages(pagesJson: string): VersionPages | null {
  try {
    const parsed = VersionPages.safeParse(JSON.parse(pagesJson));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The WORK key of one page of a stored version, for the owner's and the admin's per-page routes, or null (the routes answer
 * 404). `row` is the version's own row, already found by its id (and, for the owner, by the owner's site). The page id is
 * one of the five (z.enum(PAGE_IDS)); the page must be listed in the row's pages_json (storedPages), so a row from before
 * A16 ('[]') or a damaged list answers null for every page; the key is versionPageKey's, never built by hand.
 */
export function storedPageKey(row: { id: string; site_id: string; pages_json: string }, pageId: string): string | null {
  const page = PageIdParam.safeParse(pageId);
  if (!page.success) return null;
  return storedPages(row.pages_json)?.some((entry) => entry.page === page.data) ? versionPageKey(row.site_id, row.id, page.data) : null;
}
