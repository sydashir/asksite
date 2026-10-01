/**
 * The review note Plan 2's takeDown writes on every version that was waiting for review (TAKEDOWN_REVIEW_NOTE,
 * exported by @asksite/publishing, packages/publishing/src/site-state.ts). The owner's Publish screen must not present it
 * as a request for a change. The client cannot import it: the package's entry pulls in Worker-only code (D1Database and
 * R2Bucket types fail tsconfig.client.json, and the server code would join the bundle). So this is a copy, and
 * test/worker/plan2b-statements.test.ts pins it to the real export.
 */
export const TAKEDOWN_REVIEW_NOTE = "Site taken down";
