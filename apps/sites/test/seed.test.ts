import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DESIGN_IDS, type SiteDocumentInput } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { assertLocalToolsConfig, localStatePath, parseSeedOptions, seedDocument, toolsConfig } from "../dev/seed.ts";

const REPO = resolve(import.meta.dirname, "../../..");

describe("pnpm dev:seed options", () => {
  it("defaults to the local demo site, in the fixture's own design", () => {
    expect(parseSeedOptions([])).toEqual({
      slug: "demo", fixture: "plumber-austin", design: null, persistTo: ".wrangler/state", root: "localhost:8789",
      ownerEmail: null, heroPhoto: false, indexable: true, remote: false,
    });
  });

  it("reads the deploy smoke test's options", () => {
    const argv = ["--remote", "--root", "example.com", "--slug", "smoke-test", "--fixture", "cleaning-minimal", "--hero-photo", "--noindex", "--owner-email", "me@example.com"];
    expect(parseSeedOptions(argv)).toEqual({
      slug: "smoke-test", fixture: "cleaning-minimal", design: null, persistTo: ".wrangler/state", root: "example.com",
      ownerEmail: "me@example.com", heroPhoto: true, indexable: false, remote: true,
    });
  });

  it.each(DESIGN_IDS)("reads the %s page design", (design) => {
    expect(parseSeedOptions(["--design", design]).design).toBe(design);
  });

  it("rejects unknown options, missing values, odd fixture names and unknown designs", () => {
    expect(() => parseSeedOptions(["--fast"])).toThrow("Unknown option --fast");
    expect(() => parseSeedOptions(["--slug"])).toThrow("--slug needs a value");
    expect(() => parseSeedOptions(["--fixture", "../etc"])).toThrow("Unknown fixture ../etc");
    expect(() => parseSeedOptions(["--design"])).toThrow("--design needs a value");
    // The owner-facing name is not an id (A12: Bold is "impact").
    expect(() => parseSeedOptions(["--design", "bold"])).toThrow("Unknown design bold");
  });
});

describe("the document the seed publishes", () => {
  const fixture = (name: string): SiteDocumentInput => JSON.parse(readFileSync(resolve(REPO, "fixtures", `${name}.json`), "utf8")) as SiteDocumentInput;

  it("is the fixture in its own design when no design is given", () => {
    const roofing = fixture("roofing-extreme");
    expect(seedDocument(roofing, { design: null, heroPhoto: false })).toEqual(roofing);
  });

  it.each(DESIGN_IDS)("is drawn in the %s design when asked, keeping the fixture's colours and lettering", (design) => {
    const electrical = fixture("electrical-xss"); // a fixture that names no design
    const seeded = seedDocument(electrical, { design, heroPhoto: false });
    expect(seeded.theme).toEqual({ ...electrical.theme, design });
    expect({ ...seeded, theme: electrical.theme }).toEqual(electrical);
  });

  it("adds the sample hero photo in the design asked for", () => {
    const seeded = seedDocument(fixture("cleaning-minimal"), { design: "impact", heroPhoto: true });
    expect(seeded.theme.design).toBe("impact");
    expect(seeded.facts.heroPhoto?.url).toBe("https://media.invalid/sample.webp");
  });
});

// QA-2 QS(4): `pnpm dev --persist-to <dir>` hands the folder to wrangler unchanged, so the seed must reach
// the same state for a relative folder (from the repo) and for an absolute one (as given).
describe("the local state the seed writes", () => {
  it("is <persist-to>/v3, a relative folder read from the repo", () => {
    expect(localStatePath(".wrangler/state")).toBe(resolve(REPO, ".wrangler/state/v3"));
    expect(localStatePath(".wrangler/e2e-state")).toBe(resolve(REPO, ".wrangler/e2e-state/v3"));
  });

  it("is <persist-to>/v3 for an absolute folder, never a folder inside the repo", () => {
    expect(localStatePath("/private/tmp/asksite-state")).toBe("/private/tmp/asksite-state/v3");
    expect(localStatePath("/private/tmp/asksite-state/").startsWith(REPO)).toBe(false);
  });
});

