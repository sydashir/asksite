/**
 * The review note a takedown gives the version in review it rejects (written by @asksite/publishing's takeDown).
 * The owner app tells this automatic rejection from a real review by it, so an owner is never told the reviewer
 * asked for a change. It lives here, not in @asksite/publishing, because the owner's browser code imports core but
 * never publishing (server code). Its bytes never change: stored rows hold them.
 */
export const TAKEDOWN_REVIEW_NOTE = "Site taken down";
