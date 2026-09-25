import { apiHeaders, handleError, handleNotFound, requireOrigin } from "@asksite/app-common";
import { Hono } from "hono";
import type { AppDeps } from "./deps.ts";
import type { AppEnv } from "./types.ts";

/**
 * The owner API (§4.4). Static assets never reach this code: only /api/* runs the Worker first.
 * Every signed-in route adds requireOwner itself.
 */
export function createApp(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("/api/*", apiHeaders(), requireOrigin((c) => c.env.APP_ORIGIN));
  app.notFound(handleNotFound);
  app.onError(handleError);
  return app;
}
