import type { Mailer } from "@asksite/app-common";
import type {
  GenerationInputSnapshot,
  GenerationJob,
  GenerationRow,
  GenerationView,
  OwnerEdits,
  VersionSummary,
} from "@asksite/core";
import type { SiteDocument } from "@asksite/site-schema";

// The Plan 2 and Plan 3 functions this Worker calls, restated from the design (§6.4, §7.2, §7.6)
// so the Worker can be built and tested with fakes before those packages land. src/worker/index.ts
// (integration task) passes the real packages and the type checker proves they fit. Members are
// properties with function types, not methods: TypeScript compares method parameters bivariantly,
// so with method syntax a real function that needs more than the port promises would still pass.

/** Plan 2's codes: design §7.2 plus `publish_cap_reached` (its decision 25), `site_not_found` (decision 28) and `live_copy_failed` (A16; only Approve throws it). */
export type PublishErrorCode =
  | "render_failed"
  | "nothing_pending"
  | "version_not_pending"
  | "site_taken_down"
  | "integrity"
  | "not_live"
  | "publish_cap_reached"
  | "site_not_found"
  | "live_copy_failed";

export interface PublishErrorLike extends Error {
  readonly code: PublishErrorCode;
  readonly detail?: unknown;
}

export type RequestGenerationResult =
  | { ok: true; generation: GenerationView }
  | { ok: false; code: "generation_in_progress" | "generation_cap_reached" | "generation_disabled" | "budget_exhausted" | "internal" };

export interface GenerationDeps {
  requestGeneration: (
    env: { DB: D1Database; GEN_QUEUE: Queue<GenerationJob>; GENERATION_ENABLED: string; DAILY_MODEL_LIMIT: string },
    input: { siteId: string; ownerId: string; snapshot: GenerationInputSnapshot; now: number },
  ) => Promise<RequestGenerationResult>;
  generationAllowance: (
    env: { DB: D1Database },
    input: { siteId: string; ownerId: string; now: number },
  ) => Promise<{ generationsLeftToday: number; generationsLeftTotal: number }>;
  toGenerationView: (row: GenerationRow) => GenerationView;
}

export interface PublishingDeps {
  /** Only used with `instanceof`, so any constructor signature fits. */
  PublishError: abstract new (...args: never[]) => PublishErrorLike;
  createPendingVersion: (
    env: { DB: D1Database; WORK: R2Bucket; ROOT_DOMAIN: string },
    input: { siteId: string; ownerId: string; slug: string; document: SiteDocument; edits: OwnerEdits; generationId: string | null; now: number },
  ) => Promise<VersionSummary>;
  withdrawPending: (env: { DB: D1Database }, input: { siteId: string; ownerId: string; now: number }) => Promise<void>;
}

export interface MailerEnv {
  MAILER: "resend" | "log";
  MAIL_FROM: string;
  RESEND_API_KEY?: string;
  DB: D1Database;
  ENVIRONMENT: string;
}

/**
 * A POST to Cloudflare Turnstile's siteverify (A11): the Workers fetch in production, a fake in tests.
 * The Worker calls it as a plain function, never as a method of this object, so the global fetch can be
 * passed as is (workerd refuses fetch called with another `this`: "Illegal invocation").
 */
export type Siteverify = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Response>;

export interface AppDeps {
  generation: GenerationDeps;
  publishing: PublishingDeps;
  createMailer: (env: MailerEnv) => Mailer;
  siteverify: Siteverify;
}
