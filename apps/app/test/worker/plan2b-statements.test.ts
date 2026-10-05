import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACQUIRE_LEASE_SQL,
  LEASE_HELD_SQL,
  PURGE_UPLOADS_SQL,
  RELEASE_LEASE_SQL,
  RESTORE_SITE_SQL,
  TAKE_DOWN_SITE_SQL,
  TAKE_DOWN_VERSIONS_SQL,
} from "../support/plan2b-statements.ts";

// The test seams copy Plan 2B statements (apps/app has no LIVE binding and no @asksite/publishing runtime).
// This pins each copy to its file in packages/publishing/src byte for byte, as the exact string literal
// inside .prepare("...") or, for the lease-fenced ones, .prepare(`...${LEASE_HELD}`), so a change on main
// fails here instead of leaving the seams behind.
const source = (file: string) => readFileSync(new URL(`../../../../packages/publishing/src/${file}`, import.meta.url), "utf8");
const siteState = source("site-state.ts");
const shared = source("shared.ts");

describe("the copied Plan 2B statements", () => {
  it("LEASE_HELD equals shared.ts byte for byte", () => {
    expect(shared).toContain(`export const LEASE_HELD = "${LEASE_HELD_SQL}";`);
  });

  it.each([
    ["acquireLease statement", shared, ACQUIRE_LEASE_SQL],
    ["releaseLease statement", shared, RELEASE_LEASE_SQL],
    ["takeDown site statement", siteState, TAKE_DOWN_SITE_SQL],
    ["restore clearing statement", siteState, RESTORE_SITE_SQL],
  ])("%s equals its file byte for byte", (_name, file, sql) => {
    expect(file).toContain(`.prepare("${sql}")`);
  });

  it.each([
    ["takeDown versions statement", TAKE_DOWN_VERSIONS_SQL],
    ["takeDown purge statement", PURGE_UPLOADS_SQL],
  ])("%s equals site-state.ts byte for byte (LEASE_HELD embedded)", (_name, sql) => {
    expect(sql).toContain(LEASE_HELD_SQL);
    expect(siteState).toContain(`.prepare(\`${sql.replace(LEASE_HELD_SQL, "${LEASE_HELD}")}\`)`);
  });
});
