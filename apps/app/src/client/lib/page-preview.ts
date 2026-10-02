import { PAGES, type PageId } from "@asksite/site-schema";

/**
 * The page the preview shows: the one the viewer chose while the site still has it, else Home (the first page), with
 * the line the status region says about the change. Never a silent switch.
 */
export function pageToShow(pages: readonly { page: PageId }[], wanted: PageId): { page: PageId; note: string | null } {
  if (pages.some((p) => p.page === wanted)) return { page: wanted, note: null };
  const home = pages[0]?.page ?? "home";
  return { page: home, note: `The ${PAGES[wanted].label} page is no longer on your site. Showing ${PAGES[home].label}.` };
}
