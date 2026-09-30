import type { Mailer } from "@asksite/app-common";
import {
  designForTrade,
  formActionUrl,
  newId,
  sha256Hex,
  canonicalJson,
  versionKey,
  type AiDraft,
  type FallbackReason,
  type GenerationErrorCode,
  type GenerationRow,
  type GenerationView,
  type VersionSummary,
  LIMITS,
  liveKey,
  siteUrl,
} from "@asksite/core";
import { render } from "@asksite/renderer";
import { DESIGN_CSS } from "@asksite/site-css";
import { factSections, SECTION_VARIANTS, type Facts, type LayoutSection, type SectionId } from "@asksite/site-schema";
import type { AppDeps, GenerationDeps, MailerEnv, PublishErrorCode, PublishingDeps, RequestGenerationResult } from "../../src/worker/deps.ts";
import { FAKE_PUBLISH_CAP } from "./limits.ts";
import { LIVE_TOKEN_NO_HOSTNAME, TURNSTILE_DUMMY_TOKEN, TURNSTILE_TEST_ACTION, TURNSTILE_TEST_HOSTNAME, TURNSTILE_TEST_SECRET, type SiteverifyCall } from "./turnstile.ts";

// Test stand-ins for Plan 2 (@asksite/publishing, @asksite/mailer) and Plan 3 (@asksite/generation).
// Each follows the design's contract (§6.4, §7.2, §7.6) closely enough for this Worker's tests;
// none of them is ever deployed. The integration task swaps in the real packages.

const TRADE_WORD: Record<Facts["trade"], string> = {
  plumbing: "Plumbing",
  hvac: "Heating and cooling",
  electrical: "Electrical work",
  roofing: "Roofing",
  cleaning: "Cleaning",
  landscaping: "Landscaping",
};

/**
 * A draft that passes SiteDocument for any valid facts: no claims, no numbers, every fact section listed. Like
 * every stored draft, it starts on its trade's design (A12, user decision 2026-09-26).
 */
export function fakeAiDraft(facts: Facts): AiDraft {
  const sections: SectionId[] = ["hero", ...factSections(facts).filter((id) => id !== "contact"), "about", "faq", "contact"];
  const layout = sections.map((id) => ({ id, variant: SECTION_VARIANTS[id][0] }) as LayoutSection);
  return {
    copy: {
      heroHeadline: `${TRADE_WORD[facts.trade]} done right`,
      heroSubheadline: "Careful, tidy work from a local team you can reach.",
      ctaText: "Request a quote",
      about: "We are a local business that cares about doing the job properly and treating your home with respect.",
      sectionIntros: { services: "Here is what we can help you with.", contact: "Tell us what you need and we will get back to you." },
      serviceDescriptions: facts.services.map((s) => ({ service: s.name, description: "Done carefully by our team." })),
      faq: [{ question: "Do you clean up after the job?", answer: "Yes. We leave your home as tidy as we found it." }],
    },
    layout,
    theme: { palette: "navy-orange", font: "clean", design: designForTrade(facts.trade) },
  };
}

const utcDayStart = (now: number): number => Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());

export function toGenerationView(row: GenerationRow): GenerationView {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    errorCode: row.error_code as GenerationErrorCode | null,
    usedFallback: row.used_fallback === 1,
    fallbackReason: row.fallback_reason as FallbackReason | null,
  };
}

type GenerationRefusal = Exclude<RequestGenerationResult, { ok: true }>["code"];

/** When set, the next requestGeneration answers this refusal instead of doing its work, so a route test can see each code's answer. */
let nextGenerationRefusal: GenerationRefusal | undefined;

export function refuseNextGeneration(code: GenerationRefusal): void {
  nextGenerationRefusal = code;
}