describe("toolsConfig", () => {
  const sites = {
    compatibility_date: "2026-09-21",
    d1_databases: [{ binding: "DB", database_name: "asksite", database_id: "x" }],
    r2_buckets: [{ binding: "LIVE", bucket_name: "asksite-live" }],
  };
  // A13: at this date Node.js compatibility is on by default (and fills process.env with the text
  // bindings). The exact list also refuses any other flag, such as nodejs_compat_populate_process_env.
  const NO_NODE = ["no_nodejs_compat", "no_nodejs_compat_v2"];

  it("adds WORK next to the sites Worker's own bindings", () => {
    expect(toolsConfig(sites, false)).toEqual({
      name: "asksite-dev-tools",
      compatibility_date: "2026-09-21",
      compatibility_flags: NO_NODE,
      d1_databases: sites.d1_databases,
      r2_buckets: [...sites.r2_buckets, { binding: "WORK", bucket_name: "asksite-work" }],
    });
  });

  it("marks every binding remote for the production smoke test, and only then", () => {
    const remote = toolsConfig(sites, true) as { compatibility_flags: string[]; d1_databases: Array<{ remote?: boolean }>; r2_buckets: Array<{ remote?: boolean }> };
    expect([...remote.d1_databases, ...remote.r2_buckets].map((b) => b.remote)).toEqual([true, true, true]);
    expect(remote.compatibility_flags).toEqual(NO_NODE);
    expect(JSON.stringify(toolsConfig(sites, false))).not.toContain("remote");
  });
});

// A16-4c: operate.ts and the local seed run the real publishing functions (takeDown, restore, approve), so they must
// never reach production through a tools config that names a remote binding, and wrangler's getPlatformProxy starts
// remote bindings unless told remoteBindings: false (wrangler 4.138.0).
describe("the local-only guard for the tools config", () => {
  const sites = { compatibility_date: "2026-09-21", d1_databases: [{ binding: "DB", database_name: "asksite", database_id: "x" }], r2_buckets: [{ binding: "LIVE", bucket_name: "asksite-live" }] };
  const guard = (config: unknown) => assertLocalToolsConfig(JSON.stringify(config));

  it("accepts the local tools config", () => {
    expect(() => guard(toolsConfig(sites, false))).not.toThrow();
  });

  it("refuses a config with a remote D1, a remote R2, a remote binding nested anywhere, or --remote's own", () => {
    const local = toolsConfig(sites, false) as { d1_databases: object[]; r2_buckets: object[] };
    expect(() => guard({ ...local, d1_databases: [{ ...local.d1_databases[0], remote: true }] })).toThrow(/remote binding/);
    expect(() => guard({ ...local, r2_buckets: [{ ...local.r2_buckets[0], remote: true }] })).toThrow(/remote binding/);
    expect(() => guard({ ...local, env: { staging: { queues: { producers: [{ binding: "Q", remote: true }] } } } })).toThrow(/remote binding/);
    expect(() => guard(toolsConfig(sites, true))).toThrow(/remote binding/);
  });

  it("ignores remote values that are not true", () => {
    expect(() => guard({ d1_databases: [{ binding: "DB", remote: false }], note: { remote: "true" } })).not.toThrow();
  });

  it("is applied, with remoteBindings: false, by both the local seed and operate.ts (source pin)", () => {
    const seed = readFileSync(resolve(REPO, "apps/sites/dev/seed.ts"), "utf8");
    const operate = readFileSync(resolve(REPO, "apps/sites/e2e/operate.ts"), "utf8");
    expect(seed).toMatch(/if \(!options\.remote\) checkLocalToolsConfig\(\);/);
    expect(seed).toMatch(/options\.remote \? \{\} : \{.*remoteBindings: false/);
    expect(operate).toMatch(/checkLocalToolsConfig\(configPath\);/);
    expect(operate).toMatch(/getPlatformProxy<ToolsEnv>\(\{.*remoteBindings: false/);
    expect(seed.match(/getPlatformProxy<ToolsEnv>/g)).toHaveLength(1);
    expect(operate.match(/getPlatformProxy<ToolsEnv>/g)).toHaveLength(1);
  });
});
