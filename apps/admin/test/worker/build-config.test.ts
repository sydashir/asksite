import { describe, expect, it } from "vitest";
import { contentSecurityPolicy as appPolicy } from "../../../app/build-config.ts";
import { adminContentSecurityPolicy, adminHeadersFile, LOCAL_BUILD_WORKER_NAME, undeployableLocalConfig } from "../../build-config.ts";

// §9.1 / security area: the admin's document policy. The review screen shows the stored page in a srcdoc iframe, which
// inherits this policy, so the Bold font (a data: URI) needs font-src data:. The owner app has the same font-src, so the
// admin adds no directive the app lacks and every shared directive matches, except script-src and frame-src (Turnstile).
const ROOT = "asksite.example";

const directives = (policy: string) => new Map(policy.split("; ").map((d) => [d.slice(0, d.indexOf(" ")), d] as const));

describe("adminContentSecurityPolicy", () => {
  it("is exactly the pinned policy", () => {
    expect(adminContentSecurityPolicy(ROOT)).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https://media.asksite.example blob: data:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'",
    );
  });

  it("widens nothing against the owner app's policy, and Turnstile is absent", () => {
    const admin = directives(adminContentSecurityPolicy(ROOT));
    const app = directives(appPolicy(ROOT));
    expect(adminContentSecurityPolicy(ROOT)).not.toContain("challenges.cloudflare.com");
    expect([...admin.keys()].filter((name) => !app.has(name))).toEqual([]);
    for (const [name, value] of app) {
      if (name === "script-src" || name === "frame-src") continue; // the app's list adds Turnstile; the admin's is the same without it
      expect(admin.get(name)).toBe(value);
    }
    expect(admin.get("font-src")).toBe("font-src 'self' data:");
    expect(app.get("font-src")).toBe("font-src 'self' data:");
    expect(admin.get("script-src")).toBe("script-src 'self'");
    expect(admin.get("frame-src")).toBe("frame-src 'self'");
  });
});

describe("adminHeadersFile", () => {
  it("carries the admin policy, and HSTS only in a production build", () => {
    expect(adminHeadersFile(ROOT, false)).toContain(`Content-Security-Policy: ${adminContentSecurityPolicy(ROOT)}`);
    expect(adminHeadersFile(ROOT, false)).not.toContain("Strict-Transport-Security");
    expect(adminHeadersFile(ROOT, true)).toContain("Strict-Transport-Security: max-age=31536000; includeSubDomains");
    for (const text of [adminHeadersFile(ROOT, false), adminHeadersFile(ROOT, true)]) {
      expect(text).toContain("X-Frame-Options: DENY");
      expect(text).toContain("X-Content-Type-Options: nosniff");
      expect(text).toContain("Referrer-Policy: no-referrer");
      expect(text).toContain("X-Robots-Tag: noindex");
    }
  });
});

// F5: a development build runs on the production wrangler.jsonc, and a bare `wrangler deploy` follows the build's output config.
describe("undeployableLocalConfig (F5)", () => {
  const production = { name: "asksite-admin", routes: [{ pattern: "admin.asksite.example/*", zone_name: "asksite.example" }], triggers: { crons: ["0 6 * * *"] }, vars: { ENVIRONMENT: "production" } };

  it("renames the Worker and drops its route, so a bare deploy cannot replace production or take its address", () => {
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
