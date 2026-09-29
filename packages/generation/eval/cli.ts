// pnpm eval:generation [--runs 3] [--only label,label] [--caps-probe] [--record]
// Runs only with keys in the environment (the gitignored .env at the repo root). Never prints a key.
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ATTEMPT_TIMEOUT_MS, MAX_OUTPUT_TOKENS, REAL_DEPS } from "../src/generate.ts";
import { MAX_INPUT_TOKENS } from "../src/models.ts";
import { buildPrompt } from "../src/prompt.ts";
import { ProviderError } from "../src/provider.ts";
import { createProvider } from "../src/providers/create.ts";
import { AI_DRAFT_JSON_SCHEMA } from "../src/wire-schema.ts";
import { CAPS_REPAIR, CAPS_SNAPSHOT } from "./caps.ts";
import { CANDIDATES, providerEnvFor } from "./candidates.ts";
import { formatReport, summarise } from "./metrics.ts";
import { EVAL_PROFILES } from "./profiles.ts";
import { ratingSheet } from "./ratings.ts";
import { fixtureName, recordingFetch, type RecordedResponse } from "./record.ts";
import { runEval } from "./run.ts";

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "3" },
    only: { type: "string" },
    "caps-probe": { type: "boolean", default: false },
    record: { type: "boolean", default: false },
  },
});

const wanted = values.only?.split(",").map((s) => s.trim());
const available = CANDIDATES.flatMap((candidate) => {
  const env = providerEnvFor(candidate, process.env);
  return env !== null && (wanted === undefined || wanted.includes(candidate.label)) ? [{ candidate, env }] : [];
});

if (available.length === 0) {
  console.log("No model keys found: nothing to run. Put ANTHROPIC_API_KEY, or CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_TOKEN, or GROQ_API_KEY, or HF_TOKEN in the gitignored .env at the repo root.");
  process.exit(0);
}

if (values["caps-probe"]) {
  // One request per model with the largest possible prompt, to check MAX_INPUT_TOKENS against the
  // provider's own token count. The answer is cut short on purpose; only usage matters. One
  // provider's failure is reported and the others are still measured; the run then exits 1.
  let over = false;
  for (const { candidate, env } of available) {
    try {
      const res = await createProvider(env, CAPS_SNAPSHOT).generate({ ...buildPrompt(CAPS_SNAPSHOT, CAPS_REPAIR), jsonSchema: AI_DRAFT_JSON_SCHEMA, maxOutputTokens: 256, signal: AbortSignal.timeout(90_000) });
      const ok = res.usage.inputTokens <= MAX_INPUT_TOKENS;
      over ||= !ok;
      console.log(`${candidate.label}: ${res.usage.inputTokens} input tokens for the caps prompt (bound ${MAX_INPUT_TOKENS}) ${ok ? "OK" : "OVER THE BOUND"}`);
    } catch (error) {
      over = true;
      console.log(`${candidate.label}: ${error instanceof ProviderError ? error.kind : "error"}, not measured`);
    }
  }
  process.exit(over ? 1 : 0);
}

if (values.record) {
  // One live answer per model for an ordinary profile, saved as test/fixtures/<label>.json so the
  // adapters' recorded-response test (test/recorded.test.ts) replays real provider output offline.
  const profile = EVAL_PROFILES.find((p) => p.id === "ord-plumb")!;
  const fixtures = new URL("../test/fixtures/", import.meta.url);
  mkdirSync(fixtures, { recursive: true });
  for (const { candidate, env } of available) {
    const sink: Array<{ status: number; body: unknown }> = [];
    const provider = createProvider(env, profile.snapshot, recordingFetch((input, init) => fetch(input, init), sink));
    try {
      await provider.generate({ ...buildPrompt(profile.snapshot), jsonSchema: AI_DRAFT_JSON_SCHEMA, maxOutputTokens: MAX_OUTPUT_TOKENS, signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS) });
    } catch (error) {
      console.log(`${candidate.label}: ${error instanceof ProviderError ? error.kind : "error"}, nothing recorded`);
      continue;
    }
    const recorded: RecordedResponse = { provider: candidate.provider, modelId: candidate.modelId, ...sink[0]! };
    writeFileSync(new URL(fixtureName(candidate.label), fixtures), `${JSON.stringify(recorded, null, 2)}\n`);
    console.log(`${candidate.label}: recorded test/fixtures/${fixtureName(candidate.label)}`);
  }
  process.exit(0);
}

const runs = Number(values.runs);
if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error("--runs must be a whole number from 1 to 10");

const results = await runEval({
  candidates: available.map(({ candidate, env }) => ({ label: candidate.label, provider: candidate.provider, modelId: candidate.modelId, makeProvider: (snapshot) => createProvider(env, snapshot) })),
  profiles: EVAL_PROFILES,
  runs,
  deps: REAL_DEPS,
  onRun: (done, total) => process.stdout.write(`\r${done}/${total} runs`),
});
process.stdout.write("\n");

const dir = new URL(`./results/${new Date().toISOString().replace(/[:.]/g, "-")}/`, import.meta.url);
mkdirSync(dir, { recursive: true });
const summaries = summarise(results);
const report = formatReport(summaries);
const seed = Date.now() % 1_000_000;
const { csv, key } = ratingSheet(results, seed);
writeFileSync(new URL("runs.json", dir), JSON.stringify(results, null, 2));
writeFileSync(new URL("summary.json", dir), JSON.stringify(summaries, null, 2));
writeFileSync(new URL("report.md", dir), `${report}\n`);
writeFileSync(new URL("ratings.csv", dir), csv);
writeFileSync(new URL("ratings-key.json", dir), JSON.stringify({ seed, key }, null, 2));
console.log(report);
console.log(`\nWrote ${dir.pathname}`);
