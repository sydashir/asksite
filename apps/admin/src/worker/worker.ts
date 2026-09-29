import { remoteAccessKeys, type AccessKeys } from "./access.ts";
import { createAdminApp } from "./app.ts";
import type { AdminDeps } from "./deps.ts";

export function createAdminWorker(deps: AdminDeps, keys: AccessKeys = remoteAccessKeys): ExportedHandler<Env> {
  const app = createAdminApp(deps, keys);
  return { fetch: (request, env, ctx) => app.fetch(request, env, ctx) };
}
