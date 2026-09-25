import type { Facts } from "@asksite/site-schema";
import type { Brief } from "./brief.ts";

// Types shared with Plan 3 (generation).
export const GENERATION_ERROR_CODES = ["generation_disabled", "budget_exhausted",
  "provider_unavailable", "provider_timeout", "invalid_output", "internal"] as const;
export type GenerationErrorCode = (typeof GENERATION_ERROR_CODES)[number];
export const FALLBACK_REASONS = ["disabled", "budget", "provider_error", "invalid_output"] as const; // "budget" = today's model limit reached
export type FallbackReason = (typeof FALLBACK_REASONS)[number];
export interface GenerationJob { v: 1; generationId: string } // everything else is read from the row
export interface GenerationInputSnapshot { facts: Facts; brief: Brief } // stored in generations.input_json
