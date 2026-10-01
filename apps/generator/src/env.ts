import type { JobEnv } from "@asksite/generation";

/**
 * Bindings, variables (wrangler.jsonc vars, overridden locally by .dev.vars) and secrets
 * (ANTHROPIC_API_KEY or OPENAI_COMPAT_API_KEY, set with `wrangler secret put`). Written by hand
 * from @cloudflare/workers-types' importable types: `wrangler types` declares global runtime
 * types that would clash with @types/node in the shared root typecheck.
 */
export type Env = JobEnv;
