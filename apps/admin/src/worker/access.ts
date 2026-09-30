import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

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

/** The signed-in admin's email, or null. */
export async function adminEmail(request: Request, env: AccessEnv, keys: AccessKeys): Promise<string | null> {
  if (env.ADMIN_AUTH_MODE === "dev" && isLocalhost(new URL(request.url).hostname)) {
    const dev = normalise(env.DEV_ADMIN_EMAIL);
    return dev === "" ? null : dev;
  }
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (token === null || token === "") return null;
  try {
    const { payload } = await jwtVerify(token, keys(env), { issuer: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD });
    const email = typeof payload["email"] === "string" ? normalise(payload["email"]) : "";
    return email !== "" && allowlist(env.ADMIN_EMAILS).includes(email) ? email : null;
  } catch {
    return null;
  }
}
