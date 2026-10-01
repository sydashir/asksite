import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";

// Admin sign-in (§5.3): Cloudflare Access lets only the allowed identities through, and this
// Worker checks again: the Access JWT (signature, issuer, audience, expiry) and the email
// allowlist. Any failure is null, which the caller turns into 403.

export interface AccessEnv {
  ADMIN_AUTH_MODE: string;
  DEV_ADMIN_EMAIL: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ADMIN_EMAILS: string;
}

export type AccessKeys = (env: AccessEnv) => JWTVerifyGetKey;

const remoteKeySets = new Map<string, JWTVerifyGetKey>();

/** Access's public keys, fetched from the team domain and cached for the life of the isolate. */
export const remoteAccessKeys: AccessKeys = (env) => {
  let keys = remoteKeySets.get(env.ACCESS_TEAM_DOMAIN);
  if (keys === undefined) {
    keys = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", env.ACCESS_TEAM_DOMAIN));
    remoteKeySets.set(env.ACCESS_TEAM_DOMAIN, keys);
  }
  return keys;
};

const normalise = (email: string): string => email.trim().toLowerCase();
export const allowlist = (list: string): string[] => list.split(",").map(normalise).filter((e) => e !== "");

const isLocalhost = (hostname: string): boolean => hostname === "localhost" || hostname.endsWith(".localhost");

/** Why the gate refused, as a log token (never the token, an email or a key). */
export type RefusalReason = "no_token" | "invalid_token" | "not_on_list" | "keys_unavailable";

export type AdminAccess = { email: string } | { refused: RefusalReason };

/** jose errors that mean the token itself is wrong (bad signature, claims, shape, algorithm or unknown key id). */
const TOKEN_FAULTS = new Set(["ERR_JOSE_ALG_NOT_ALLOWED", "ERR_JOSE_NOT_SUPPORTED", "ERR_JWKS_NO_MATCHING_KEY", "ERR_JWKS_MULTIPLE_MATCHING_KEYS"]);

/**
 * jose's own error code (documented stable): a JWT_* or JWS_* error, or one of TOKEN_FAULTS, is the token's fault.
 * Anything else (a JWKS timeout, a non-200 or unparseable key response, a network failure) means the keys could not be had.
 */
function refusalFor(error: unknown): RefusalReason {
  const code = error instanceof errors.JOSEError ? error.code : "";
  return code.startsWith("ERR_JWT_") || code.startsWith("ERR_JWS_") || TOKEN_FAULTS.has(code) ? "invalid_token" : "keys_unavailable";
}

/** The signed-in admin's email, or why not. */
export async function adminAccess(request: Request, env: AccessEnv, keys: AccessKeys): Promise<AdminAccess> {
  if (env.ADMIN_AUTH_MODE === "dev" && isLocalhost(new URL(request.url).hostname)) {
    const dev = normalise(env.DEV_ADMIN_EMAIL);
    return dev === "" ? { refused: "not_on_list" } : { email: dev };
  }
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (token === null || token === "") return { refused: "no_token" };
  try {
    const { payload } = await jwtVerify(token, keys(env), {
      issuer: env.ACCESS_TEAM_DOMAIN,
      audience: env.ACCESS_AUD,
      algorithms: ["RS256"], // what Cloudflare Access signs with
      requiredClaims: ["exp"], // jose checks exp only when present: without this a token with none never expires
    });
    const email = typeof payload["email"] === "string" ? normalise(payload["email"]) : "";
    return email !== "" && allowlist(env.ADMIN_EMAILS).includes(email) ? { email } : { refused: "not_on_list" };
  } catch (error) {
    return { refused: refusalFor(error) };
  }
}

/** The signed-in admin's email, or null. */
export async function adminEmail(request: Request, env: AccessEnv, keys: AccessKeys): Promise<string | null> {
  const access = await adminAccess(request, env, keys);
  return "email" in access ? access.email : null;
}
