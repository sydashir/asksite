import { MAX_INPUT_TOKENS } from "../src/generate.ts";
import { costMicrousd, modelSettings } from "../src/models.ts";

// Money for live eval runs (amendment P3-17), always in whole micro-US$ (1 US$ = 1,000,000). Nothing here calls a
// provider: the budget only decides whether a request may be sent, and counts what it cost.

/** The output cap of the one --caps-probe request per model: its answer is cut short on purpose, only its usage matters. */
export const CAPS_PROBE_OUTPUT_TOKENS = 256;

/**
 * `--max-usd` as whole micro-US$, read without floating point: digits, then optionally a point and one or two more
 * digits, above zero. Anything else is null: 0, a sign, an exponent ("1e3"), three or more decimals, spaces, "NaN",
 * or an amount too large to count exactly.
 */
export function parseMaxUsd(text: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (match === null) return null;
  const micro = BigInt(match[1]!) * 1_000_000n + BigInt((match[2] ?? "").padEnd(2, "0")) * 10_000n;
  return micro > 0n && micro <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(micro) : null;
}

/** Whole micro-US$ as US$, exact to the micro-dollar: 1331520 is "$1.331520". */
export const formatUsd = (micro: number): string => `$${Math.floor(micro / 1_000_000)}.${String(micro % 1_000_000).padStart(6, "0")}`;

/**
 * The most one request to this model can cost: MAX_INPUT_TOKENS in and `outputTokens` out, priced as costMicrousd
 * prices usage. null when the model has no recorded price, so its cost cannot be bounded. (A site of the evaluation,
 * up to MAX_ATTEMPTS requests, is worstCaseJobMicrousd.)
 */
export function requestWorstCaseMicrousd(provider: string, modelId: string, outputTokens: number): number | null {
  return modelSettings(provider, modelId) === undefined ? null : costMicrousd(provider, modelId, { inputTokens: MAX_INPUT_TOKENS, outputTokens });
}

/** What one request cost: `actualMicrousd` from its usage, and whether any of that usage was missing. */
export interface RequestCost {
  actualMicrousd: number;
  usageMissing: boolean;
}

/** Where and why a budget stopped a live run. */
export interface BudgetStop {
  /** The request it stopped at, e.g. "claude-opus-5-5 ord-plumb run 2". */
  at: string;
  /**
   * "budget": its worst case did not fit. "no_price": it has no worst case to check. "over_worst_case": it cost more
   * than its worst case (sent, then the stop), so worst cases no longer bound the run. "invalid_cost": its cost was not
   * a whole number of micro-US$ of at least 0 (sent, counted at its worst case, then the stop).
   */
  reason: "budget" | "no_price" | "over_worst_case" | "invalid_cost";
}

/**
 * Whether a cost is one the budget can count: a whole number of micro-US$ from 0 to Number.MAX_SAFE_INTEGER. Costs are
 * already whole (costMicrousd rounds up), so the budget rounds nothing: NaN, a negative, an infinite, a fractional or
 * a larger cost can only come from a fault, and the budget fails closed on it. A token count is countable on the same
 * terms.
 */
export const countable = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;

/**
 * What `usage` cost, as the budget counts it: costMicrousd, or NaN when a token count is not countable, so the budget
 * fails closed on it even where the price would turn the count into a countable cost (-1 input token and 1,000 output
 * tokens cost 300 micro-US$ on gemma; fix (B)).
 */
export function usageCostMicrousd(provider: string, modelId: string, usage: { inputTokens: number; outputTokens: number }): number {
  return countable(usage.inputTokens) && countable(usage.outputTokens) ? costMicrousd(provider, modelId, usage) : Number.NaN;
}

/** What stands where a cost or a count that cannot be counted would be: the worst case the budget counted instead. */
export const notCountable = (worstMicrousd: number): string => `not countable (counted at its worst case ${formatUsd(worstMicrousd)})`;

/** A request that cost more than its worst case: what was counted for it, against that worst case. */
export interface Overrun {
  at: string;
  countedMicrousd: number;
  worstMicrousd: number;
}

