// Cloudflare's documented Turnstile test values (developers.cloudflare.com/turnstile/troubleshooting/testing/).
// Shared by the fake siteverify (Worker side) and the tests (Node side), so it holds no runtime-specific types.

/** Test sitekey: always passes, visible widget. */
export const TURNSTILE_TEST_SITE_KEY = "1x00000000000000000000AA";
/** Test secret key: always passes validation. */
export const TURNSTILE_TEST_SECRET = "1x0000000000000000000000000000000AA";
/** The token a test sitekey's widget produces. */
export const TURNSTILE_DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
/** What the documented test secrets answer for the dummy token: action "test" and host name "localhost" (same page). */
export const TURNSTILE_TEST_HOSTNAME = "localhost";
export const TURNSTILE_TEST_ACTION = "test";
/** A stand-in for a production secret key: not one of the documented dummy secrets, so the real checks apply. */
export const TURNSTILE_LIVE_SECRET = "live-secret-for-tests";
/** One character off a documented dummy secret: it must NOT be treated as one. */
export const TURNSTILE_NEAR_MISS_SECRET = "1x0000000000000000000000000000000AB";
/** The token the fake siteverify treats as a production key's pass: solved on `host`, for `action` (the app's is "login"). */
export const liveToken = (host: string, action = "login"): string => `live:${host}|${action}`;
/** A production key's pass whose answer carries no host name at all. */
export const LIVE_TOKEN_NO_HOSTNAME = "live-no-hostname";

/** What the fake siteverify was sent: whether the secret was the test secret, never the secret itself. */
export interface SiteverifyCall {
  response: string | null;
  remoteip: string | null;
  idempotencyKey: string | null;
  testSecret: boolean;
}
