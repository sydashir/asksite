// asksite-sites: public site pages, photos and contact forms on customer hostnames.
// A Worker's main module may export only handlers (workerd refuses other named exports).
import { deleteOldLeads } from "./cron.ts";
import type { Env } from "./env.ts";
import { logLine } from "./log.ts";
import { unavailable } from "./pages.ts";
import { route, type Routed } from "./router.ts";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const started = Date.now();
    let routed: Routed;
    try {
      routed = await route(request, env, ctx, started);
    } catch {
      // Anything unexpected (D1 or R2 failing outside a guarded read, a broken request body) gets our
      // 503 page with noindex and Retry-After, never the platform's error page (design §7.4; Decision 26).
      routed = { route: "error", response: unavailable(env.ROOT_DOMAIN), code: "internal" };
    }
    const { route: name, response, siteId, code } = routed;
    logLine({ route: name, status: response.status, ms: Date.now() - started, ...(siteId === undefined ? {} : { siteId }), ...(code === undefined ? {} : { code }) });
    return request.method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
  },

  async scheduled(controller, env): Promise<void> {
    const started = Date.now();
    const result = await deleteOldLeads(env.DB, controller.scheduledTime);
    logLine({
      route: "cron_lead_retention",
      ms: Date.now() - started,
      deleted: result.deleted,
      deletedSpam: result.spam,
      deletedExpired: result.expired,
      ...(result.sizeAfter === undefined ? {} : { dbBytes: result.sizeAfter }),
    });
  },
} satisfies ExportedHandler<Env>;
