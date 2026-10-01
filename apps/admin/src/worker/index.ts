import { dailyModelLimit, toGenerationView, worstCaseJobMicrousd } from "@asksite/generation";
import { createMailer } from "@asksite/mailer";
import { approveVersion, PublishError, rejectVersion, restore, setIndexable, takeDown } from "@asksite/publishing";
import type { AdminDeps } from "./deps.ts";
import { createAdminWorker } from "./worker.ts";

const deps = {
  publishing: { PublishError, approveVersion, rejectVersion, takeDown, restore, setIndexable },
  generation: { dailyModelLimit, worstCaseJobMicrousd, toGenerationView },
  createMailer,
} satisfies AdminDeps;

export default createAdminWorker(deps);
