# Plan 3 handoff: AI generation (`@asksite/generation`, `apps/generator`, the model evaluation)

Branch `plan3-generation` (worktree `/Users/ashir/Documents/workk2/asksite-plan3`). Plan:
`docs/superpowers/plans/2026-09-24-plan3-generation.md`. Tasks 1-14 are built, reviewed and verified; Task 15 needs the
user's keys and accounts, and its key-free part is done (section 3).

## 1. State at hand-over

- Main is merged in (`536f21c` "Sync with main", main `1f7e86c` = A12-0 page designs + Plan 2B), then the A12-0
  per-plan change set (`a47f6e9`, `c2742fa`), then the eval lane (`67f8bae` "Merge eval lane") and its A12 commit
  (`af4b117`).
- Checks at the head: `pnpm typecheck` (tsc -p ., e2e, tsconfig.workers.json, apps/sites/e2e) exit 0; canonical
  suite through the heavy-run semaphore: unit 76 files / 3005 tests, workerd 24 files / 516 tests; `pnpm install
  --offline --frozen-lockfile` passes with no lockfile change.
- Task 14 (full verification, at `935195c`): blast radius clean (nothing under site-schema, renderer, core [except the
  one approved line below], site-css, fixtures, mailer, publishing, apps/sites, e2e or scripts); all commits by
  sydashir, 3-word subjects except the recorded exception `07ab926` "Narrow JSON Mode check" (pushed 09-26); no AI
  attribution; secrets scan clean; the generator bundle is 1398 KiB / 244 KiB gzip with 0 `node:` imports and no eval
  code; 33 adversarial payloads refused for the intended rule; 11 mutation checks caught.
- One approved change outside Plan 3's packages: `packages/core/src/limits.ts` `defaultDailyModelLimit` 30 -> 8
  (`9de1f1a`, moderator's explicit exception; only Plan 3's settings read it). The design and plan docs still say 30:
  that is the moderator's docs commit.
- Minor findings from every review are in the worktree's `.superpowers/sdd/deferred-minors.md` (the BACKLOG) for the
  whole-branch review.

## 2. How to run the evaluation (key-free parts are safe; nothing is sent without `--live` and `--max-usd`)

- THE command form is `pnpm --silent eval:generation ...`, with the long `--silent` (pnpm 11.14+ reads `-s` as
  `--sequential` in `pnpm run`; the plain `pnpm eval:generation` echoes the arguments once).
- Keys come only from the environment or the gitignored `.env` at the root of the checkout that runs it; never in
  arguments. `git check-ignore -q .env && echo ENV_IGNORED` must print `ENV_IGNORED`.
- Exit codes, the first that applies: 2 refused flags; 3 a live request cost more than its worst case, or its cost could
  not be counted (even if an error then ended the run); 1 `--caps-probe` could not measure every model, `--record`
  refused a fixture that held a request secret, or an exception ended the run with no overrun; 0 otherwise.
- Ctrl-C ends a live run at once without its report; the spend stays within `--max-usd`.
- A live run sends a request only while the spend so far plus that request's worst case fits under `--max-usd`,
  cheapest model first; an answer without usage counts at its worst case.

Dry-run worst cases (from `pnpm --silent eval:generation --runs 1`, `--caps-probe`, `--record`; key-free, no `.env`):

| Model | Evaluation: per site / 20 sites (`--runs 1`) | `--caps-probe` (1 request) | `--record` (1 request) |
|---|---|---|---|
| workers-ai/gemma-4-26b-a4b-it | $0.028373 / $0.567460 | $0.007077 | $0.009458 |
| groq/gpt-oss-120b | $0.046246 / $0.924920 | $0.010654 | $0.015416 |
| hf-router/gpt-oss-120b:groq | $0.049932 / $0.998640 | $0.010692 | $0.016644 |
| workers-ai/gpt-oss-120b | $0.091932 / $1.838640 | $0.024692 | $0.030644 |
| workers-ai/qwen3.8-27b | $0.173144 / $3.462880 | $0.032320 | $0.057715 |
| claude-sonnet-5 | $0.665760 / $13.315200 | $0.142560 | $0.221920 |
| claude-opus-5-5 | $1.331520 / $26.630400 | $0.285120 | $0.443840 |

### The one live command (the moderator runs it; agents never do)

From the checkout whose root `.env` holds the keys (this worktree, or main after the merge):

```bash
cd /Users/ashir/Documents/workk2/asksite-plan3 && pnpm --silent eval:generation --live --max-usd 1 --runs 1
```

It runs the models whose keys are present, cheapest worst case first, 20 made-up businesses each, and stops before any
request that would take the total over $1.00 (so with only an Anthropic key it runs about 1 Sonnet 5 site; with
Workers AI keys it runs all 20 Gemma sites first). Raise `--max-usd` for a fuller pass; add `--only <label>` to pick
models. Results go to `packages/generation/eval/results/<time>/` (runs.json, summary.json, report.md, ratings.csv,
ratings-key.json).

Before it, per the plan (Task 15 Steps 2 and 4):

```bash
pnpm --silent eval:generation --live --max-usd 1 --caps-probe   # one max-size prompt per model; every line must end OK
pnpm --silent eval:generation --live --max-usd 1 --record       # one real answer per model into test/fixtures/<label>.json
```

`--record` refuses (exit 1, no file written, the rule and header NAME printed, never the value) any answer that holds the
API key, an auth header's value, or a request header name other than accept/content-type/user-agent.

## 3. Task 15: what is done and what is left

