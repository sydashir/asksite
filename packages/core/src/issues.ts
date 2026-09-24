import type { z } from "zod";

export interface Issue {
  path: Array<string | number>;
  code: string;
  message: string;
}

/** Flattens a ZodError into plain issues; symbol path keys become String(key). */
export function toIssues(error: z.ZodError): Issue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((key) => (typeof key === "symbol" ? String(key) : key)),
    code: issue.code,
    message: issue.message,
  }));
}
