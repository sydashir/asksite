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
 * The customMetadata of the LIVE object on the host `slug`, from one R2 head; undefined when there is no
 * object or R2 fails. It only adds words to pages that are right without them, so a failure never turns
 * such a page into an error.
 */
async function liveMetadataOf(live: Pick<R2Bucket, "head">, slug: string): Promise<Record<string, string> | undefined> {
  try {
    return (await live.head(liveKey(slug)))?.customMetadata;
  } catch {
    return undefined;
  }
}

/** The business behind the form `siteId` on the host `slug`, for the thank-you and rate-limit pages; nothing for another site's object. */
export async function formBusiness(live: Pick<R2Bucket, "head">, slug: string, siteId: string): Promise<Business> {
  const metadata = await liveMetadataOf(live, slug);
  return metadata?.["siteId"] === siteId ? businessOf(metadata) : NO_BUSINESS;
}

/**
 * The name for the 404 page on the host `slug` (QA-2 RU(3)), so a wrong path links to the site's page; null
 * keeps the plain 404. Live slugs are public and a script can send any number of wrong paths, so this reads
 * the LIVE object alone and never D1, the one single-threaded database every Worker shares (Decision 24;
 * review I-1). A takedown deletes the object; until a failed delete is retried the link stays, and its "/"
 * answers the plain 404 (D1 decides the page).
 */
export async function liveSiteName(live: Pick<R2Bucket, "head">, slug: string): Promise<string | null> {
  return businessOf(await liveMetadataOf(live, slug)).name;
}
