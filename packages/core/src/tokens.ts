// Tokens, hashes and canonical JSON. Web Crypto only, so the same code runs in Workers and Node.

/** 32 random bytes as base64url without padding: always 43 characters. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** A new single-use secret (invite, magic link, session). Store only sha256Hex(token). */
export function newToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** Lower-case hex SHA-256 of the UTF-8 bytes of `input`. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** HMAC-SHA256(key, ip) as base64url, first 22 characters. Never store a raw IP. Throws on an empty key. */
export async function hashIp(key: string, ip: string): Promise<string> {
  if (key === "") throw new Error("hashIp needs a non-empty key");
  const cryptoKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(ip));
  return base64url(new Uint8Array(mac)).slice(0, 22);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  // A null-prototype object keeps a "__proto__" key as an ordinary own property.
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key]);
  return out;
}

/** JSON with object keys sorted recursively and no whitespace, so equal values give equal strings.
 *  For JSON-shaped data only (records, arrays, strings, numbers, booleans, null): a Date or Map becomes {}. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
