import { createHash } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { publicPageUrl } from "@asksite/core";
import { ALWAYS_PAGES, type PageId } from "@asksite/site-schema";
import { expect, type APIRequestContext, type Page } from "@playwright/test";

// Shared by the owner's and the admin's journeys: one local runtime answers every host on one port.
export const APP = "https://app.localhost:8789";
export const ADMIN = "https://admin.localhost:8789";
/** Customer pages (<slug>.localhost) and photos (media.localhost) are on the same port. */
export const LIVE_PORT = 8789;
/** The sites Worker keeps a page at the edge for 60 s (s-maxage=60); the wait below adds a margin. */
const EDGE_COPY_MS = 65_000;

export async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).exclude("iframe").analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
}

/** The newest email to `to` whose subject matches, from the log mailer's outbox (development only, §4.4). */
export async function latestEmail(request: APIRequestContext, to: string, subject: RegExp): Promise<string> {
  let text = "";
  await expect
    .poll(async () => {
      const res = await request.get(`${APP}/api/dev/outbox?to=${encodeURIComponent(to)}`);
      const { messages } = (await res.json()) as { messages: Array<{ subject: string; text: string }> };
      text = messages.find((m) => subject.test(m.subject))?.text ?? "";
      return text;
    }, { timeout: 30_000 })
    .not.toBe("");
  return text;
}

/**
 * The admin's API, signed in by the local development mode (ADMIN_AUTH_MODE=dev, only on *.localhost,
 * §5.3). The journeys drive the admin through its API: one local runtime serves the static files of
 * only one Worker (the first with assets; verified), and the admin screens have their own browser
 * tests (Task 23).
 */
export async function adminApi(request: APIRequestContext, method: "GET" | "POST" | "PUT", path: string, data?: unknown) {
  const res = await request.fetch(`${ADMIN}${path}`, { method, headers: { Origin: ADMIN }, ...(data === undefined ? {} : { data }) });
  expect(res.status(), `${method} ${path}`).toBeLessThan(300);
  return res;
}

const sha256Hex = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** One page of a version as the admin's detail lists it. */
export interface ListedPage {
  page: PageId;
  label: string;
  url: string;
  sha256: string;
}

export interface ReviewedVersion {
  htmlSha256: string;
  pages: ListedPage[];
  /** Each page's stored bytes as text, read through the admin's per-page route. */
  html: Record<string, string>;
}

/**
 * The admin reads a version for review: the list of its pages (it starts with Home, holds every page a
 * site always has, and holds the Gallery only when the site has photos), then EVERY listed page through
 * its own route: served sandboxed, and its bytes hash to the listed sha256. Returns the digest Approve sends back.
 */
export async function reviewVersion(admin: APIRequestContext, versionId: string, options: { gallery: boolean }): Promise<ReviewedVersion> {
  const detail = (await (await adminApi(admin, "GET", `/api/admin/versions/${versionId}`)).json()) as { version: { htmlSha256: string }; pages: ListedPage[] };
  const ids = detail.pages.map((p) => p.page);
  expect(ids[0]).toBe("home");
  expect(ids).toEqual(expect.arrayContaining([...ALWAYS_PAGES]));
  expect(ids.includes("gallery")).toBe(options.gallery);
  const html: Record<string, string> = {};
  for (const listed of detail.pages) {
    expect(listed.url).toBe(`/api/admin/versions/${versionId}/pages/${listed.page}`);
    const stored = await adminApi(admin, "GET", listed.url);
    expect(stored.headers()["content-security-policy"], listed.page).toContain("sandbox");
    const bytes = await stored.body();
    expect(sha256Hex(bytes), `stored ${listed.page}`).toBe(listed.sha256);
    html[listed.page] = bytes.toString("utf8");
  }
  return { htmlSha256: detail.version.htmlSha256, pages: detail.pages, html };
}

/** A customer page's address, from core's own helper (never a typed path). */
export const pageUrl = (slug: string, page: PageId) => publicPageUrl(`localhost:${LIVE_PORT}`, slug, page);

/**
 * Every listed page answers 200 at once, and its bytes are the listed ones (so each path serves its own
 * approved page, never Home's). Returns the bodies and the time of the last fetch.
 */
export async function expectLive(request: APIRequestContext, slug: string, pages: ListedPage[]) {
  const html: Record<string, string> = {};
  for (const listed of pages) {
    const res = await request.get(pageUrl(slug, listed.page));
    expect(res.status(), `live ${listed.page}`).toBe(200);
    const bytes = await res.body();
    expect(sha256Hex(bytes), `live ${listed.page}`).toBe(listed.sha256);
    html[listed.page] = bytes.toString("utf8");
  }
  return { html, fetchedAt: Date.now() };
}

/**
 * Every listed page answers 404 at once, and it is the plain 404 of a site with no pointer: a page the
 * site merely lacks gets a 404 that links back to the business ("Go to ...").
 */
export async function expectOffline(request: APIRequestContext, slug: string, pages: ListedPage[]) {
  for (const listed of pages) {
    const res = await request.get(pageUrl(slug, listed.page));
    expect(res.status(), `offline ${listed.page}`).toBe(404);
    expect(await res.text(), `offline ${listed.page}`).not.toContain("Go to ");
  }
}

/** Waits until the sites Worker's 60 s edge copy of every page fetched at `since` has expired, so the next 200 must come from storage. */
export async function waitOutEdgeCopy(since: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, since + EDGE_COPY_MS - Date.now())));
}
