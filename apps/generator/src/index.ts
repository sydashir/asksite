import { isId, type GenerationJob } from "@asksite/core";
import { runGenerationJob, sweepStuckJobs } from "@asksite/generation";
import type { ExportedHandler, MessageBatch } from "@cloudflare/workers-types";
import type { Env } from "./env.ts";

/** One structured line per event. IDs and codes only: never owner text, prompts, tokens or keys. */
const log = (entry: Record<string, unknown>): void => console.log(JSON.stringify(entry));

const isJob = (body: unknown): body is GenerationJob =>
  typeof body === "object" && body !== null && (body as { v?: unknown }).v === 1 && typeof (body as { generationId?: unknown }).generationId === "string" && isId((body as { generationId: string }).generationId);

export default {
  /** asksite-generation consumer, one message per batch (§4.7). */
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      if (!isJob(message.body)) {
        log({ event: "generation.bad_message", messageId: message.id });
        message.ack();
        continue;
      }
      const { generationId } = message.body;
      try {
        log({ event: "generation.job", ...(await runGenerationJob(env, generationId)) });
        message.ack();
      } catch {
        // Only a failure before the claim lands here (the job never throws after it): let the
        // queue retry; after max_retries the message dead-letters and the sweeper ends the row.
        log({ event: "generation.claim_failed", generationId });
        message.retry();
      }
    }
  },

  /** Every 5 minutes: end jobs stuck longer than JOB_STUCK_AFTER_MS (§6.3). */
  async scheduled(_controller, env: Env): Promise<void> {
    log({ event: "generation.sweep", ...(await sweepStuckJobs(env, Date.now())) });
  },
} satisfies ExportedHandler<Env>;
