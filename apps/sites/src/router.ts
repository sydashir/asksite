import { isId, parseHost, publicPageUrl } from "@asksite/core";
import { pageForPath } from "@asksite/site-schema";
import { securityTxt } from "./apex.ts";
import { formBusiness, liveSiteName } from "./business.ts";
import type { Env } from "./env.ts";
import { handleForm } from "./form.ts";
import { plainHeaders } from "./headers.ts";
import { serveMedia } from "./media.ts";
import { servePage } from "./page.ts";
import { apexPlaceholder, notFound, thankYou } from "./pages.ts";

export interface Routed {
  route: string;
  response: Response;
  siteId?: string;
  code?: string;
}

// The pages name no icon, so browsers ask for /favicon.ico on every host they show. An empty answer they
// may keep for a week needs no D1 or R2 read and spares a 404 page on every visit (A15; a real per-site
// icon is on the A12 design-build list).
const noFavicon = () => new Response(null, { status: 204, headers: plainHeaders({ "Cache-Control": "public, max-age=604800" }) });

const FORM = /^\/_f\/([^/]+)$/;
const SENT = /^\/_f\/([^/]+)\/sent$/;

/** Routes by the Host header (design §4.6). Anything not listed is a 404 page. */
export async function route(request: Request, env: Env, ctx: ExecutionContext, now: number): Promise<Routed> {
  const url = new URL(request.url);
  const path = url.pathname;
  const root = env.ROOT_DOMAIN;
  const read = request.method === "GET" || request.method === "HEAD";
  const host = parseHost(url.host, root);
  if (read && path === "/favicon.ico" && (host.kind === "site" || host.kind === "apex")) return { route: "favicon", response: noFavicon() };

  switch (host.kind) {
    case "www":
      return { route: "www", response: new Response(null, { status: 301, headers: plainHeaders({ Location: `https://${root}/` }) }) };
    case "apex":
      if (read && path === "/") return { route: "apex", response: apexPlaceholder(root) };
      if (read && path === "/.well-known/security.txt") return { route: "security_txt", response: securityTxt(env) };
      break;
    case "media":
      if (read) return { route: "media", response: await serveMedia(env, ctx, path) };
      break;
    case "site": {
      const page = read ? pageForPath(path) : null;
      if (page !== null) return { route: "page", response: await servePage(env, ctx, host.slug, page) };
      // "/services/" is the page's one canonical address; Home has none (its path is "/" itself).
      const slashed = read && path.endsWith("/") ? pageForPath(path.slice(0, -1)) : null;
      if (slashed !== null && slashed !== "home") {
        return { route: "page_redirect", response: new Response(null, { status: 301, headers: plainHeaders({ Location: publicPageUrl(root, host.slug, slashed) }) }) };
      }
      const form = FORM.exec(path);
      if (form !== null && request.method === "POST") {
        const siteId = form[1] ?? "";
        const { response, code } = await handleForm(request, env, ctx, host.slug, siteId, now);
        return { route: "form", response, ...(isId(siteId) ? { siteId } : {}), ...(code === undefined ? {} : { code }) };
      }
      const sentId = SENT.exec(path)?.[1] ?? "";
      if (read && isId(sentId)) {
        return { route: "form_sent", response: thankYou(root, (await formBusiness(env.LIVE, host.slug, sentId)).name) };
      }
      // A browser's wrong path on a live site links to the site's page (QA-2 RU(3)), named from the LIVE pointer
      // alone, never D1 (Decision 24); other methods get the plain 404.
      if (read) return { route: "not_found", response: notFound(root, await liveSiteName(env.LIVE, host.slug)) };
      break;
    }
    case "unknown":
      break;
  }
  return { route: "not_found", response: notFound(root) };
}
