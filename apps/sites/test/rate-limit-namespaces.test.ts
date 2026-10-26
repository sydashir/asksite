import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// A rate-limit namespace_id "uniquely defines this rate limiting namespace within your Cloudflare account": two bindings
// with the same id "share counters for a given key", "including across different Workers"; "use a unique namespace_id
// for each binding" (developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/, read 2026-10-21). Every Worker's
// production config is read here, so no new binding can share another's counters by accident.

const APPS = resolve(import.meta.dirname, "../..");
const configs = readdirSync(APPS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => {
    const path = resolve(APPS, entry.name, "wrangler.jsonc");
    try {
      return [{ app: entry.name, config: JSON.parse(readFileSync(path, "utf8")) as { ratelimits?: Array<{ name: string; namespace_id: string }> } }];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  });

describe("rate-limit namespace ids across every Worker", () => {
  it("reads the production config of each app (app, admin, sites, generator)", () => {
    expect(configs.map((c) => c.app).sort()).toEqual(expect.arrayContaining(["admin", "app", "generator", "sites"]));
  });

  it("gives every rate-limit binding its own namespace_id, account-wide", () => {
    const bindings = configs.flatMap((c) => (c.config.ratelimits ?? []).map((r) => ({ id: r.namespace_id, where: `${c.app}:${r.name}` })));
    const seen = new Map<string, string[]>();
    for (const b of bindings) seen.set(b.id, [...(seen.get(b.id) ?? []), b.where]);
    const shared = [...seen.entries()].filter(([, where]) => where.length > 1);
    expect(shared).toEqual([]);
    expect(bindings.length).toBeGreaterThan(0);
  });
});
