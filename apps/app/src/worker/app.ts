import { apiHeaders, handleError, handleNotFound, requireOrigin } from "@asksite/app-common";
import { Hono } from "hono";
import type { AppDeps } from "./deps.ts";
import { authRoutes } from "./routes/auth.ts";
import { generationRoutes } from "./routes/generations.ts";
import { meRoutes } from "./routes/me.ts";
import { publishRoutes } from "./routes/publish.ts";
import { siteRoutes } from "./routes/sites.ts";
import { slugRoutes } from "./routes/slugs.ts";
import { uploadRoutes } from "./routes/uploads.ts";
import type { AppEnv } from "./types.ts";

/**
 * The owner API (§4.4). Static assets never reach this code: only /api/* runs the Worker first.
 * Every signed-in route adds requireOwner itself.
 */
export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("/api/*", apiHeaders(), requireOrigin((c) => c.env.APP_ORIGIN));
  app.route("/api/auth", authRoutes(deps));
  app.route("/api", meRoutes());
  app.route("/api", siteRoutes(deps));
  app.route("/api", slugRoutes());
  app.route("/api", uploadRoutes());
  app.route("/api", generationRoutes(deps));
  app.route("/api", publishRoutes(deps));
  app.notFound(handleNotFound);
  app.onError(handleError);
  return app;
}
