import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { deployProblems } from "./deploy-check.ts";

const NOW = Date.parse("2026-09-24T00:00:00.000Z");

// A config shaped like apps/sites/wrangler.jsonc as committed before the deploy task (it holds the
// local placeholders). Inline, so this test keeps passing after the real values are committed.
const PLACEHOLDERS = JSON.stringify({
  name: "asksite-sites",
  workers_dev: false,
  preview_urls: false,
  observability: { enabled: true, logs: { invocation_logs: false } },
  routes: [{ pattern: "*.asksite.example/*", zone_name: "asksite.example" }],
  vars: {
    ENVIRONMENT: "production",
    ROOT_DOMAIN: "asksite.example",
    MAILER: "resend",
    MAIL_FROM: "asksite <leads@mail.asksite.example>",
    SECURITY_TXT_EXPIRES: "2027-09-01T00:00:00.000Z",
  },
  d1_databases: [{ binding: "DB", database_name: "asksite", database_id: "00000000-0000-0000-0000-000000000000" }],
});

const ready = (): string =>
  PLACEHOLDERS.replaceAll("asksite.example", "tradesites.test").replace("00000000-0000-0000-0000-000000000000", "3f0f5a4e-7c1b-4d8e-9a2b-1c2d3e4f5a6b");

describe("deployProblems", () => {
  it("blocks a config that still holds the local placeholders", () => {
    expect(deployProblems(PLACEHOLDERS, NOW)).toEqual([
      "still uses the placeholder domain asksite.example",
      "D1 database_id is still the local placeholder",
    ]);
  });

  it("passes a config with the real domain, database id and a fresh security.txt date", () => {
    expect(deployProblems(ready(), NOW)).toEqual([]);
  });

  it("catches development values and unsafe switches", () => {
    const unsafe = ready()
      .replace('"ENVIRONMENT":"production"', '"ENVIRONMENT":"development"')
      .replace('"MAILER":"resend"', '"MAILER":"log"')
      .replace('"workers_dev":false', '"workers_dev":true')
      .replace('"invocation_logs":false', '"invocation_logs":true');
    expect(deployProblems(unsafe, NOW)).toEqual([
      "vars.ENVIRONMENT must be production",
      "vars.MAILER must be resend",
      "workers_dev and preview_urls must be false",
      "observability.logs.invocation_logs must be false",
    ]);
  });

  it("catches the other Workers' unsafe switches and a secret put in vars (design §9.1)", () => {
    const config = JSON.parse(ready()) as { vars: Record<string, string> };
    config.vars = { ...config.vars, ADMIN_AUTH_MODE: "dev", MODEL_PROVIDER: "fake", RESEND_API_KEY: "re_not_a_real_key" };
    expect(deployProblems(JSON.stringify(config), NOW)).toEqual([
      "vars.ADMIN_AUTH_MODE must be access",
      "vars.MODEL_PROVIDER must not be fake",
      "vars.RESEND_API_KEY looks like a secret: use wrangler secret put",
    ]);
  });

  it("catches a local root domain", () => {
    const local = ready().replace('"ROOT_DOMAIN":"tradesites.test"', '"ROOT_DOMAIN":"localhost:8789"');
    expect(deployProblems(local, NOW)).toContain("vars.ROOT_DOMAIN must be the real domain without a port");
  });

  it("wants security.txt to expire 30 to 366 days ahead", () => {
    const soon = ready().replace("2027-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z");
    const far = ready().replace("2027-09-01T00:00:00.000Z", "2028-09-01T00:00:00.000Z");
    expect(deployProblems(soon, NOW)).toEqual(["vars.SECURITY_TXT_EXPIRES must be 30 to 366 days from today"]);
    expect(deployProblems(far, NOW)).toEqual(["vars.SECURITY_TXT_EXPIRES must be 30 to 366 days from today"]);
  });
});

