import { createLocalJWKSet, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { adminEmail, allowlist, type AccessEnv } from "../../src/worker/access.ts";
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