export const fakeGeneration: GenerationDeps = {
  async requestGeneration(env, input) {
    if (nextGenerationRefusal !== undefined) {
      const code = nextGenerationRefusal;
      nextGenerationRefusal = undefined;
      return { ok: false, code };
    }
    const db = env.DB;
    const done = await db.prepare("SELECT 1 FROM generations WHERE site_id = ? AND status = 'succeeded' LIMIT 1").bind(input.siteId).first();
    const kind = done === null ? "first" : "regenerate";
    if (kind === "regenerate" && env.GENERATION_ENABLED !== "true") return { ok: false, code: "generation_disabled" };
    const id = newId();
    try {
      // Only regenerations count toward, and meet, the owner's lifetime cap (decision 40).
      const inserted = await db
        .prepare(
          `INSERT INTO generations (id, site_id, owner_id, kind, status, input_json, created_at)
           SELECT ?1, ?2, ?3, ?4, 'queued', ?5, ?6
           WHERE (SELECT COUNT(*) FROM generations WHERE site_id = ?2 AND created_at >= ?7) < ?8
             AND (?4 = 'first' OR (SELECT COUNT(*) FROM generations WHERE owner_id = ?3 AND kind = 'regenerate') < ?9)`,
        )
        .bind(id, input.siteId, input.ownerId, kind, JSON.stringify(input.snapshot), input.now, utcDayStart(input.now), LIMITS.generationsPerSitePerDay, LIMITS.generationsPerOwnerTotal)
        .run();
      if (inserted.meta.changes !== 1) return { ok: false, code: "generation_cap_reached" };
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) return { ok: false, code: "generation_in_progress" };
      throw err;
    }
    await env.GEN_QUEUE.send({ v: 1, generationId: id });
    const row = await db.prepare("SELECT * FROM generations WHERE id = ?").bind(id).first<GenerationRow>();
    if (row === null) return { ok: false, code: "internal" };
    return { ok: true, generation: toGenerationView(row) };
  },
  async generationAllowance(env, input) {
    const counts = await env.DB.prepare(
      "SELECT COUNT(*) FILTER (WHERE site_id = ?1 AND created_at >= ?3) AS today, COUNT(*) FILTER (WHERE kind = 'regenerate') AS total FROM generations WHERE owner_id = ?2",
    )
      .bind(input.siteId, input.ownerId, utcDayStart(input.now))
      .first<{ today: number; total: number }>();
    return {
      generationsLeftToday: Math.max(0, LIMITS.generationsPerSitePerDay - (counts?.today ?? 0)),
      generationsLeftTotal: Math.max(0, LIMITS.generationsPerOwnerTotal - (counts?.total ?? 0)),
    };
  },
  toGenerationView,
};

/** What the real generator does at the end of a job (§6.3 step 4), driven by tests. */
export async function finishGeneration(
  db: D1Database,
  generationId: string,
  outcome: { status: "succeeded"; usedFallback?: boolean } | { status: "failed"; errorCode: GenerationErrorCode },
  now: number,
): Promise<boolean> {
  const row = await db.prepare("SELECT * FROM generations WHERE id = ? AND status IN ('queued', 'running')").bind(generationId).first<GenerationRow>();
  if (row === null) return false;
  if (outcome.status === "failed") {
    await db.prepare("UPDATE generations SET status = 'failed', error_code = ?, finished_at = ? WHERE id = ?").bind(outcome.errorCode, now, generationId).run();
    return true;
  }
  const { facts } = JSON.parse(row.input_json) as { facts: Facts };
  await db
    .prepare("UPDATE generations SET status = 'succeeded', output_json = ?, used_fallback = ?, fallback_reason = ?, finished_at = ? WHERE id = ?")
    .bind(JSON.stringify(fakeAiDraft(facts)), outcome.usedFallback ? 1 : 0, outcome.usedFallback ? "disabled" : null, now, generationId)
    .run();
  return true;
}

export class FakePublishError extends Error {
  readonly code: PublishErrorCode;
  readonly detail: unknown;

  constructor(code: PublishErrorCode, detail?: unknown) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

const audit = (db: D1Database, at: number, actor: string, action: string, siteId: string, detail: Record<string, unknown> = {}) =>
  db.prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) VALUES (?, ?, ?, ?, ?)").bind(at, actor, action, siteId, JSON.stringify(detail));

