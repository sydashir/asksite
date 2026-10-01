import { FALLBACK_REASONS, GENERATION_ERROR_CODES, type FallbackReason, type GenerationErrorCode, type GenerationRow, type GenerationView } from "@asksite/core";

const STATUSES: readonly string[] = ["queued", "running", "succeeded", "failed"];
const isErrorCode = (code: string): code is GenerationErrorCode => (GENERATION_ERROR_CODES as readonly string[]).includes(code);
const isFallbackReason = (reason: string): reason is FallbackReason => (FALLBACK_REASONS as readonly string[]).includes(reason);

/**
 * The owner-facing view of a generation row (§4.2). Every enum column is checked, so an unknown
 * stored value can never reach the app: status shows as "failed", an error code as "internal".
 */
export function toGenerationView(row: GenerationRow): GenerationView {
  const status = STATUSES.includes(row.status) ? (row.status as GenerationView["status"]) : "failed";
  return {
    id: row.id,
    kind: row.kind === "regenerate" ? "regenerate" : "first",
    status,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    errorCode: row.error_code === null ? null : isErrorCode(row.error_code) ? row.error_code : "internal",
    usedFallback: row.used_fallback === 1,
    fallbackReason: row.fallback_reason !== null && isFallbackReason(row.fallback_reason) ? row.fallback_reason : null,
  };
}
