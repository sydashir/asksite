import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { localStatePath, parseSeedOptions, toolsConfig } from "../dev/seed.ts";

const REPO = resolve(import.meta.dirname, "../../..");

describe("pnpm dev:seed options", () => {
  it("defaults to the local demo site", () => {
    expect(parseSeedOptions([])).toEqual({
      slug: "demo", fixture: "plumber-austin", persistTo: ".wrangler/state", root: "localhost:8789",
      ownerEmail: null, heroPhoto: false, indexable: true, remote: false,
    });
  });

  it("reads the deploy smoke test's options", () => {
    const argv = ["--remote", "--root", "example.com", "--slug", "smoke-test", "--fixture", "cleaning-minimal", "--hero-photo", "--noindex", "--owner-email", "me@example.com"];
    expect(parseSeedOptions(argv)).toEqual({
      slug: "smoke-test", fixture: "cleaning-minimal", persistTo: ".wrangler/state", root: "example.com",
      ownerEmail: "me@example.com", heroPhoto: true, indexable: false, remote: true,
    });
  });

  it("rejects unknown options, missing values and odd fixture names", () => {
    expect(() => parseSeedOptions(["--fast"])).toThrow("Unknown option --fast");
    expect(() => parseSeedOptions(["--slug"])).toThrow("--slug needs a value");
    expect(() => parseSeedOptions(["--fixture", "../etc"])).toThrow("Unknown fixture ../etc");
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