export const fakePublishing: PublishingDeps = {
  PublishError: FakePublishError,
  async createPendingVersion(env, input) {
    const dayStart = input.now - (input.now % 86_400_000);
    const today = await env.DB.prepare("SELECT COUNT(*) AS n FROM site_versions WHERE site_id = ? AND requested_at >= ?").bind(input.siteId, dayStart).first<{ n: number }>();
    if ((today?.n ?? 0) >= FAKE_PUBLISH_CAP) throw new FakePublishError("publish_cap_reached", { retryAfter: Math.ceil((dayStart + 86_400_000 - input.now) / 1000) });
    const page = render(input.document, { stylesheets: DESIGN_CSS, formAction: formActionUrl(env.ROOT_DOMAIN, input.slug, input.siteId) });
    const id = newId();
    const htmlSha256 = await sha256Hex(page.html);
    await env.WORK.put(versionKey(input.siteId, id), page.html, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
      customMetadata: { siteId: input.siteId, versionId: id, sha256: htmlSha256 },
    });
    const documentJson = canonicalJson(input.document);
    const last = await env.DB.prepare("SELECT MAX(number) AS n FROM site_versions WHERE site_id = ?").bind(input.siteId).first<{ n: number | null }>();
    const number = (last?.n ?? 0) + 1;
    await env.DB.batch([
      env.DB.prepare("UPDATE site_versions SET status = 'superseded' WHERE site_id = ? AND status = 'pending'").bind(input.siteId),
      env.DB.prepare(
        `INSERT INTO site_versions (id, site_id, number, status, document_json, document_sha256, edits_json, generation_id,
           html_key, html_sha256, stylesheet_sha256, requested_by, requested_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, input.siteId, number, documentJson, await sha256Hex(documentJson), JSON.stringify(input.edits), input.generationId,
        versionKey(input.siteId, id), htmlSha256, page.stylesheetSha256, input.ownerId, input.now),
      env.DB.prepare("UPDATE sites SET pending_version_id = ?, updated_at = ? WHERE id = ?").bind(id, input.now, input.siteId),
      audit(env.DB, input.now, `owner:${input.ownerId}`, "version.requested", input.siteId, { versionId: id }),
    ]);
    const summary: VersionSummary = { id, number, status: "pending", requestedAt: input.now, reviewedAt: null, reviewNote: null };
    return summary;
  },
  async withdrawPending(env, input) {
    const site = await env.DB.prepare("SELECT pending_version_id FROM sites WHERE id = ? AND owner_id = ?")
      .bind(input.siteId, input.ownerId)
      .first<{ pending_version_id: string | null }>();
    if (site === null || site.pending_version_id === null) throw new FakePublishError("nothing_pending");
    await env.DB.batch([
      env.DB.prepare("UPDATE site_versions SET status = 'withdrawn' WHERE id = ? AND status = 'pending'").bind(site.pending_version_id),
      env.DB.prepare("UPDATE sites SET pending_version_id = NULL, updated_at = ? WHERE id = ?").bind(input.now, input.siteId),
      audit(env.DB, input.now, `owner:${input.ownerId}`, "version.withdrawn", input.siteId, { versionId: site.pending_version_id }),
    ]);
  },
};

/** Approve without checks (tests only): make a pending version live, as §7.2 approveVersion would. */
export async function fakeApprove(env: { DB: D1Database; WORK: R2Bucket; ROOT_DOMAIN: string }, versionId: string, now: number) {
  const version = await env.DB.prepare("SELECT v.site_id, s.slug FROM site_versions v JOIN sites s ON s.id = v.site_id WHERE v.id = ?")
    .bind(versionId)
    .first<{ site_id: string; slug: string }>();
  if (version === null) throw new FakePublishError("version_not_pending");
  await env.DB.batch([
    env.DB.prepare("UPDATE sites SET live_version_id = ?, pending_version_id = NULL, updated_at = ? WHERE id = ?").bind(versionId, now, version.site_id),
    env.DB.prepare("UPDATE site_versions SET status = 'approved', reviewed_by = 'admin@example.com', reviewed_at = ? WHERE id = ?").bind(now, versionId),
  ]);
  return { siteId: version.site_id, liveKey: liveKey(version.slug), liveUrl: siteUrl(env.ROOT_DOMAIN, version.slug) };
}

/** Writes to dev_outbox like Plan 2's log mailer. Addresses at mail-fails.example fail like a rejected send. */
export function fakeCreateMailer(env: MailerEnv): Mailer {
  return {
    async send(email) {
      if (email.to.endsWith("@mail-fails.example")) {
        throw Object.assign(new Error("rejected"), { name: "MailerError", code: "rejected" });
      }
      await env.DB.prepare("INSERT INTO dev_outbox (at, to_addr, subject, text, tag) VALUES (?, ?, ?, ?, ?)")
        .bind(Date.now(), email.to, email.subject, email.text, email.tag)
        .run();
      return { id: newId() };
    },
  };
}

/** Where the receiver check sends its request: a name that never resolves, for a request aborted before it starts anyway. */
const RECEIVER_CHECK_URL = "https://fetch-receiver-check.invalid/";

/**
 * Calls the real global fetch with `receiver` as its `this`, for a request aborted before it starts, so
 * nothing leaves the runtime. Resolves with what the call threw: an AbortError when fetch accepted its
 * `this`, and workerd's TypeError "Illegal invocation" when it did not.
 */
export async function fetchCalledOn(receiver: unknown): Promise<unknown> {
  try {
    await Reflect.apply(fetch, receiver, [RECEIVER_CHECK_URL, { signal: AbortSignal.abort() }]);
    return null;
  } catch (err) {
    return err;
  }
}

/** The name of a thrown value ("AbortError", "TypeError", ...), or "" when it has none. */
export const errorName = (value: unknown): string => (typeof value === "object" && value !== null && typeof (value as { name?: unknown }).name === "string" ? (value as { name: string }).name : "");

/**
 * `port`, callable only the way workerd's global fetch is: as a plain function, never as a method of
 * another object ("Illegal invocation", developers.cloudflare.com/workers/observability/errors/). It
 * first calls the real fetch with the `this` it was called with, and throws what that throws.
 */
export function calledLikeFetch(port: AppDeps["siteverify"]): AppDeps["siteverify"] {
  return async function (this: unknown, url, init) {
    const outcome = await fetchCalledOn(this);
    if (errorName(outcome) !== "AbortError") throw outcome;
    return port(url, init);
  };
}

const siteverifyCalls: SiteverifyCall[] = [];

export const siteverifyCallsSoFar = (): readonly SiteverifyCall[] => siteverifyCalls;

/** What siteverify answers for a documented test secret and the dummy token (developers.cloudflare.com/turnstile/troubleshooting/testing/). */
const TEST_KEY_PASSED = {
  success: true,
  challenge_ts: "2026-09-26T00:00:00.000Z",
  hostname: TURNSTILE_TEST_HOSTNAME,
  "error-codes": [],
  action: TURNSTILE_TEST_ACTION,
  cdata: "test-data",
};

/** What siteverify answers for a token it refuses. */
const TOKEN_REFUSED = { "error-codes": ["invalid-input-response"], success: false, messages: [] };

/** With a non-test secret, "live:<host>|<action>" stands in for a production key's pass for a widget solved on <host>. */
const LIVE_KEY_PREFIX = "live:";
/** A production key's pass whose answer carries no host name. */
const LIVE_NO_HOSTNAME = LIVE_TOKEN_NO_HOSTNAME;

const answer = (body: Record<string, unknown>, status = 200): Response => Response.json(body, { status });

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * Turnstile's siteverify without the network. Cloudflare's dummy token gets exactly the real service's
 * documented answer for a test secret: success, host name "localhost" and action "test".
 * Other tokens act out what the tests need: "live:<host>|<action>" (with a non-test secret: a production key's pass
 * for a widget solved on <host>), "slow-once" (hangs until the caller gives up, then passes on the retry with the same
 * idempotency key), "busy-once" (internal-error, then passes on the retry), "down" (a network error,
 * then a 503); anything else is an invalid token. Any other address is a 404.
 */
export const fakeSiteverify: AppDeps["siteverify"] = async (url, init) => {
  if (url !== "https://challenges.cloudflare.com/turnstile/v0/siteverify") return answer({}, 404);
  const body = JSON.parse(init.body) as Record<string, unknown>;
  const call: SiteverifyCall = {
    response: text(body["response"]),
    remoteip: text(body["remoteip"]),
    idempotencyKey: text(body["idempotency_key"]),
    testSecret: body["secret"] === TURNSTILE_TEST_SECRET,
  };
  const retry = siteverifyCalls.some((earlier) => earlier.idempotencyKey !== null && earlier.idempotencyKey === call.idempotencyKey);
  siteverifyCalls.push(call);
  if (!call.testSecret) return answer(liveAnswer(call.response));
  switch (call.response) {
    case TURNSTILE_DUMMY_TOKEN:
      return answer(TEST_KEY_PASSED);
    case "slow-once":
      if (!retry) await new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
      return answer(TEST_KEY_PASSED);
    case "busy-once":
      return answer(retry ? TEST_KEY_PASSED : { success: false, "error-codes": ["internal-error"] });
    case "down":
      if (!retry) throw new TypeError("Network connection lost.");
      return answer({}, 503);
    default:
      return answer(TOKEN_REFUSED);
  }
};

/** A production-style secret: it passes only a "live:<host>|<action>" token and refuses the dummy token, as the docs say. */
function liveAnswer(token: string | null): Record<string, unknown> {
  const solved = { challenge_ts: TEST_KEY_PASSED.challenge_ts, "error-codes": [], success: true };
  if (token === LIVE_NO_HOSTNAME) return { ...solved, action: "login" };
  if (token?.startsWith(LIVE_KEY_PREFIX)) {
    const [hostname, action = "login"] = token.slice(LIVE_KEY_PREFIX.length).split("|");
    return { ...solved, hostname, action };
  }
  return TOKEN_REFUSED;
}
