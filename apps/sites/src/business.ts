import { liveKey } from "@asksite/core";
import type { BusinessPhone } from "./pages.ts";

// What the LIVE object's customMetadata says about the business: approveVersion and restore store its name
// and phone as the approved page shows them (A15; QA-2 RU(2)), so a fixed page can name the business and
// print its number with no extra read beyond the LIVE.head. The pages escape both. An object stored before
// a value was added lacks it; each page then keeps its words without it.

export interface Business {
  name: string | null;
  phone: BusinessPhone | null;
}

const NO_BUSINESS: Business = { name: null, phone: null };

/** A global number as a tel: link carries it (E.164: "+", then at most 15 digits, the first not 0). */
const E164 = /^\+[1-9]\d{1,14}$/;

/** The name when it is not empty, and the phone only with its text and an E.164 number. */
export function businessOf(metadata: Record<string, string> | undefined): Business {
  const name = metadata?.["businessName"] ?? "";
  const text = metadata?.["phoneText"] ?? "";
  const tel = metadata?.["phoneTel"] ?? "";
  return { name: name === "" ? null : name, phone: text !== "" && E164.test(tel) ? { text, tel } : null };
}

/**
 * The business behind the form `siteId` on the host `slug`: nothing when the host has no LIVE object, the
 * object is another site's, or R2 fails. It only adds words to a page that is right without them (the
 * thank-you and rate-limit pages), so a failure never turns that page into an error.
 */
export async function formBusiness(live: Pick<R2Bucket, "head">, slug: string, siteId: string): Promise<Business> {
  try {
    const object = await live.head(liveKey(slug));
    return object !== null && object.customMetadata?.["siteId"] === siteId ? businessOf(object.customMetadata) : NO_BUSINESS;
  } catch {
    return NO_BUSINESS;
  }
}
