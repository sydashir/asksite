// Owner passwords (USER ORDER 2026-10-08). Web Crypto only, so the same code runs in Workers and Node. The constant-time
// comparison is the owner app Worker's (apps/app/src/worker/password.ts: crypto.subtle.timingSafeEqual, a workerd extension).

/** The password rules: at least 10 and at most 128 characters, counted in code points as Zod counts them. No "must contain" rules. */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * PBKDF2-SHA256 iterations: the most production Workers allow. workerd's production limit is DEFAULT_MAX_PBKDF2_ITERATIONS =
 * 100'000 (src/workerd/io/limit-enforcer.h:29); above it deriveBits fails with "Pbkdf2 failed: iteration counts above <max>
 * are not supported" (src/workerd/api/crypto/impl.c++:256-263). Local open-source workerd has no limit
 * (src/workerd/server/server.c++:3384-3386), so no local run can catch a higher count: test/password.test.ts pins it.
 */
export const PBKDF2_ITERATIONS = 100_000;

const SCHEME = "pbkdf2-sha256";
const SALT_BYTES = 16;
const KEY_BYTES = 32;

/**
 * What every unknown email, and every owner with no password, is checked against, so their answer costs one derive like a
 * real check (the timing matches). Its key is all zero bytes, which no derive gives in practice; the caller also never
 * accepts a check against it.
 */
export const DUMMY_PASSWORD_HASH = `${SCHEME}$${PBKDF2_ITERATIONS}$${"A".repeat(22)}==$${"A".repeat(43)}=`;

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

function fromBase64(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, KEY_BYTES * 8));
}

/** A new stored value for `password`: pbkdf2-sha256$100000$<16-byte salt, base64>$<32-byte key, base64>. Never the password. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  return `${SCHEME}$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(await derive(password, salt, PBKDF2_ITERATIONS))}`;
}

/** The parts of a stored value, or null unless it is this scheme with 1 to PBKDF2_ITERATIONS iterations, a 16-byte salt and a 32-byte key. */
function parse(stored: string): { iterations: number; salt: Uint8Array<ArrayBuffer>; key: Uint8Array<ArrayBuffer> } | null {
  const [scheme, count, salt, key, ...rest] = stored.split("$");
  if (scheme !== SCHEME || rest.length > 0 || count === undefined || !/^[1-9][0-9]{0,5}$/.test(count)) return null;
  const iterations = Number(count);
  const saltBytes = fromBase64(salt ?? "");
  const keyBytes = fromBase64(key ?? "");
  if (iterations > PBKDF2_ITERATIONS || saltBytes?.byteLength !== SALT_BYTES || keyBytes?.byteLength !== KEY_BYTES) return null;
  return { iterations, salt: saltBytes, key: keyBytes };
}

/**
 * The key `password` derives under `stored`'s salt and count, and the key `stored` holds, for the caller to compare in
 * constant time. A stored value that does not parse is checked as DUMMY_PASSWORD_HASH (the same cost) and marked `valid: false`.
 */
export async function passwordKeys(password: string, stored: string): Promise<{ derived: Uint8Array<ArrayBuffer>; expected: Uint8Array<ArrayBuffer>; valid: boolean }> {
  const parsed = parse(stored);
  const used = parsed ?? parse(DUMMY_PASSWORD_HASH)!;
  return { derived: await derive(password, used.salt, used.iterations), expected: used.key, valid: parsed !== null && stored !== DUMMY_PASSWORD_HASH };
}
