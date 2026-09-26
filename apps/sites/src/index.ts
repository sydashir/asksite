// asksite-sites: public site pages, photos and contact forms on customer hostnames.
// A Worker's main module may export only handlers (workerd refuses other named exports).
import type { Env } from "./env.ts";
import { logLine } from "./log.ts";
import { route } from "./router.ts";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const started = Date.now();
    const { route: name, response, siteId, code } = await route(request, env, ctx, started);
    logLine({ route: name, status: response.status, ms: Date.now() - started, ...(siteId === undefined ? {} : { siteId }), ...(code === undefined ? {} : { code }) });
    return request.method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
  },
} satisfies ExportedHandler<Env>;
