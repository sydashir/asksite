import { generationAllowance, requestGeneration, toGenerationView } from "@asksite/generation";
import { createMailer } from "@asksite/mailer";
import { createPendingVersion, PublishError, withdrawPending } from "@asksite/publishing";
import type { AppDeps } from "./deps.ts";
import { createWorker } from "./worker.ts";

const deps = {
  generation: { requestGeneration, generationAllowance, toGenerationView },
  publishing: { PublishError, createPendingVersion, withdrawPending },
  createMailer,
  // A plain call of the global fetch (no `this` of another object), so workerd cannot say "Illegal invocation".
  siteverify: (url, init) => fetch(url, init),
} satisfies AppDeps;

export default createWorker(deps);
