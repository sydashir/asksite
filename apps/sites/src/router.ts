import { isId, parseHost } from "@asksite/core";
import { securityTxt } from "./apex.ts";
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

const FORM = /^\/_f\/([^/]+)$/;
const SENT = /^\/_f\/([^/]+)\/sent$/;

/** Routes by the Host header (design §4.6). Anything not listed is a 404 page. */
export async function route(request: Request, env: Env, ctx: ExecutionContext, now: number): Promise<Routed> {
  const url = new URL(request.url);
  const path = url.pathname;
  const root = env.ROOT_DOMAIN;
  const read = request.method === "GET" || request.method === "HEAD";
  const host = parseHost(url.host, root);

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
      if (read && path === "/") return { route: "page", response: await servePage(env, ctx, host.slug) };
      const form = FORM.exec(path);
      if (form !== null && request.method === "POST") {
        const siteId = form[1] ?? "";
        const { response, code } = await handleForm(request, env, ctx, host.slug, siteId, now);
        return { route: "form", response, ...(isId(siteId) ? { siteId } : {}), ...(code === undefined ? {} : { code }) };
      }
      const sent = SENT.exec(path);
      if (sent !== null && read && isId(sent[1] ?? "")) return { route: "form_sent", response: thankYou(root) };
      break;
    }
    case "unknown":
      break;
  }
  return { route: "not_found", response: notFound(root) };
}
