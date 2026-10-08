import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@asksite/core";

/** The hint under every new-password field. */
export const NEW_PASSWORD_HINT = `At least ${PASSWORD_MIN_LENGTH} characters.`;

/** What is wrong with a new password, or null. Counted in code points, as the Worker's Zod schema counts (packages/core/src/api.ts). */
export function passwordProblem(password: string): string | null {
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH) return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (length > PASSWORD_MAX_LENGTH) return `Use ${PASSWORD_MAX_LENGTH} characters or fewer.`;
  return null;
}