Done here (key-free, no key ever used, `--live` never run by an agent): the recorder secret guard (`99d83ad`,
`1155092`); the money-safe daily-limit fallback (`9de1f1a`: a missing or malformed `DAILY_MODEL_LIMIT` gives 8 and logs
`{"event":"generation.config_error","setting":"DAILY_MODEL_LIMIT"}`); the checks (`.env` ignored; the three dry runs;
the `--max-usd` gate, overrun stops and output files proven by `eval-budget.test.ts` and `eval-cli.test.ts` with
fakes; `apps/generator/test/config.test.ts` 14 passed; `pnpm deploy:check` shows `apps/generator` with only the D1
placeholder).

Left (keys, accounts or the user's decisions), in plan order:
1. Step 1 (user): keys into the gitignored root `.env` (Claude Console key with a monthly spend limit; optional Workers
   AI, Groq, Hugging Face).
2. Step 2: the caps probe (above). `OVER THE BOUND` or exit 3: stop and report.
3. Step 3: add `packages/generation/test/recorded.test.ts` (exact text below) in the SAME commit as the recorded
   fixtures (Step 5, "Add recorded responses"), never alone: it fails until fixtures exist.
4. Step 4: `--record` (above), then the plan's `NO_KEYS_IN_FIXTURES` check and `recorded.test.ts`.
5. Step 6: the evaluation; Step 7 (user): blind rating; Step 8 (user): default model through the moderator's one commit
   across apps/generator, apps/app, apps/admin; Step 9: production settings with Plan 2's runbook.

`packages/generation/test/recorded.test.ts` (plan Task 15 Step 3, verbatim; `AI_DRAFT_JSON_SCHEMA` is today
`z.toJSONSchema(AiAnswer)`, the model's answer schema):

```ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RecordedResponse } from "../eval/record.ts";
import { AnthropicProvider } from "../src/providers/anthropic.ts";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.ts";
import { AI_DRAFT_JSON_SCHEMA } from "../src/wire-schema.ts";
import { fakeFetch } from "./support/http.ts";

// Real provider answers recorded in Task 15 with `pnpm eval:generation --record`.
const DIR = new URL("./fixtures/", import.meta.url);
const FILES = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".json")).sort() : [];

describe("recorded live responses", () => {
  it("has at least one", () => {
    expect(FILES.length).toBeGreaterThan(0);
  });

  it.each(FILES)("%s replays through its adapter", async (file) => {
    const recorded = JSON.parse(readFileSync(new URL(file, DIR), "utf8")) as RecordedResponse;
    expect(recorded.status).toBe(200);
    const { fetch } = fakeFetch([{ status: recorded.status, body: recorded.body }]);
    const provider =
      recorded.provider === "anthropic"
        ? new AnthropicProvider({ apiKey: "replay", model: recorded.modelId, fetch })
        : new OpenAICompatibleProvider({ baseUrl: "https://replay.example/v1", apiKey: "replay", model: recorded.modelId, fetch });
    const res = await provider.generate({ system: "s", user: "u", jsonSchema: AI_DRAFT_JSON_SCHEMA, maxOutputTokens: 8192, signal: new AbortController().signal });
    expect(res.stop).toBe("end");
    expect(res.usage.inputTokens).toBeGreaterThan(0);
    expect(res.usage.outputTokens).toBeGreaterThan(0);
    expect(res.json).toEqual(expect.objectContaining({ copy: expect.any(Object), layout: expect.any(Array), theme: expect.any(Object) }));
  });
});
```

(Checked at hand-over: the constructor options match today's adapters, e.g. anthropic.test.ts:65 and record.test.ts, and `fakeFetch` returns `{ fetch }`.)

### Things to measure in the live run (the accumulated Task 15 checklist)

- The Anthropic workspace's `default_inference_geo` must be standard-priced: a US-only geography bills Claude 4.6+ at
  1.1x while the eval prices the global rate (check the workspace, or cap at 1/1.1). Record it in the eval report.
- Both Workers AI `response_format` shapes and how "JSON Mode couldn't be met" returns; `typeof
  choices[0].message.content` per Workers AI model (a plain object: report before accepting); real 429/403 bodies
  (3036 vs 4006, field location); Groq 422 frequency.
- Token counts by TOKENS on the worst fills (U+1D160, private-use U+E000, Hangul U+D7A3/U+AC00, the NFD-expanded text)
  with Anthropic `count_tokens` and each open model's tokenizer: any count above the guard bound goes to the moderator.
- Reasoning: Qwen 3.8 reasoning settings, Gemma thinking default, the thinking share of `max_tokens` cut-offs, output
  tokens <= 8,192 per attempt including reasoning.
- Repair success per stop code (cut_off / refused / incomplete); the `invalid_output` rate per model (P3-16 (B));
  whether 4xx/5xx are ever billed (the 2xx-only usage inference).
- Production D1's UNIQUE constraint error text vs `/UNIQUE constraint failed: generations\.site_id/`.
- Haiku 4.5 retires on or after 2026-10-15.

## 4. For the merge review

- Decisions worth knowing: the lifetime count is option (B) (successes and `invalid_output` failures count; provider
  faults do not), and P3-18 counts a guard refusal after a paid invalid answer as `invalid_output`; the daily model limit
  falls back to 8; the sweeper stops a run after a batch with no successful write and at least one throw, counts
  `errors` once per row, and orders equal ages by `id`; the model answers `AiAnswer` and the server stores `AiDraft`
  with the design from the trade (A12-0); the recorder refuses secret-bearing fixtures.
- Open for the moderator: the 33 claim-checker paraphrases and two known gaps
  (`.superpowers/sdd/claims-paraphrases.md` in this worktree) for the Plan 1 hardening pass; the Task 27 go-live item
  "no wrangler env blocks unless the deploy checks cover each env".
