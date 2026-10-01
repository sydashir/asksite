// A13 probe: the sites Worker's own handler, plus one path that reports whether Node.js compatibility
// is off in the runtime it runs in (runtime.workerd.test.ts starts it with the compatibility date and
// flags of apps/sites/wrangler.jsonc). Both answers are needed: with only nodejs_compat_v2 off,
// `typeof process` is already "undefined", but node:* modules are still there; node:buffer goes only
// when nodejs_compat is off too.
import type { Env } from "../../src/env.ts";
import sites from "../../src/index.ts";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    if (new URL(request.url).pathname !== "/__runtime") return sites.fetch(request, env, ctx);
    // Built at run time, so the bundler leaves the import to the Workers runtime.
    const nodeBuffer = ["node", "buffer"].join(":");
    const buffer = await import(nodeBuffer).then(() => "importable", () => "absent");
    return Response.json({ process: typeof process, nodeBuffer: buffer });
  },
} satisfies ExportedHandler<Env>;
