import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TAKEDOWN_REVIEW_NOTE as CLIENT_NOTE } from "../../src/client/lib/takedown-note.ts";
import { PURGE_UPLOADS_SQL, RESTORE_SITE_SQL, TAKE_DOWN_SITE_SQL, TAKE_DOWN_VERSIONS_SQL } from "../support/plan2b-statements.ts";

// The test seams copy four Plan 2B statements (apps/app has no LIVE binding and no @asksite/publishing).
// This pins each copy to packages/publishing/src/site-state.ts byte for byte, as the exact string literal
// inside .prepare("..."), so a change on main fails here instead of leaving the seams behind.
// The package's entry types need the Worker runtime's (D1Database, R2Bucket), which this Node test program lacks, so the
// real constant is imported at run time through a name the type checker does not follow.
const PUBLISHING = "@asksite/publishing";
const { TAKEDOWN_REVIEW_NOTE } = (await import(/* @vite-ignore */ PUBLISHING)) as { TAKEDOWN_REVIEW_NOTE: string };
const siteState = readFileSync(new URL("../../../../packages/publishing/src/site-state.ts", import.meta.url), "utf8");

describe("the copied Plan 2B statements", () => {
  it.each([
    ["takeDown versions statement", TAKE_DOWN_VERSIONS_SQL],
    ["takeDown site statement", TAKE_DOWN_SITE_SQL],
    ["takeDown purge statement", PURGE_UPLOADS_SQL],
    ["restore site statement", RESTORE_SITE_SQL],
  ])("%s equals site-state.ts byte for byte", (_name, sql) => {
    expect(siteState).toContain(`.prepare("${sql}")`);
  });

  it("the client's takedown note equals the constant @asksite/publishing exports, which takeDown binds as the note", () => {
    expect(CLIENT_NOTE).toBe(TAKEDOWN_REVIEW_NOTE);
    expect(siteState).toContain(".bind(reviewer, now, TAKEDOWN_REVIEW_NOTE, siteId)");
  });
});