// Edges the tests above leave open (each one kills a mutant that passed them).
describe("deployProblems edges", () => {
  const EXPIRY = "vars.SECURITY_TXT_EXPIRES must be 30 to 366 days from today";
  const withVars = (vars: Record<string, string>): string => JSON.stringify({ ...JSON.parse(ready()), vars });
  const expiring = (iso: string): string[] => deployProblems(ready().replace("2027-09-01T00:00:00.000Z", iso), NOW);

  it("passes a Worker without the sites-only variables (shaped like the generator, design §10.3)", () => {
    expect(deployProblems(withVars({ ENVIRONMENT: "production", MODEL_PROVIDER: "anthropic", MODEL_ID: "claude-opus-5-5", GENERATION_ENABLED: "false" }), NOW)).toEqual([]);
  });

  it("refuses preview_urls on its own, and a config that leaves both switches out", () => {
    expect(deployProblems(ready().replace('"preview_urls":false', '"preview_urls":true'), NOW)).toEqual(["workers_dev and preview_urls must be false"]);
    const unset = JSON.parse(ready()) as { workers_dev?: boolean; preview_urls?: boolean };
    delete unset.workers_dev;
    delete unset.preview_urls;
    expect(deployProblems(JSON.stringify(unset), NOW)).toEqual(["workers_dev and preview_urls must be false"]);
  });

  it("refuses a real domain with a port", () => {
    const withPort = ready().replace('"ROOT_DOMAIN":"tradesites.test"', '"ROOT_DOMAIN":"tradesites.test:8443"');
    expect(deployProblems(withPort, NOW)).toEqual(["vars.ROOT_DOMAIN must be the real domain without a port"]);
  });

  it("treats each secret-like word in a variable name as a secret", () => {
    const vars = { ...(JSON.parse(ready()) as { vars: Record<string, string> }).vars, IP_HASH_KEY: "x", A_SECRET: "x", A_TOKEN: "x", A_PASSWORD: "x" };
    expect(deployProblems(withVars(vars), NOW)).toEqual(
      ["IP_HASH_KEY", "A_SECRET", "A_TOKEN", "A_PASSWORD"].map((name) => `vars.${name} looks like a secret: use wrangler secret put`),
    );
  });

  it("accepts exactly 30 and exactly 366 days, and refuses anything outside them or not a date", () => {
    expect(expiring("2026-10-24T00:00:00.000Z")).toEqual([]); // NOW + 30 days
    expect(expiring("2027-09-25T00:00:00.000Z")).toEqual([]); // NOW + 366 days
    expect(expiring("2026-10-23T23:59:59.999Z")).toEqual([EXPIRY]);
    expect(expiring("2027-09-25T00:00:00.001Z")).toEqual([EXPIRY]);
    expect(expiring("next year")).toEqual([EXPIRY]);
  });
});

// Turnstile's sitekey is public ("Public key used to invoke the Turnstile widget on your site",
// Cloudflare Turnstile docs) and a var of asksite-app (A11 item 4), though its name says KEY.
describe("public variables with a secret-like name", () => {
  const readyVars = (): Record<string, string> => (JSON.parse(ready()) as { vars: Record<string, string> }).vars;
  const withVars = (vars: Record<string, string>): string => JSON.stringify({ ...JSON.parse(ready()), vars });

  it("passes the app Worker's production variables, the Turnstile sitekey included", () => {
    const app = {
      ENVIRONMENT: "production",
      ROOT_DOMAIN: "tradesites.test",
      APP_ORIGIN: "https://app.tradesites.test",
      MAILER: "resend",
      MAIL_FROM: "Website team <hello@mail.tradesites.test>",
      SUPPORT_EMAIL: "help@tradesites.test",
      ADMIN_NOTIFY_EMAILS: "reviewer@tradesites.test",
      GENERATION_ENABLED: "false",
      DAILY_MODEL_LIMIT: "8",
      TURNSTILE_SITE_KEY: "0x4AAAAAAAexampleSiteKey",
      LOGIN_EMAILS_PER_DAY: "40",
    };
    expect(deployProblems(withVars(app), NOW)).toEqual([]);
  });

  it("exempts only that exact name: the secret, look-alike names and other casings are still refused", () => {
    const names = ["TURNSTILE_SECRET_KEY", "OTHER_SITE_KEY", "TURNSTILE_SITE_KEY_2", "turnstile_site_key"];
    const vars = { ...readyVars(), ...Object.fromEntries(names.map((name) => [name, "x"])) };
    expect(deployProblems(withVars(vars), NOW)).toEqual(names.map((name) => `vars.${name} looks like a secret: use wrangler secret put`));
  });
});

