/**
 * Cloudflare's three documented dummy secret keys: always pass, always fail, "token already spent"
 * (developers.cloudflare.com/turnstile/troubleshooting/testing/). Only these exact strings count.
 */
const TEST_SECRETS: readonly string[] = ["1x0000000000000000000000000000000AA", "2x0000000000000000000000000000000AA", "3x0000000000000000000000000000000AA"];

export const isDocumentedTestSecret = (secret: string): boolean => TEST_SECRETS.includes(secret);