/**
 * The spending cap of one live run (--max-usd). Every request, whether one site of the evaluation or the one
 * --caps-probe or --record request per model, goes through send(), which sends it only when the spend so far plus its
 * worst case is at most the cap. The first request that does not fit stops the budget for good: nothing more is sent,
 * for any model. After a request, what it cost is counted: its actual cost, or its worst case when any of its usage
 * is missing or it threw (the provider may have billed it all the same). While every request costs at most its worst
 * case, the spend never passes the cap. A request that costs more (an overrun) is recorded; by default it also stops
 * the budget (the evaluation). With `stopAfterOverrun: false` (--caps-probe and --record, one request per model) the
 * run goes on, and the next request's check counts the overrun already spent. Either way the spend passes the cap
 * by at most the overrun of the last request sent. The budget fails closed: a cost it cannot count (see countable)
 * counts at the request's worst case and stops the run, and a worst case it cannot count is refused with a
 * RangeError before anything is sent.
 */
export class Budget {
  readonly capMicrousd: number;
  readonly #stopAfterOverrun: boolean;
  #spentMicrousd = 0;
  #stop: BudgetStop | null = null;
  readonly #overruns: Overrun[] = [];

  constructor(capMicrousd: number, { stopAfterOverrun = true }: { stopAfterOverrun?: boolean } = {}) {
    if (!Number.isSafeInteger(capMicrousd) || capMicrousd <= 0) throw new RangeError("A budget is a whole number of micro-US$ above zero");
    this.capMicrousd = capMicrousd;
    this.#stopAfterOverrun = stopAfterOverrun;
  }

  /** Counted so far, including the worst case of a request still in flight. */
  get spentMicrousd(): number {
    return this.#spentMicrousd;
  }

  /** Where and why the budget stopped the run, or null while it has not. */
  get stop(): BudgetStop | null {
    return this.#stop;
  }

  /** Every request that cost more than its worst case, in the order they were sent. */
  get overruns(): readonly Overrun[] {
    return [...this.#overruns];
  }

  /** Sends `request` if its worst case fits (see the class comment); undefined, with nothing sent, when it does not. */
  async send<T>(at: string, worstMicrousd: number | null, request: () => Promise<T>, costOf: (result: T) => RequestCost): Promise<T | undefined> {
    if (this.#stop !== null) return undefined;
    if (worstMicrousd !== null && !countable(worstMicrousd)) throw new RangeError("A worst case is a whole number of micro-US$ of at least 0");
    if (worstMicrousd === null || this.#spentMicrousd + worstMicrousd > this.capMicrousd) {
      this.#stop = { at, reason: worstMicrousd === null ? "no_price" : "budget" };
      return undefined;
    }
    // Held while the request is in flight, so requests sent at once cannot pass the cap together.
    this.#spentMicrousd += worstMicrousd;
    let counted = worstMicrousd;
    try {
      const result = await request();
      const { actualMicrousd, usageMissing } = costOf(result);
      if (!countable(actualMicrousd)) {
        this.#stop ??= { at, reason: "invalid_cost" };
        return result;
      }
      counted = usageMissing ? Math.max(actualMicrousd, worstMicrousd) : actualMicrousd;
      if (counted > worstMicrousd) {
        this.#overruns.push({ at, countedMicrousd: counted, worstMicrousd });
        if (this.#stopAfterOverrun) this.#stop ??= { at, reason: "over_worst_case" };
      }
      return result;
    } finally {
      this.#spentMicrousd += counted - worstMicrousd;
    }
  }
}

/** One line on whether and why the budget stopped a live run. */
export function describeStop(stop: BudgetStop | null): string {
  if (stop === null) return "The budget did not stop the run.";
  if (stop.reason === "budget") return `Stopped for the budget before ${stop.at}: its worst case would have taken the spend over the budget, so nothing more was sent.`;
  if (stop.reason === "no_price") return `Stopped at ${stop.at}: it has no recorded price, so its cost cannot be bounded; nothing more was sent.`;
  if (stop.reason === "invalid_cost") return `Stopped after ${stop.at}: its cost was not a whole number of micro-US$ of at least 0, so it was counted at its worst case; nothing more was sent.`;
  return `Stopped after ${stop.at}: it cost more than its worst case, so the budget can no longer bound the run; nothing more was sent.`;
}
