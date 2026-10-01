// The draft's facts and brief are unvalidated JSON while the owner types (§2.5), so the forms
// read and write them through these small, total helpers instead of trusting their shape.

import { daysOfEntry } from "./facts-form.ts";

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

/**
 * The id a "fix this" link or hash focuses for an issue. Opening hours are stored in entries (days sharing times) but the
 * form shows one row per day: a time error on entry i targets that entry's first day's field, and every other hours
 * issue (the list, an entry, its days, an entry with no days) targets the "Opening hours" group. `facts` must be the
 * current draft's, not a loaded copy: entries regroup whenever a day's times change.
 */
export function issueTarget(path: Path, facts: unknown): string {
  const [root, key, index, field] = path;
  if (root === "facts" && key === "hours") {
    const day = typeof index === "number" && (field === "opens" || field === "closes") ? daysOfEntry(asRecord(facts)["hours"], index)[0] : undefined;
    return day === undefined ? fieldId(["facts", "hours"]) : `hours-${day}-${field}`;
  }
  return fieldId(path);
}

export function moveItem<T>(items: readonly T[], index: number, by: -1 | 1): T[] {
  const target = index + by;
  if (target < 0 || target >= items.length) return [...items];
  const next = [...items];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item as T);
  return next;
}
