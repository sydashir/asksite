// The draft's facts and brief are unvalidated JSON while the owner types (§2.5), so the forms
// read and write them through these small, total helpers instead of trusting their shape.

export type Path = ReadonlyArray<string | number>;
export type Json = Record<string, unknown>;

export const asRecord = (value: unknown): Json => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {});
export const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const asString = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");

export function getIn(value: unknown, path: Path): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

/** A copy of `value` with `path` set; `undefined` removes the key (optional facts are left out, not null). */
export function setIn(value: unknown, path: Path, next: unknown): unknown {
  const [key, ...rest] = path;
  if (key === undefined) return next;
  if (typeof key === "number") {
    const array = [...asArray(value)];
    array[key] = setIn(array[key], rest, next);
    return array;
  }
  const record = { ...asRecord(value) };
  const child = setIn(record[key], rest, next);
  if (child === undefined) delete record[key];
  else record[key] = child;
  return record;
}

/** A dotted id for a field, used for <label for> and error-summary links: ["services", 0, "name"] -> "f-services-0-name". */
export const fieldId = (path: Path): string => `f-${path.join("-")}`;

export function moveItem<T>(items: readonly T[], index: number, by: -1 | 1): T[] {
  const target = index + by;
  if (target < 0 || target >= items.length) return [...items];
  const next = [...items];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item as T);
  return next;
}
