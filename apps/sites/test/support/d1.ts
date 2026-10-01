// D1 wrappers for the lead tests: production-shaped write results, a race in a fixed order, and a meter
// for the rows a batch reads.

/**
 * Production D1: "`results` is empty for write operations such as UPDATE, DELETE, or INSERT"
 * (developers.cloudflare.com/d1/worker-api/prepared-statements/). Local D1 still returns RETURNING rows,
 * so this D1 empties the results of every write in a batch, as production does (A10).
 */
export function writesReturnNoRows(db: D1Database): D1Database {
  const writes = new WeakSet<D1PreparedStatement>();
  const production = {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      if (!/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)) return statement;
      return {
        bind(...values: unknown[]) {
          const bound = statement.bind(...values);
          writes.add(bound);
          return bound;
        },
      };
    },
    async batch(statements: D1PreparedStatement[]) {
      const isWrite = statements.map((statement) => writes.has(statement));
      return (await db.batch(statements)).map((result, i) => (isWrite[i] ? { ...result, results: [] } : result));
    },
  };
  return production as unknown as D1Database;
}

/**
 * A D1 whose batch waits until release(), so a test can land another lead before this one is written:
 * a race in a fixed order (the pattern of packages/publishing/test/versions.workerd.test.ts).
 */
export function holdBatch(db: D1Database) {
  let arrive = () => {};
  let release = () => {};
  const reached = new Promise<void>((done) => (arrive = done));
  const released = new Promise<void>((done) => (release = done));
  const held = {
    prepare: (sql: string) => db.prepare(sql),
    async batch(statements: D1PreparedStatement[]) {
      arrive();
      await released;
      return db.batch(statements);
    },
  };
  return { db: held as unknown as D1Database, reached, release };
}

/**
 * A D1 that adds up the rows its batches read. D1 bills rows read, "the number of rows read (scanned)
 * by this query" (D1Result meta.rows_read, developers.cloudflare.com/d1/worker-api/return-object/).
 */
export function metered(db: D1Database): { db: D1Database; rowsRead: () => number } {
  let rows = 0;
  const counted = {
    prepare: (sql: string) => db.prepare(sql),
    async batch(statements: D1PreparedStatement[]) {
      const results = await db.batch(statements);
      for (const result of results) rows += result.meta.rows_read;
      return results;
    },
  };
  return { db: counted as unknown as D1Database, rowsRead: () => rows };
}
