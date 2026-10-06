/**
 * D1's transient errors, by message: "Network connection lost", "storage caused object to be reset", "reset because its code
 * was updated" (developers.cloudflare.com/d1/best-practices/retry-queries, the page's own example list).
 */
const RETRYABLE = /network connection lost|storage caused object to be reset|reset because its code was updated/i;

const PAUSE_MS = 250;

/**
 * Runs a D1 write once more when it throws one of D1's transient errors. The page says: "It is useful to retry write queries
 * from your application when you encounter a transient error", and D1 itself retries only read-only queries (release notes,
 * 2025-09-11: "Queries containing any SQLite keyword that leads to database writes are not retried"; it recommends retries "in
 * their own code for queries that are not read-only but are idempotent"). Only for a write whose repeat is safe: the callers'
 * writes are conditional on the row's status, so a second run after one that did commit changes no row. Any other error, and
 * a second failure, propagates unchanged.
 */
export async function retryWriteOnce<T>(run: () => Promise<T>, sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof Error) || !RETRYABLE.test(`${error.message} ${error.cause instanceof Error ? error.cause.message : ""}`)) throw error;
    await sleep(PAUSE_MS);
    return await run();
  }
}
