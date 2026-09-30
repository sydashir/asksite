import { ApiError, apiHeaders, handleError, handleNotFound, rateLimit, requireOrigin } from "@asksite/app-common";
import { Hono, type MiddlewareHandler } from "hono";
import { adminEmail, type AccessKeys } from "./access.ts";
import type { AdminDeps } from "./deps.ts";
import { inviteRoutes } from "./routes/invites.ts";
import { reviewRoutes } from "./routes/reviews.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { signInRoutes } from "./routes/sign-in.ts";
import { siteRoutes } from "./routes/sites.ts";
import type { AdminEnv } from "./types.ts";

/**
 * Fetch Metadata (MDN "Sec-Fetch-Site"; web.dev "Protect your resources from web attacks with Fetch Metadata"):
 * browsers say where each request comes from, and pages cannot set the header. Only the admin's own pages call
 * this API, so a request a browser marks as coming from anywhere else is refused, whatever its method:
 * "cross-site", "same-site" (an owner's site is a subdomain) and "none" (an address typed in or bookmarked).
 * A request without the header, from a client that does not send it, goes on to the Origin check.
 */
const sameOriginOnly: MiddlewareHandler<AdminEnv> = async (c, next) => {
  const site = c.req.header("Sec-Fetch-Site");
  if (site !== undefined && site !== "same-origin") throw new ApiError("forbidden", "This request is not allowed from another site");
  await next();
};

/** The admin API. Every route needs Access plus the allowlist, and every change is audited (§4.5). */
export function createAdminApp(deps: AdminDeps, keys: AccessKeys): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();
  app.use("/api/*", apiHeaders());
  // In this order (moderator ruling, 2026-09-29): Fetch Metadata, the Origin check, Access and the allowlist,
  // then ADMIN_RL. A request from another site never has its token checked and never spends an admin's limit.
  app.use("/api/admin/*", sameOriginOnly);
  app.use("/api/admin/*", requireOrigin((c) => c.env.ADMIN_ORIGIN));
  app.use("/api/admin/*", async (c, next) => {
    const email = await adminEmail(c.req.raw, c.env, keys);
    if (email === null) throw new ApiError("forbidden", "You are not allowed to use the admin");
    await rateLimit(c.env.ADMIN_RL, email);
    c.set("admin", email);
    await next();
  });
  app.get("/api/admin/me", (c) => c.json({ email: c.get("admin") }));
  app.route("/api/admin", inviteRoutes(deps));
  app.route("/api/admin", reviewRoutes(deps));
  app.route("/api/admin", siteRoutes(deps));
  app.route("/api/admin", signInRoutes(deps));
  app.route("/api/admin", settingsRoutes(deps));
  app.notFound(handleNotFound);
  app.onError(handleError);
  return app;
}
