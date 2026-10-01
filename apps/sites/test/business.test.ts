import { describe, expect, it } from "vitest";
import { businessOf, formBusiness, liveSiteName } from "../src/business.ts";

// What the fixed pages read from the LIVE pointer's metadata (A15; QA-2 RU(2), RU(3), RU(4)). The Worker
// tests cover the real bindings; these fakes cover what the local harness cannot do: an R2 read that throws.

const SITE_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const METADATA = { siteId: SITE_ID, versionId: "0b0c2d3e-4f50-4a6b-8c7d-8e9fa0b1c2d3", businessName: "Reliable Rooter Plumbing", phoneText: "(512) 555-0142", phoneTel: "+15125550142" };

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
  it("reads the LIVE pointer of the host when it belongs to the form's site", async () => {
    const { live, calls } = liveBucket({ customMetadata: METADATA });
    expect(await formBusiness(live, "joes", SITE_ID)).toEqual(businessOf(METADATA));
    expect(calls).toEqual(["joes"]);
  });

  it.each([
    ["no pointer", null],
    ["another site's pointer", { customMetadata: { ...METADATA, siteId: "0b0f5c5e-2d3b-4c1a-9f6e-1a2b3c4d5e6f" } }],
    ["an R2 failure", new Error("R2 is unavailable")],
  ])("knows nothing about the business with %s", async (_, object) => {
    expect(await formBusiness(liveBucket(object).live, "joes", SITE_ID)).toEqual({ name: null, phone: null });
  });
});

describe("liveSiteName (the 404 page)", () => {
  it("names the business from the host's pointer alone", async () => {
    const { live, calls } = liveBucket({ customMetadata: METADATA });
    expect(await liveSiteName(live, "joes")).toBe("Reliable Rooter Plumbing");
    expect(calls).toEqual(["joes"]);
  });

  it.each([
    ["no pointer (an unknown, never-approved or taken-down host)", null],
    ["a pointer written before the name was", { customMetadata: { ...METADATA, businessName: "" } }],
    ["a pointer with no metadata", {}],
    ["an R2 failure", new Error("R2 is unavailable")],
  ])("gives no name with %s", async (_, object) => {
    expect(await liveSiteName(liveBucket(object).live, "joes")).toBeNull();
  });
});
