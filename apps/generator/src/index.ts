import { isId, type GenerationJob } from "@asksite/core";
import { runGenerationJob, sweepStuckJobs, trimGenerationInputs } from "@asksite/generation";
import type { ExportedHandler, MessageBatch } from "@cloudflare/workers-types";
import { TRIM_CRON } from "./crons.ts";
import type { Env } from "./env.ts";

/** One structured line per event. IDs and codes only: never owner text, prompts, tokens or keys. */
const log = (entry: Record<string, unknown>): void => console.log(JSON.stringify(entry));

const isJob = (body: unknown): body is GenerationJob =>
  typeof body === "object" && body !== null && (body as { v?: unknown }).v === 1 && typeof (body as { generationId?: unknown }).generationId === "string" && isId((body as { generationId: string }).generationId);

/** 15 s after the first failed delivery, 30 s after the second; never more than 60 s. */
const retryDelaySeconds = (attempts: number): number => Math.min(15 * 2 ** Math.max(0, attempts - 1), 60);

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
        const report = await runGenerationJob(env, generationId);
        log({ event: "generation.job", ...report });
        // One more line for each flag someone must follow up (P3-4a, Task 9 C); `model` is the one the job stored.
        if (report.usageMissing) log({ event: "usage_missing", generationId, provider: report.provider, model: report.model });
        // A provider error only a human can fix: a missing, wrong or revoked key, billing or the spend cap ("auth"), or a request the
        // provider or our configuration refuses ("bad_request": an unpriced or unknown model, a bad base URL). Not our input-size guard.
        if ((report.providerErrorKind === "auth" || report.providerErrorKind === "bad_request") && !report.inputBoundRefused)
          log({ event: "generation.needs_human", generationId, providerErrorKind: report.providerErrorKind, provider: report.provider });
        if (report.costUnknown) log({ event: "generation.internal", generationId, costUnknown: true });
        message.ack();
      } catch {
        // Only a failure before the claim lands here (the job never throws after it): let the
        // queue retry; after max_retries the message dead-letters and the sweeper ends the row.
        log({ event: "generation.claim_failed", generationId });
        // Backs off 15 s, then 30 s (Queues: msg.retry({ delaySeconds }) with the message's attempts, "Batching and retries"),
        // so a D1 outage that lasts a few seconds is not retried into at once; max_retries 2 and the dead-letter queue are unchanged.
        message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      }
    }
  },

  /**
   * Every 5 minutes: end jobs stuck longer than JOB_STUCK_AFTER_MS (§6.3). Once a day (TRIM_CRON): clear the inputs of
   * generations finished more than 30 days ago, at most TRIM_MAX_PER_RUN rows per run.
   */
  async scheduled(controller, env: Env): Promise<void> {
    if (controller.cron === TRIM_CRON) {
      try {
        log({ event: "generation.trim", ...(await trimGenerationInputs(env, Date.now())) });
      } catch (error) {
        // A fixed line (never the error's text), then the failure goes on so the runtime records the cron run as failed.
        log({ event: "generation.trim_failed" });
        throw error;
      }
      return;
    }
    try {
      log({ event: "generation.sweep", ...(await sweepStuckJobs(env, Date.now())) });
    } catch (error) {
      // A fixed line (never the error's text), then the failure goes on so the runtime records the cron run as failed.
      log({ event: "generation.sweep_failed" });
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;
