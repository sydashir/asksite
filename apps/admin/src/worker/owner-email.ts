import { logLine, type EmailContent } from "@asksite/app-common";

/** Why the owner's review email was skipped, as its log line says. */
export type OwnerEmailSkipReason = "invalid_live_url" | "email_build_failed";

/**
 * The owner's review email, built after approve or reject has changed the site. Building it can throw
 * (reviewApprovedEmail refuses a live address that is not a safe https URL), but the change is done by then, so
 * the route still answers as usual and only the email is skipped, as when a send fails. One line says why, with
 * ids and a reason code only, never the error's message (moderator ruling P4-23 item 4, option (a), 2026-09-30).
 */
export function ownerEmailOrSkip(
  build: () => EmailContent,
  skip: { reason: OwnerEmailSkipReason; versionId: string; siteId: string },
): EmailContent | null {
  try {
    return build();
  } catch {
    logLine({ event: "owner_email_skipped", reason: skip.reason, versionId: skip.versionId, siteId: skip.siteId });
    return null;
  }
}
