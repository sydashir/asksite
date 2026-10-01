import { createLocalJWKSet, errors, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { describe, expect, it } from "vitest";
import { adminAccess, adminEmail, allowlist, type AccessEnv, type AccessKeys } from "../../src/worker/access.ts";
import { ACCESS_JWKS, accessToken, AUD, TEAM } from "../support/harness.ts";

const ENV: AccessEnv = { ADMIN_AUTH_MODE: "access", DEV_ADMIN_EMAIL: "dev@example.com", ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ADMIN_EMAILS: "Admin@Example.com, second@example.com" };
const keys = () => createLocalJWKSet(ACCESS_JWKS);
const request = (token: string | null, host = "admin.asksite.example") =>
  new Request(`https://${host}/api/admin/me`, token === null ? {} : { headers: { "Cf-Access-Jwt-Assertion": token } });

describe("adminEmail", () => {
  it("accepts a valid Access token for an allowlisted email, compared lower-case", async () => {
    expect(await adminEmail(request(await accessToken({ email: "ADMIN@example.com" })), ENV, keys)).toBe("admin@example.com");
  });

  it.each([
    ["no token", async () => null],
    ["an email not on the list", () => accessToken({ email: "intruder@example.com" })],
    ["another application's audience", () => accessToken({ aud: "other-app" })],
    ["another issuer", () => accessToken({ iss: "https://evil.cloudflareaccess.com" })],
    ["an expired token", () => accessToken({ expiresIn: "-1m" })],
    ["an unsigned token", async () => `${btoa('{"alg":"none"}')}.${btoa(JSON.stringify({ email: "admin@example.com", aud: AUD, iss: TEAM }))}.`],
  ])("refuses %s", async (_name, token) => {
    expect(await adminEmail(request(await token()), ENV, keys)).toBeNull();
  });

  it("refuses a token signed with a different key", async () => {
    const { generateKeyPair } = await import("jose");
    const other = await generateKeyPair("RS256");
    const forged = await new SignJWT({ email: "admin@example.com" }).setProtectedHeader({ alg: "RS256", kid: "test-key" }).setIssuer(TEAM).setAudience(AUD).setExpirationTime("5m").sign(other.privateKey);
    expect(await adminEmail(request(forged), ENV, keys)).toBeNull();
  });

  it("refuses a correctly signed token with no expiry (F3): it would otherwise be valid forever", async () => {
    expect(await adminEmail(request(await accessToken({ noExpiry: true })), ENV, keys)).toBeNull();
  });

  it("accepts only RS256, the algorithm Access signs with (F3), even from a key that would also verify RS384", async () => {
    const pair = await generateKeyPair("RS384", { extractable: true });
    const jwk = await exportJWK(pair.publicKey);
    const rs384Keys = () => createLocalJWKSet({ keys: [{ ...jwk, kid: "k384" }] });
    const token = await new SignJWT({ email: "admin@example.com" }).setProtectedHeader({ alg: "RS384", kid: "k384" }).setIssuer(TEAM).setAudience(AUD).setExpirationTime("5m").sign(pair.privateKey);
    expect(await adminEmail(request(token), ENV, rs384Keys)).toBeNull();
  });

  // F9: the production defaults ship ACCESS_AUD, ADMIN_EMAILS and DEV_ADMIN_EMAIL empty. They must fail closed.
  it.each([
    ["an empty ACCESS_AUD", { ACCESS_AUD: "" }],
    ["an empty ADMIN_EMAILS", { ADMIN_EMAILS: "" }],
  ])("fails closed with %s, even for a valid token", async (_name, override) => {
    expect(await adminEmail(request(await accessToken()), { ...ENV, ...override }, keys)).toBeNull();
  });

  it("fails closed in dev mode on localhost with an empty DEV_ADMIN_EMAIL", async () => {
    expect(await adminEmail(request(null, "admin.localhost:8788"), { ...ENV, ADMIN_AUTH_MODE: "dev", DEV_ADMIN_EMAIL: "" }, keys)).toBeNull();
  });

  it("refuses a valid token that carries no email", async () => {
    expect(await adminEmail(request(await accessToken({ noEmail: true })), ENV, keys)).toBeNull();
  });

  it("honours dev mode only on localhost host names", async () => {
    const dev = { ...ENV, ADMIN_AUTH_MODE: "dev" };
    expect(await adminEmail(request(null, "admin.localhost:8788"), dev, keys)).toBe("dev@example.com");
    expect(await adminEmail(request(null, "admin.asksite.example"), dev, keys)).toBeNull();
    expect(await adminEmail(request(null, "localhost.evil.example"), dev, keys)).toBeNull();
  });

  it("parses the allowlist", () => {
    expect(allowlist(" A@x.com, ,b@Y.com ")).toEqual(["a@x.com", "b@y.com"]);
    expect(allowlist("")).toEqual([]);
  });
});

// F7: why the gate refused, as a token for the log. Never the token, an email or a key.
describe("adminAccess reasons", () => {
  const refusedWith = async (token: string | null, env: AccessEnv = ENV, getKeys: AccessKeys = keys) => {
    const result = await adminAccess(request(token), env, getKeys);
    return "refused" in result ? result.refused : result.email;
  };

  it("tells apart a missing token, a bad token, an email not on the list and unreachable keys", async () => {
    expect(await refusedWith(null)).toBe("no_token");
    expect(await refusedWith("")).toBe("no_token");
    expect(await refusedWith("not-a-jwt")).toBe("invalid_token");
    expect(await refusedWith(await accessToken({ expiresIn: "-1m" }))).toBe("invalid_token");
    expect(await refusedWith(await accessToken({ aud: "other-app" }))).toBe("invalid_token");
    expect(await refusedWith(await accessToken({ noExpiry: true }))).toBe("invalid_token");
    expect(await refusedWith(await accessToken({ email: "intruder@example.com" }))).toBe("not_on_list");
    expect(await refusedWith(await accessToken({ noEmail: true }))).toBe("not_on_list");
    expect(await refusedWith(await accessToken({ email: "Admin@Example.com" }))).toBe("admin@example.com");
    const failing = (error: Error): AccessKeys => () => (() => Promise.reject(error)) as JWTVerifyGetKey;
    const down = [new errors.JWKSTimeout(), new errors.JOSEError("Expected 200 OK from the JSON Web Key Set HTTP response"), new TypeError("fetch failed")];
    for (const error of down) expect(await refusedWith(await accessToken(), ENV, failing(error))).toBe("keys_unavailable");
  });

  it("never puts the token, an email or the team domain in a reason", async () => {
    const token = await accessToken({ email: "intruder@example.com" });
    const result = await adminAccess(request(token), ENV, keys);
    const text = JSON.stringify(result);
    expect(text).not.toContain(token);
    expect(text).not.toMatch(/intruder|@|cloudflareaccess/);
  });
});
