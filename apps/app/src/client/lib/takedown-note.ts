/**
 * The review note Plan 2's takeDown writes on every version that was waiting for review
 * (packages/publishing/src/site-state.ts:23). The owner's Publish screen must not present it as a
 * request for a change. test/worker/plan2b-statements.test.ts pins this literal to that file byte for
 * byte. After the A16 adapt, import the named constant from @asksite/publishing instead.
 */
export const TAKEDOWN_REVIEW_NOTE = "Site taken down";
