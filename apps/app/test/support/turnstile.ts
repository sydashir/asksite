// Cloudflare's documented Turnstile test values (developers.cloudflare.com/turnstile/troubleshooting/testing/).
// Shared by the fake siteverify (Worker side) and the tests (Node side), so it holds no runtime-specific types.

/** Test sitekey: always passes, visible widget. */
export const TURNSTILE_TEST_SITE_KEY = "1x00000000000000000000AA";
/** Test secret key: always passes validation. */
export const TURNSTILE_TEST_SECRET = "1x0000000000000000000000000000000AA";
/** The token a test sitekey's widget produces. */
export const TURNSTILE_DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
/**
 * The host name the real siteverify names for the test secret, with `metadata.result_with_testing_key: true`
 * (measured 2026-09-26; the docs' example says "localhost"). It is never this app's host.
 */
export const TURNSTILE_TEST_HOSTNAME = "example.com";

/** What the fake siteverify was sent: whether the secret was the test secret, never the secret itself. */
export interface SiteverifyCall {
  response: string | null;
  remoteip: string | null;
  idempotencyKey: string | null;
  testSecret: boolean;
}
