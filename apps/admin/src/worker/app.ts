import { ApiError, apiHeaders, handleError, handleNotFound, rateLimit, requireOrigin } from "@asksite/app-common";
import { Hono } from "hono";
import { adminEmail, type AccessKeys } from "./access.ts";
import type { AdminDeps } from "./deps.ts";
import type { AdminEnv } from "./types.ts";

/** The admin API. Every route needs Access plus the allowlist, and every change is audited (§4.5). */
export function createAdminApp(_deps: AdminDeps, keys: AccessKeys): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();
  app.use("/api/*", apiHeaders());
  app.use("/api/admin/*", async (c, next) => {
    const email = await adminEmail(c.req.raw, c.env, keys);
    if (email === null) throw new ApiError("forbidden", "You are not allowed to use the admin");
    await rateLimit(c.env.ADMIN_RL, email);
    c.set("admin", email);
    await next();
  });
  app.use("/api/admin/*", requireOrigin((c) => c.env.ADMIN_ORIGIN));
  app.get("/api/admin/me", (c) => c.json({ email: c.get("admin") }));
  app.notFound(handleNotFound);
  app.onError(handleError);
  return app;
}
