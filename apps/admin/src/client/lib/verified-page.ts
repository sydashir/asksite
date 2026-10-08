// The review shows a stored page only if its bytes are the ones that were sent for review. No DOM types here (the unit
// test program compiles this file): crypto.subtle and TextDecoder exist in the browser and in Node.

/** Lower-case hex SHA-256 of raw bytes, as VersionPages pins a page's sha256 (@asksite/core pages.ts). */
export async function sha256OfBytes(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The page's html, only if its RAW bytes hash to `sha256` (the page's own listed hash, never another page's). The hash is
 * taken BEFORE decoding: `text()` would drop a leading byte-order mark and replace invalid bytes, so hashing it could pass bytes
 * that the server's raw-byte check (Plan 2, approve) refuses. The decode is fatal and keeps a BOM, so the string shown
 * encodes back to exactly the hashed bytes. Returns null for a mismatch or for bytes that are not valid UTF-8; a missing
 * crypto.subtle (an insecure context) throws, and the caller must treat a throw as "does not match" (fail closed).
 */
export async function verifiedHtml(bytes: ArrayBuffer, sha256: string): Promise<string | null> {
  if ((await sha256OfBytes(bytes)) !== sha256) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}
