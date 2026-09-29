import type { Mailer } from "@asksite/app-common";
import type { GenerationRow, GenerationView } from "@asksite/core";

// The Plan 2 and Plan 3 functions the admin Worker calls, restated from the design (§6.4, §7.2,
// §7.6) so it can be built and tested with fakes first. src/worker/index.ts (integration task)
// passes the real packages and the type checker proves they fit. Members are properties with
// function types, not methods, so parameters are checked strictly (see apps/app/src/worker/deps.ts).
// Differences from the design text, all from the owning plans: `restore` also takes ROOT_DOMAIN and
// MEDIA and says how many of the page's photos are gone (Plan 2 decisions 3 and 29); publishing
// adds the codes `publish_cap_reached` and `site_not_found` (Plan 2 decisions 25 and 28); and
// `worstCaseJobMicrousd` returns null for a model with no recorded price (Plan 3 decision 11).

import type { PublishErrorCode } from "./publish-errors.ts";

export type { PublishErrorCode };

export interface PublishErrorLike extends Error {
  readonly code: PublishErrorCode;
  readonly detail?: unknown;
}

export interface AdminPublishingDeps {
  /** Only used with `instanceof`, so any constructor signature fits. */
  PublishError: abstract new (...args: never[]) => PublishErrorLike;
  approveVersion: (
    env: { DB: D1Database; WORK: R2Bucket; LIVE: R2Bucket; ROOT_DOMAIN: string },
    input: { versionId: string; htmlSha256: string; reviewer: string; note: string | null; indexable: boolean; now: number },
  ) => Promise<{ siteId: string; slug: string; liveUrl: string }>;
  rejectVersion: (env: { DB: D1Database }, input: { versionId: string; reviewer: string; note: string; now: number }) => Promise<{ siteId: string }>;
  takeDown: (
    env: { DB: D1Database; LIVE: R2Bucket; MEDIA: R2Bucket },
    input: { siteId: string; reviewer: string; reason: string; purgeMedia: boolean; now: number },
  ) => Promise<void>;
  restore: (
    env: { DB: D1Database; LIVE: R2Bucket; WORK: R2Bucket; MEDIA: R2Bucket; ROOT_DOMAIN: string },
    input: { siteId: string; reviewer: string; now: number },
  ) => Promise<{ liveUrl: string; missingPhotos: number }>;
  setIndexable: (env: { DB: D1Database }, input: { siteId: string; reviewer: string; indexable: boolean; now: number }) => Promise<void>;
}

export interface AdminGenerationDeps {
  dailyModelLimit: (env: { DB: D1Database; DAILY_MODEL_LIMIT: string }) => Promise<number>;
  worstCaseJobMicrousd: (provider: string, modelId: string) => number | null;
  toGenerationView: (row: GenerationRow) => GenerationView;
}

export interface MailerEnv {
  MAILER: "resend" | "log";
  MAIL_FROM: string;
  RESEND_API_KEY?: string;
  DB: D1Database;
  ENVIRONMENT: string;
}

export interface AdminDeps {
  publishing: AdminPublishingDeps;
  generation: AdminGenerationDeps;
  createMailer: (env: MailerEnv) => Mailer;
}
