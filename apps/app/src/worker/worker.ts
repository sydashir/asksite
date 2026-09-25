import { createApp } from "./app.ts";
import type { AppDeps } from "./deps.ts";

export function createWorker(deps: AppDeps): ExportedHandler<Env> {
  const app = createApp(deps);
  return { fetch: (request, env, ctx) => app.fetch(request, env, ctx) };
}
