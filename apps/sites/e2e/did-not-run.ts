import type { FullConfig, FullResult, Reporter, Suite } from "@playwright/test/reporter";

// Fails a run in which a test was scheduled but never started. Playwright reports such tests as "did not run" and
// still exits 0: on 2026-10-08 a teardown chain left all 12 lifecycle tests unrun in a run that passed. A reporter may
// override the run's status, and so its exit code (playwright.dev/docs/api/class-reporter, onEnd). The rule is
// Playwright's own (1.63.0, lastRun.ts didNotRun): skipped with no result, or skipped though not expected to be, and
// not interrupted. --list runs no test, so it is left alone.
export default class DidNotRun implements Reporter {
  #suite: Suite | undefined;

  onBegin(_config: FullConfig, suite: Suite): void {
    this.#suite = suite;
  }

  async onEnd(result: FullResult): Promise<{ status: FullResult["status"] } | undefined> {
    if (process.argv.includes("--list") || result.status === "interrupted") return undefined;
    const missed = (this.#suite?.allTests() ?? []).filter(
      (test) => test.outcome() === "skipped" && !test.results.some((r) => r.status === "interrupted") && (test.results.length === 0 || test.expectedStatus !== "skipped"),
    );
    if (missed.length === 0) return undefined;
    console.error(`did-not-run: ${missed.length} tests did not run, so the run fails. First: ${missed[0]?.titlePath().join(" > ")}`);
    return { status: "failed" };
  }
}
