// Words the admin Worker answers and the admin screens recognise (A16-4c). The API's error body carries a code and a message only,
// and live_copy_failed and lease_lost share the codes "internal" and "conflict" with other failures, so a screen that offers
// "Copy the live pages again" next to one of these notices compares the message with the same constant the Worker sent.

/** Approve answered, but the pointer write after the approval failed: Approve again, or Copy the live pages again. */
export const APPROVE_LIVE_COPY_FAILED = "Approved, but the new pages are not live yet. Press Approve again.";
/** Restore's pointer write failed: the site stays taken down. */
export const RESTORE_LIVE_COPY_FAILED = "The site is still offline: its pages could not be put back. Press Restore again.";
/** Copy the live pages again failed at its pointer write. */
export const COPY_LIVE_COPY_FAILED = "The pages could not be copied again. Press Copy the live pages again.";
/** An action ran past its lease and was fenced out (site_busy, reason lease_lost): no Retry-After, reload and look. */
export const LEASE_LOST = "This action ran too long and was stopped before it finished. Reload to see where the site stands now, then try again.";
/** Another admin action holds the site (site_busy with retryAfter). */
export const SITE_BUSY = "Another admin action on this site is still running. Try again in a minute.";
/** Restore found a different takedown than the one the page showed (site_taken_down, reason taken_down_again). */
export const TAKEN_DOWN_AGAIN = "This site was taken down again since you opened this page. Reload to see where it stands now.";
/** Copy the live pages again succeeded. */
export const COPIED_AGAIN = "The live pages were copied again.";
