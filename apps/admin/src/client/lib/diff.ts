export interface TextChange {
  path: string;
  before: string | null;
  after: string | null;
}

/** Every string and number in a document, keyed by its dotted path. */
export function flatten(value: unknown, path = "", out = new Map<string, string>()): Map<string, string> {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out.set(path, String(value));
  else if (Array.isArray(value)) value.forEach((item, i) => flatten(item, path === "" ? String(i) : `${path}.${i}`, out));
  else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) flatten(item, path === "" ? key : `${path}.${key}`, out);
  }
  return out;
}

/** What changed between the live document and the one under review (§3.2 step 3), in path order. */
export function textChanges(live: unknown, next: unknown): TextChange[] {
  const before = flatten(live);
  const after = flatten(next);
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  return paths
    .filter((path) => before.get(path) !== after.get(path))
    .map((path) => ({ path, before: before.get(path) ?? null, after: after.get(path) ?? null }));
}
