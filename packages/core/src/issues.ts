import type { z } from "zod";

export interface Issue {
  path: Array<string | number>;
  code: string;
  message: string;
}

/**
 * The most issues toIssues returns (A9). zod reports one issue per bad array element before any
 * length check, so a facts JSON near LIMITS.factsJsonMaxBytes gave 152,289 issues (an 18.6 MB
 * error body). The first 50 are kept, in zod's order.
 */
const MAX_ISSUES = 50;

/** Flattens a ZodError into plain issues, the first MAX_ISSUES only; symbol path keys become String(key). */
export function toIssues(error: z.ZodError): Issue[] {
  return error.issues.slice(0, MAX_ISSUES).map((issue) => ({
    path: issue.path.map((key) => (typeof key === "symbol" ? String(key) : key)),
    code: issue.code,
    message: issue.message,
  }));
}
