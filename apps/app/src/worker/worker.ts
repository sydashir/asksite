import { inBackground } from "@asksite/app-common";
import { createApp } from "./app.ts";
import { cleanup } from "./cron.ts";
import type { AppDeps } from "./deps.ts";

export function createWorker(deps: AppDeps): ExportedHandler<Env> {
  const app = createApp(deps);
  return {
    fetch: (request, env, ctx) => app.fetch(request, env, ctx),
    scheduled: (_controller, env, ctx) => {
      inBackground(ctx, "cleanup_failed", cleanup(env.DB, Date.now()));
    },
  };
}
