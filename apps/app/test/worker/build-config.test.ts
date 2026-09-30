import { describe, expect, it } from "vitest";
import { assertDeployableSiteKey, buildVars, contentSecurityPolicy, headersFile, parseDevVars, workerConfigPath } from "../../build-config.ts";

const ROOT = new URL("../../", import.meta.url).href;

describe("build-config", () => {
  it("picks each mode's Worker config and refuses an unknown mode", () => {
    expect(workerConfigPath("production")).toBe("./wrangler.jsonc");
    expect(workerConfigPath("development")).toBe("./wrangler.jsonc");
    expect(workerConfigPath("e2e")).toBe("./test/e2e/wrangler.e2e.jsonc");
    expect(() => workerConfigPath("staging")).toThrow('Unknown build mode "staging"');
  });

  it("reads KEY=VALUE lines, ignoring blanks and comments and unquoting values", () => {
    expect(parseDevVars('# a comment\n\nA=1\n  B = "two words" \nC=\n')).toEqual({ A: "1", B: "two words", C: "" });
  });

  it("gives the e2e build the e2e Worker's variables, and the development build .dev.vars.example's", () => {
    expect(buildVars("e2e", ROOT)["SUPPORT_EMAIL"]).toBe("help@example.com");
    expect(buildVars("e2e", ROOT)["TURNSTILE_SITE_KEY"]).toBe("1x00000000000000000000AA");
    expect(buildVars("development", ROOT)["APP_ORIGIN"]).toBe("https://app.localhost:8787");
    expect(buildVars("production", ROOT)["ENVIRONMENT"]).toBe("production");
  });

  it("lets Cloudflare's widget script and frame in (docs: script-src and frame-src), and only that", () => {
    const csp = contentSecurityPolicy("asksite.example");
    expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com;");
    expect(csp).toContain("frame-src 'self' https://challenges.cloudflare.com;");
    expect(csp).toContain("connect-src 'self';");
    expect(csp).toContain("img-src 'self' https://media.asksite.example blob: data:;");
    expect(csp).toContain("default-src 'self';");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(headersFile("asksite.example", false)).toContain("Content-Security-Policy: default-src 'self'");
  });
});

describe("assertDeployableSiteKey (M3: Task 27's deploy step runs it)", () => {
  it("refuses an empty sitekey and each documented dummy sitekey", () => {
    for (const key of ["", "1x00000000000000000000AA", "2x00000000000000000000AB", "1x00000000000000000000BB", "2x00000000000000000000BB", "3x00000000000000000000FF"]) {
      expect(() => assertDeployableSiteKey(key), key).toThrow(/TURNSTILE_SITE_KEY/);
    }
  });

  it("accepts a real-looking sitekey", () => {
    expect(() => assertDeployableSiteKey("0x4AAAAAAAexampleKeyExample")).not.toThrow();
  });
});
