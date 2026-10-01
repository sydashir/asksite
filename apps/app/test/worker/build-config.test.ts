import { describe, expect, it } from "vitest";
import { assertDeployableSiteKey, buildVars, contentSecurityPolicy, headersFile, LOCAL_BUILD_WORKER_NAME, parseDevVars, undeployableLocalConfig, workerConfigPath } from "../../build-config.ts";

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

  // STRICT (CSP): the editor's preview is a srcdoc frame, which inherits this policy. The Bold design embeds its font as a
  // data: URI, so font-src allows 'self' and data:, and nothing else about the policy widens (moderator, task-17-extra B).
  it("lets the preview's embedded font (a data: URI) load, and widens nothing else", () => {
    const csp = contentSecurityPolicy("asksite.example");
    const directives: Record<string, string[]> = Object.fromEntries(
      csp.split("; ").map((d) => {
        const [name = "", ...sources] = d.split(" ");
        return [name, sources];
      }),
    );
    expect(directives["font-src"]).toEqual(["'self'", "data:"]);
    // data: is allowed for images and fonts only: never for scripts, styles, frames, connections or the default.
    const withData = Object.entries(directives).filter(([, sources]) => sources.includes("data:")).map(([name]) => name);
    expect(withData.sort()).toEqual(["font-src", "img-src"]);
    expect(Object.keys(directives)).toEqual(["default-src", "script-src", "style-src", "img-src", "font-src", "connect-src", "frame-src", "form-action", "base-uri", "object-src", "frame-ancestors"]);
    expect(directives["default-src"]).toEqual(["'self'"]);
  });
});

// F14: the whole _headers file, line by line, so deleting or changing any single header turns a test red (the CSP
// directives are also checked one by one above). The static file is the only place the SPA's headers come from (§9.1).
const CSP =
  "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' https://media.asksite.example blob: data:; font-src 'self' data:; connect-src 'self'; frame-src 'self' https://challenges.cloudflare.com; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'";
const COMMON_HEADERS = ["  X-Content-Type-Options: nosniff", "  Referrer-Policy: no-referrer", "  X-Frame-Options: DENY", "  X-Robots-Tag: noindex"];

describe("headersFile (F14)", () => {
  it("is exactly this for a production build: the CSP, HSTS, nosniff, no referrer, no framing, no indexing", () => {
    expect(headersFile("asksite.example", true)).toBe(
      ["/*", `  Content-Security-Policy: ${CSP}`, "  Strict-Transport-Security: max-age=31536000; includeSubDomains", ...COMMON_HEADERS, ""].join("\n"),
    );
  });

  it("is exactly this for any other build: the same, without HSTS (it would force https onto every local project)", () => {
    expect(headersFile("asksite.example", false)).toBe(["/*", `  Content-Security-Policy: ${CSP}`, ...COMMON_HEADERS, ""].join("\n"));
  });
});

// F5: `pnpm build` builds on the production wrangler.jsonc, and a bare `wrangler deploy` follows the build's output config.
describe("undeployableLocalConfig (F5)", () => {
  const production = { name: "asksite-app", routes: [{ pattern: "app.asksite.example/*", zone_name: "asksite.example" }], triggers: { crons: ["0 6 * * *"] }, vars: { ENVIRONMENT: "production" } };

  it("renames the Worker and drops its route and cron, so a bare deploy cannot replace production or take its address", () => {
    const local = undeployableLocalConfig(production);
    expect(local["name"]).toBe(LOCAL_BUILD_WORKER_NAME);
    expect(LOCAL_BUILD_WORKER_NAME).not.toBe(production.name);
    expect(local).not.toHaveProperty("routes");
    expect(local).not.toHaveProperty("triggers");
  });

  it("keeps everything else, so the local build still runs as configured", () => {
    expect(undeployableLocalConfig(production)["vars"]).toEqual(production.vars);
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
