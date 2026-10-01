import { livePointerKey } from "@asksite/core";

/** What a seam sees of a D1 call: the SQL (a batch: its statements' SQL joined) and how it was run. */
export interface D1Call {
  sql: string;
  method: "run" | "first" | "all" | "batch";
}

interface Watched {
  real: D1PreparedStatement;
  sql: string;
}

/**
 * A D1 that runs `before` ahead of every call (and awaits it), then runs the call on the real database. The seam
 * is where a test runs the competing real function or changes a row, at an exact point of the action under test.
 */
export function watchDb(db: D1Database, before: (call: D1Call) => Promise<void>): D1Database {
  const wrap = (real: D1PreparedStatement, sql: string): D1PreparedStatement & Watched =>
    ({
      real,
      sql,
      bind: (...values: unknown[]) => wrap(real.bind(...values), sql),
      run: async () => (await before({ sql, method: "run" }), real.run()),
      first: async (column?: string) => (await before({ sql, method: "first" }), column === undefined ? real.first() : real.first(column)),
      all: async () => (await before({ sql, method: "all" }), real.all()),
    }) as unknown as D1PreparedStatement & Watched;
  return {
    prepare: (sql: string) => wrap(db.prepare(sql), sql),
    batch: async (statements: Array<D1PreparedStatement & Watched>) => {
      await before({ sql: statements.map((s) => s.sql).join(" ; "), method: "batch" });
      return db.batch(statements.map((s) => s.real));
    },
  } as unknown as D1Database;
}

/** A bucket that runs `before` ahead of every put, delete and list (awaited), recording each call. */
export function watchBucket(
  bucket: R2Bucket,
  before: (call: "put" | "delete" | "list", arg: unknown) => Promise<void> = async () => {},
  calls: Array<{ call: string; arg: unknown }> = [],
): R2Bucket {
  return {
    get: (...args: Parameters<R2Bucket["get"]>) => bucket.get(...args),
    head: (key: string) => bucket.head(key),
    put: async (...args: Parameters<R2Bucket["put"]>) => (calls.push({ call: "put", arg: args[0] }), await before("put", args[0]), bucket.put(...args)),
    delete: async (keys: string | string[]) => (calls.push({ call: "delete", arg: keys }), await before("delete", keys), bucket.delete(keys)),
    list: async (options?: R2ListOptions) => (calls.push({ call: "list", arg: options }), await before("list", options), bucket.list(options)),
  } as unknown as R2Bucket;
}

export const isPointerKey = (slug: string, key: unknown): boolean => key === livePointerKey(slug);
