import { describe, expect, it } from "vitest";
import { businessOf, formBusiness } from "../src/business.ts";
import { liveSiteName } from "../src/page.ts";

// What the fixed pages read from the LIVE object's metadata (A15; QA-2 RU(2), RU(3), RU(4)). The Worker
// tests cover the real bindings; these fakes cover what the local harness cannot do: an R2 or D1 read that
// throws, and proof that a host with no name never asks D1.

const SITE_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const METADATA = { siteId: SITE_ID, versionId: "v", businessName: "Reliable Rooter Plumbing", phoneText: "(512) 555-0142", phoneTel: "+15125550142" };

/** An R2 bucket whose head() answers `object` (or throws it), counting the calls. */
function liveBucket(object: { customMetadata?: Record<string, string> } | null | Error) {
  const calls: string[] = [];
  const live = {
    head: async (key: string) => {
      calls.push(key);
      if (object instanceof Error) throw object;
      return object;
    },
  } as unknown as R2Bucket;
  return { live, calls };
}

/** A D1 whose first() answers `row` (or throws it), counting the queries. */
function database(row: object | null | Error) {
  const queries: string[] = [];
  const db = {
    prepare: (sql: string) => ({
      bind: () => ({
        first: async () => {
          queries.push(sql);
          if (row instanceof Error) throw row;
          return row;
        },
      }),
    }),
  } as unknown as D1Database;
  return { db, queries };
}

describe("businessOf", () => {
  it("reads the name and the phone", () => {
    expect(businessOf(METADATA)).toEqual({ name: "Reliable Rooter Plumbing", phone: { text: "(512) 555-0142", tel: "+15125550142" } });
  });

  it("has no name when it is missing or empty, and no phone without its text and an E.164 number", () => {
    expect(businessOf(undefined)).toEqual({ name: null, phone: null });
    expect(businessOf({ businessName: "", phoneText: "(512) 555-0142", phoneTel: "5125550142" })).toEqual({ name: null, phone: null });
    expect(businessOf({ businessName: "Mop" })).toEqual({ name: "Mop", phone: null });
  });
});

describe("formBusiness (the thank-you and rate-limit pages)", () => {
  it("reads the LIVE object of the host when it belongs to the form's site", async () => {
    const { live, calls } = liveBucket({ customMetadata: METADATA });
    expect(await formBusiness(live, "joes", SITE_ID)).toEqual(businessOf(METADATA));
    expect(calls).toEqual(["joes.html"]);
  });

  it.each([
    ["no LIVE object", null],
    ["another site's object", { customMetadata: { ...METADATA, siteId: "0b0f5c5e-2d3b-4c1a-9f6e-1a2b3c4d5e6f" } }],
    ["an R2 failure", new Error("R2 is unavailable")],
  ])("knows nothing about the business with %s", async (_, object) => {
    expect(await formBusiness(liveBucket(object).live, "joes", SITE_ID)).toEqual({ name: null, phone: null });
  });
});

describe("liveSiteName (the 404 page)", () => {
  it("names the business when the host's LIVE object has a name and D1 calls the site live", async () => {
    const { db, queries } = database({ indexable: 1, live_version_id: "v" });
    expect(await liveSiteName({ LIVE: liveBucket({ customMetadata: METADATA }).live, DB: db }, "joes")).toBe("Reliable Rooter Plumbing");
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("taken_down_at IS NULL");
  });

  it.each([
    ["no LIVE object (an unknown or never-approved host)", null],
    ["an object stored before the name was", { customMetadata: { ...METADATA, businessName: "" } }],
    ["an R2 failure", new Error("R2 is unavailable")],
  ])("gives no name and never asks D1 with %s", async (_, object) => {
    const { db, queries } = database({ indexable: 1, live_version_id: "v" });
    expect(await liveSiteName({ LIVE: liveBucket(object).live, DB: db }, "joes")).toBeNull();
    expect(queries).toEqual([]);
  });

  it.each([
    ["D1 does not call the site live (taken down or not approved)", null],
    ["D1 fails", new Error("D1 is unavailable")],
  ])("gives no name when %s", async (_, row) => {
    expect(await liveSiteName({ LIVE: liveBucket({ customMetadata: METADATA }).live, DB: database(row).db }, "joes")).toBeNull();
  });
});
