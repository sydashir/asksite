import { createRequire } from "node:module";
import type { BrowserName, CompatData, CompatStatement, Identifier } from "@mdn/browser-compat-data/types";

// MDN browser-compat-data (CC0-1.0, pinned exactly): only its schema follows semver, so every data
// bump is deliberate and re-runs the fixture test. `require` is the package's documented CommonJS use.
export const bcd = createRequire(import.meta.url)("@mdn/browser-compat-data") as CompatData;

export type Floor = Readonly<Partial<Record<BrowserName, string>>>;

function entryAt(key: string): Identifier | undefined {
  let node: Identifier | undefined = bcd as unknown as Identifier;
  for (const part of key.split(".")) node = node && Object.hasOwn(node, part) ? node[part] : undefined;
  return node;
}

/** The feature entry at a dotted key such as `api.URL.canParse_static`. */
export function compatAt(key: string): CompatStatement | undefined {
  return entryAt(key)?.__compat;
}

/** Whether the key names any entry, with or without its own compat data (e.g. `api.URL`). */
export function hasEntry(key: string): boolean {
  return entryAt(key) !== undefined;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export interface Gap {
  browser: BrowserName;
  added: string;
}

/** The floor's browsers that do not support the feature at their floor version. */
export function gapsAt(compat: CompatStatement, floor: Floor): Gap[] {
  const gaps: Gap[] = [];
  for (const [browser, version] of Object.entries(floor) as [BrowserName, string][]) {
    const raw = compat.support[browser];
    if (raw === undefined) {
      gaps.push({ browser, added: "no data" });
      continue;
    }
    const all = Array.isArray(raw) ? raw : [raw];
    // Only standard statements count: no flag, no prefix, no other name.
    const supported = all.some((s) => {
      if (s.flags || s.prefix || s.alternative_name) return false;
      if (typeof s.version_added !== "string" || s.version_added === "preview") return false;
      // "≤37" means "37 or earlier": read as 37, which can only fail more often.
      if (compareVersions(s.version_added.replace("≤", ""), version) > 0) return false;
      const removed = s.version_removed;
      return removed === undefined || removed === "preview" || compareVersions(removed.replace("≤", ""), version) > 0;
    });
    if (!supported) gaps.push({ browser, added: String(all[0]?.version_added) });
  }
  return gaps;
}