// Item 3 (G1): the configured model must be priced.
describe("deployProblems: the model is priced", () => {
  const PRICED = "vars.MODEL_PROVIDER and vars.MODEL_ID must name a priced model (packages/generation/src/models.ts)";
  const withModel = (vars: Record<string, string>): string => JSON.stringify({ ...JSON.parse(ready()), vars: { ENVIRONMENT: "production", ...vars } });

  it.each([
    ["an unpriced Anthropic model", { MODEL_PROVIDER: "anthropic", MODEL_ID: "claude-fable-5-1" }],
    ["a dated alias of a priced one", { MODEL_PROVIDER: "anthropic", MODEL_ID: "claude-opus-5-5-20261001" }],
    ["no model id", { MODEL_PROVIDER: "anthropic" }],
  ])("refuses %s", (_name, vars) => {
    expect(deployProblems(withModel(vars), NOW)).toEqual([PRICED]);
  });

  // Pin changed (item 4): was [PRICED]; an unknown provider is now also refused as not anthropic.
  it("refuses an unknown provider as unpriced and as not anthropic", () => {
    expect(deployProblems(withModel({ MODEL_PROVIDER: "other", MODEL_ID: "claude-opus-5-5" }), NOW)).toEqual(["vars.MODEL_PROVIDER must be anthropic", PRICED]);
  });

  it.each([
    ["anthropic", "claude-opus-5-5"],
    ["anthropic", "claude-sonnet-5"],
  ])("passes the priced model %s:%s, and a Worker with no model variables", (provider, model) => {
    expect(deployProblems(withModel({ MODEL_PROVIDER: provider, MODEL_ID: model }), NOW)).toEqual([]);
    expect(deployProblems(withModel({}), NOW)).toEqual([]);
  });

  it("says only the fake-provider problem for the fake provider", () => {
    expect(deployProblems(withModel({ MODEL_PROVIDER: "fake", MODEL_ID: "fake-template" }), NOW)).toEqual(["vars.MODEL_PROVIDER must not be fake"]);
  });
});

// Item 4: production allows only the Anthropic provider (the runtime refuses the others too).
describe("deployProblems: Anthropic only", () => {
  const ONLY = "vars.MODEL_PROVIDER must be anthropic";
  const withModel = (vars: Record<string, string>): string => JSON.stringify({ ...JSON.parse(ready()), vars: { ENVIRONMENT: "production", ...vars } });

  it.each([
    ["openai-compatible", "@cf/openai/gpt-oss-120b"],
    ["openai-compatible", "openai/gpt-oss-120b:groq"],
    ["Anthropic", "claude-opus-5-5"],
    ["", "claude-opus-5-5"],
  ])("refuses the provider %j with model %s", (provider, model) => {
    expect(deployProblems(withModel({ MODEL_PROVIDER: provider, MODEL_ID: model }), NOW)).toContain(ONLY);
  });

  // Pin moved here (item 4): "passes the priced model openai-compatible:@cf/openai/gpt-oss-120b" is now refused, and only for the provider.
  it("refuses a priced openai-compatible model for the provider alone", () => {
    expect(deployProblems(withModel({ MODEL_PROVIDER: "openai-compatible", MODEL_ID: "@cf/openai/gpt-oss-120b" }), NOW)).toEqual([ONLY]);
  });

  it("accepts anthropic and says nothing about the provider", () => {
    expect(deployProblems(withModel({ MODEL_PROVIDER: "anthropic", MODEL_ID: "claude-opus-5-5" }), NOW)).toEqual([]);
  });

  it("accepts the shipped generator config as far as the provider goes", () => {
    const shipped = readFileSync(resolve(import.meta.dirname, "../apps/generator/wrangler.jsonc"), "utf8");
    expect(deployProblems(shipped, NOW).filter((problem) => problem.includes("MODEL_PROVIDER"))).toEqual([]);
    expect((JSON.parse(shipped) as { vars: Record<string, string> }).vars.MODEL_PROVIDER).toBe("anthropic");
  });
});
