# Model options for AI copy generation (Plan 3)

Date: 2026-09-24. Research only; no code, no accounts, no API keys used.
Labels: **[verified]** = I read it on the official page, in the model's LICENSE file, in a provider's public API, or ran it myself on 2026-09-24. **[vendor]** = the model maker's own benchmark. **[inferred]** = my reasoning from verified facts. **[unverified]** = third-party or not checked.

## The short answer

- **Yes, open models can do this, and there is nothing to deploy.** Several open models under Apache-2.0 or MIT licences are sold as pay-per-token APIs. We send one HTTPS request, the same way we would call Claude. Cloudflare Workers AI, which we already use for hosting, serves them. [verified]
- **"Free" means the licence is free, not the computing.** The free tiers (Cloudflare's 10,000 "neurons" a day, which covers about 12 to 90 sites a day depending on the model; Groq's free plan; OpenRouter's `:free` models) are enough for the eval and the 25-site pilot. They are not a base for a paid product: they have rate caps, no service guarantee, and some free routes let the provider keep and train on our prompts. [verified limits; conclusion inferred]
- **Cost does not decide this.** At 1,000 sites a month the bill is about $32 on Claude Sonnet 5, $64 on Opus 5.5 and under $10 on open models. That is a saving of tens of dollars a month. [inferred from verified prices]
- **Quality is the real risk, and only our own test can measure it.** The providers guarantee at most the *shape* of the JSON. None of the ones I checked promises to enforce our real rules: length caps, no digits, and no claims the owner's facts don't back. Claude's docs say outright that length and regex constraints are unsupported. Our Zod validators and retries enforce those, whichever model we use. So the question is how often a model passes on the first try and how good the wording is. No public benchmark measures that. Run the eval in section 7.
- **Self-hosting is not worth it.** A GPU server that runs 24/7 costs about $250 to $2,100 a month, and we would need two of them for redundancy, plus our own time running them. All that saves tens of dollars. This Mac can't do it either. It runs on the CPU only, and a 7B model took 14 minutes for one site; that output also broke our rules, with "since 2009", "$149" and "24/7" (section 3, measured).
- **Recommendation:** build one `CopyGenerator` interface with two adapters. One calls Anthropic. The other calls any "OpenAI-compatible" API, which covers Cloudflare, Groq, Together, OpenRouter, Hugging Face, and a self-hosted vLLM or llama.cpp server if we ever run one. **Keep Claude as the default** until an open model matches it in the eval. The first open models to try are gpt-oss-120b, Gemma 4 26B A4B and Qwen3.8-27B, all on Cloudflare Workers AI.

## 1. Candidate open models and their licences

I read each licence in the model's LICENSE file (Hugging Face or GitHub). Where a repo has no LICENSE file, I note what I read instead.

| Model (maker, HF release) | Size: total / active params | Licence | Commercial use for us | Hosted on (as of 2026-09-24) |
|---|---|---|---|---|
| **gpt-oss-120b** (OpenAI, 2025-08) | 117B / 5.1B (MoE) | Apache-2.0, plus a one-line usage policy: "comply with all applicable law" | Yes | Cloudflare, Groq, Together, OpenRouter, 11 HF providers |
| gpt-oss-20b (OpenAI, 2025-08) | 21B / 3.6B | Apache-2.0 | Yes | Cloudflare, Groq |
| **Gemma 4 26B A4B-it** (Google, 2026-03) | 25.2B / 3.8B (MoE) | Apache-2.0. The repo has no LICENSE file; the card links Google's "Gemma 4 license" page, which is the Apache 2.0 text | Yes | Cloudflare, OpenRouter (also free), HF |
| Gemma 4 31B-it (Google, 2026-03) | 30.7B dense | Apache-2.0 (same page) | Yes | Together, OpenRouter (also free), HF |
| **Qwen3.8-27B** (Alibaba, 2026-08) | 27B dense | Apache-2.0 | Yes | Cloudflare, Groq (preview), OpenRouter (also free), HF |
| DeepSeek-V4-Flash (DeepSeek, 2026-04) | 284B / 13B (MoE) | MIT | Yes | Cloudflare (paid plan only), Together, OpenRouter, HF |
| GLM-5.3-Flash (Z.ai, 2026-08) | 320B / 18B (MoE) | MIT | Yes | Cloudflare (paid plan only), Together, OpenRouter, HF |
| Mistral Small 4 (Mistral, 2026-03) | 119B / about 6B (MoE) | Apache-2.0 (the model card says so; the repo has no LICENSE file) | Yes | Mistral's own API [unverified]; not in the HF router list |
| Llama 3.3 70B / Llama 4 Scout (Meta, 2024-12 / 2025-04) | 70B dense / 17B active, 16 experts | Llama Community Licence | Yes under 700M monthly users, but we must "prominently display 'Built with Llama'" and follow Meta's use policy | Cloudflare, others |
| Kimi K2.6 (Moonshot, 2026-04) | large MoE | "Modified MIT": must display "Kimi K2.6" only above 100M monthly users or $20M monthly revenue | Yes | Cloudflare ($0.95 / $4 per M, too pricey) |

- Meta's newest Llama on Hugging Face is still Llama 4 (April 2025). Web articles about 2026 Llama releases don't match anything on HF, so I ignored them. [verified HF listing; articles unverified]
- Several "open" models are not candidates for us. Qwen3.8-Flash-Next and Qwen3.8-2.4T are tagged `license:other`, and Mistral Medium 3.5 is `license:other`. [verified HF tags]
- I drop Llama. The licence adds an attribution duty, the models are old, and they score low on instruction following (section 5). [inferred]

## 2. Hosted inference: no deployment by us

All of these accept an OpenAI-style `chat/completions` request, so one adapter can call any of them. [verified: Cloudflare docs page "OpenAI compatible API endpoints"; HF router at `router.huggingface.co/v1`; Groq; Together; OpenRouter]

| Provider | Free tier [verified] | Paid pricing model [verified] | JSON-schema mode [verified] | Data use [verified] |
|---|---|---|---|---|
| **Cloudflare Workers AI** | 10,000 neurons a day on the Free and Paid plans, reset 00:00 UTC | $0.011 per 1,000 neurons above that (Workers Paid, $5 a month minimum). DeepSeek-V4-Flash and GLM-5.3-Flash need Workers Paid | `response_format: json_schema` is in the input schema for gpt-oss-120b, Gemma 4 26B, Qwen3.8-27B, DeepSeek-V4-Flash, GLM-5.3-Flash and Llama 3.3 70B. Mistral Small 3.1 takes a `guided_json` field instead. The JSON Mode page says it "can't guarantee" schema compliance, lists only 6 older models, and doesn't support streaming | Doesn't use customer content to train models |
| **Groq** | Free plan for gpt-oss-120b: 30 requests a minute, 1K a day, 8K tokens a minute, 200K tokens a day, so about 25 sites a day at 8K tokens each [inferred] | Per token (table below). Developer plan for higher limits | `strict: true` (guaranteed schema) only for gpt-oss-20b, gpt-oss-120b and Qwen3.8-27B | Keeps no inference data by default. Zero-retention option available (console.groq.com/docs/your-data). No training: Groq Services Agreement §4.2, "Groq is not permitted to use Inputs or Outputs for training or fine-tuning any AI Model Services or other models, unless explicitly granted permission or instructed by Customer" (last modified 2026-06-22) |
| **Hugging Face Inference Providers** | $0.10 of credit a month on a free account, $2 on PRO | Provider's price passed through, "no markup". Pay-as-you-go after buying credits | Flagged per provider in the router's public model list. For gpt-oss-120b, 8 of 11 providers | Depends on the provider behind the route |
| **Together AI** | "does not currently offer free trials". $5 minimum credit purchase | Per token | Per model: the HF router flags gpt-oss-120b yes, DeepSeek-V4-Flash and GLM-5.3-Flash no | Not checked |
| **OpenRouter** | `:free` models: 20 requests a minute, 50 a day (1,000 a day after $10 of lifetime purchases). Free now: Qwen3.8-27B, Gemma 4 26B/31B and others | Per token, listed per model (fees on credit purchases not checked) | Per-model `structured_outputs` flag in the public API | The free Gemma routes run on Google AI Studio's unpaid tier. Google's terms: "Human reviewers may read, annotate, and process your API input and output" and "Do not submit ... personal information". **Don't send real owner data to free routes.** |

The HF router lists different prices for the same model. gpt-oss-120b runs from $0.037 / $0.17 (DeepInfra) to $0.35 / $0.75 (Cerebras) per million tokens. The router lists Groq at $0.15 / $0.75, but Groq's own docs say $0.15 / $0.60; I used Groq's own figure. [verified, 2026-09-24]

## 3. Self-hosting

**What it takes** [inferred]: a GPU server, vLLM or llama.cpp's server with the weights loaded, an authenticated endpoint the Worker can reach (TLS, for example through a Cloudflare Tunnel), monitoring, security patches, model upgrades, and a second server or an API fallback so a crash doesn't stop sign-ups.

**One real advantage** [verified docs; value inferred]: llama.cpp and vLLM can enforce `maxLength` and regex `pattern` while the model is writing. That could ban digits, `@` and currency symbols before they appear. Hosted Claude can't: its structured outputs don't support `minLength`, `maxLength`, `maxItems` or `pattern`. Whether hosted open-model providers pass `pattern` through to their decoder is untested [unverified]; the eval can check it. Banned *words* still need our validator either way.

**Hardware** [verified model cards; the rest inferred]: gpt-oss-120b "fits into a single 80GB GPU". gpt-oss-20b runs "within 16GB of memory". Gemma 4 26B and Qwen3.8-27B at 4-bit quantisation need a 24 to 48 GB GPU.

| RunPod on-demand, 730 h a month [verified 2026-09-24 prices] | Per hour | Per month, one server |
|---|---|---|
| RTX 4090 24 GB (Gemma 4 26B / Qwen3.8-27B, 4-bit) | $0.34 to $0.74 | $248 to $540 |
| L40S 48 GB | $0.79 to $1.09 | $577 to $796 |
| H100 80 GB PCIe (gpt-oss-120b) | $1.99 to $2.89 | $1,453 to $2,110 |

- **Break-even** [inferred]: one L40S at $577 a month equals about 18,000 sites a month on Claude Sonnet 5, or about 480,000 sites a month on Gemma 4 through Cloudflare. At our volume, self-hosting never pays.
- **This Mac** [verified]: Intel Core i7-9750H, 16 GB RAM, AMD Radeon Pro 5300M 4 GB. Ollama 0.13.1 was already running here with `qwen2.5:7b` (Q4_K_M) installed, and it ran on the CPU only (`size_vram: 0`). I ran our real validators against it (results below). A laptop also sleeps, sits behind a home connection and has no backup, so it's no good for 24/7 customers. It is fine for offline prompt experiments.

**Smoke test on this Mac** [verified, 2026-09-24]. Setup: a script in the scratchpad (`smoke/smoke.mjs`), our real `SiteDocument` validators, and the JSON schema generated from `Copy`, sent as Ollama's `format`. The test business was a plumber (Austin) with a licence, insurance, 24/7 emergency and free estimates.
- **Speed:** one site took **861 s (14 min 21 s)**. The prompt ran at 1.36 tokens a second (720 tokens) and the output at 1.17 tokens a second (374 tokens). An earlier attempt was cut off at the 300 s HTTP timeout.
- **JSON shape:** valid, as the schema forced it to be.
- **Rules:** it **failed 4 validator checks**. It copied facts out of the input: "since 2009" in the about text, "Starting at $149" in a service description, and "24/7 service" in an FAQ answer. The prompt forbade all three. Our validators caught every one.
- **Caveats:** this is one run of a small 2024 model, not one of the candidates above, so it says nothing about how gpt-oss-120b or Gemma 4 would do. It does show two things: forcing the JSON shape doesn't make a model follow the rules, and this Mac is far too slow to serve customers, who would wait minutes, not seconds [inferred]. I stopped the run after the first business; the other two were never run.

## 4. Claude API, for comparison

[verified] The official pricing page (read live on 2026-09-24) and OpenRouter's public catalogue agree. Anthropic gives new accounts "a small amount of free credits", with no ongoing free tier:

| Model | Input / output per M tokens | Batch (50% off) | Cache hit |
|---|---|---|---|
| Opus 5.5 | $4 / $20 | $2 / $10 | $0.20 |
| Sonnet 5 | $2 / $10 (the introductory price "is now the standard price") | $1 / $5 | $0.20 |
| Haiku 4.5 | $1 / $5 | $0.50 / $2.50 | $0.10 |

- Structured outputs are generally available on all three and use constrained decoding: "Always valid", "No retries needed for schema violations". They don't support `minLength`/`maxLength`, `maxItems`, `minItems` above 1, or regex `pattern`. So our length and content rules are enforced by our validator and retry here too. [verified docs]
- Claude 4.7 and later models use a newer tokenizer that "produces approximately 30% more tokens for the same text" [verified]. I assume that covers Opus 5.5 and Sonnet 5 [inferred]. Thinking can't be turned off on Opus 5.5 [research-agent, docs/context.md], which adds output tokens.

## 5. Quality risk for our strict rules (honest view)

- **JSON shape: solved almost everywhere.** It's guaranteed on Claude and on Groq's strict mode, and best-effort on Cloudflare. JSONSchemaBench (arXiv 2501.10868) found constrained decoding "achieves higher performance than the unconstrained setting", so forcing JSON doesn't hurt quality. Known breakages: gpt-oss structured output doesn't work in LM Studio (GitHub issue lmstudio-bug-tracker #1105, open since 2025-10-13). A Groq community thread reported gpt-oss-120b ignoring `json_schema` [unverified: the forum now redirects]. The eval must count JSON failures for each provider.
- **Our rules are the hard part.** Length caps, "no digits, currency, @ or links", Latin script only, the banned words (bonded, since, five-star, guaranteed, same-day, quoted reviews...), claims allowed only with a fact behind them, and one description per service in order. A model has to *obey the prompt* for these; the decoder can't force them. The best public proxy is instruction-following with checkable constraints (IFBench):

| Model | IFBench | Source |
|---|---|---|
| Qwen3.8-27B | 79.5 (the same table gives "Opus4.6 Max" 62.5) | [vendor] Qwen model card |
| Gemma 4 31B | 76% | Artificial Analysis article, 2026-04-06 [verified article] |
| Gemma 4 26B A4B / gpt-oss-120b / gpt-oss-20b | 72.4 / 69.0 / 65.1 | AA-IFBench via benchlm.ai [unverified aggregator] |
| Mistral Small 4 / Llama 4 Maverick / Llama 4 Scout | 48.2 / 43.0 / 39.5 | same [unverified] |
| Claude Opus 5.5 / Sonnet 5 / Haiku 4.5 | not listed | none found |

- **The risk that matters most** [inferred]: our claim checker matches word lists. It "catches the usual phrasings, not every paraphrase" (claims.ts). A weaker model is more likely to copy the owner's boasts ("20 years", "24/7", "best in town") or paraphrase around the list. That forces more retries or puts a false claim on the approval screen, where a human has to catch it. That legal risk (FTC, see docs/context.md) is worth more than the $30 a month an open model saves.
- **Copy quality for US trades**: no benchmark measures it. Small and mid-size models tend towards generic filler ("your trusted partner for all your needs") [inferred]. Only a blind human rating can tell.

## 6. Cost per site

Assumes about 6k input and 2k output tokens and one attempt. Retries and reasoning tokens (billed as output) can multiply this up to about 3x [inferred]. The free-tier column assumes a stable ~6k-token prompt.

| Option | Per M in / out | Per site | 25-site pilot | 1,000 sites a month | Free tier covers |
|---|---|---|---|---|---|
| Claude Opus 5.5 | $4 / $20 | $0.064 | $1.60 | $64 | none |
| Claude Sonnet 5 | $2 / $10 | $0.032 | $0.80 | $32 | none |
| Claude Haiku 4.5 | $1 / $5 | $0.016 | $0.40 | $16 | none |
| gpt-oss-120b, Cloudflare | $0.35 / $0.75 | $0.0036 | $0.09 | $3.60 | ~30 sites a day (327 neurons each) |
| gpt-oss-120b, Groq | $0.15 / $0.60 | $0.0021 | $0.05 | $2.10 | ~25 sites a day (free plan) |
| Gemma 4 26B A4B, Cloudflare | $0.10 / $0.30 | $0.0012 | $0.03 | $1.20 | ~90 sites a day (109 neurons each) |
| Qwen3.8-27B, Cloudflare | $0.45 / $3.20 | $0.0091 | $0.23 | $9.10 | ~12 sites a day (827 neurons each) |
| DeepSeek-V4-Flash, OpenRouter | $0.087 / $0.174 | $0.0009 | $0.02 | $0.87 | none (Together is cheap too, at $0.14 / $0.28, but not flagged for structured output) |
| Self-hosted GPU, 24/7, times 2 for redundancy | fixed | n/a | $500 to $4,200 a month | same | n/a |

## 7. Recommendation

**Build this, provider-neutral** [inferred design, KISS]:
- Use `CopyGenerator.generate(facts, notes) -> { copy, usage, model, attempts }` with two adapters. `AnthropicAdapter` uses the Messages API with structured outputs. `OpenAICompatibleAdapter` takes a base URL, a key and a model, and sends `response_format: json_schema` built with `z.toJSONSchema(Copy)`. I tested that this conversion works on our schema: 1,304 bytes, and `maxLength` is kept.
- The prompt, the JSON schema and the validation (`SiteDocument.safeParse`) are shared by every adapter. On failure, retry up to 2 times and send the validator's messages back to the model. After that, hand it to a human. The provider and model live in config, so switching is a config change plus an eval run.
- Keys go only in `.dev.vars` or Worker secrets. Real owner data is never sent to a free route that may train on it (section 2).

**Default: Claude.** Quality comes first, and the 25-site pilot costs a few dollars at most on any model, even with retries. The eval also decides Opus 5.5 vs Sonnet 5.

**Open candidates for the eval:** gpt-oss-120b on Cloudflare with reasoning "low" (Groq strict mode as a second host), Gemma 4 26B A4B on Cloudflare (cheapest, best free-tier coverage), and Qwen3.8-27B on Cloudflare with thinking off (best vendor-reported IFBench). Optional: Gemma 4 31B via OpenRouter or HF, and DeepSeek-V4-Flash via OpenRouter, with the route pinned to a provider flagged for structured output.

**Eval (run before Plan 3's model choice is locked):**
1. **Inputs:** 20 made-up but realistic businesses across the 6 trades, identical for every model:
   - 6 trap profiles with no licence, insurance, emergency or free-estimate flags, whose owner notes still say "24/7", "20 years", "best prices", "free quotes";
   - 4 edge profiles: 12 services, 40-character names, a single service, a Spanish business name;
   - 10 ordinary profiles.
2. **Runs:** 3 per business per model (60 calls per model), with the same prompt and validators.
3. **Automatic measures:** first-try pass rate, pass rate within 2 retries, which rule failed, p50/p95 latency, and cost per *passing* site.
4. **Human rating:** 2 people rate every passing output blind (model hidden, order shuffled), 1 to 5 each on "sounds like a real local tradesperson", "specific to these services" and "owner would publish without edits". Plus yes/no: "states anything not in the facts". That last question also measures what our claim checker misses, which matters for every model.
5. **Gate (proposed):** an open model becomes the default only if (a) at least 95% of runs pass within 2 retries and at least 80% pass first time, (b) no human finds an unbacked claim, and (c) its mean human score is within 0.3 of Claude's. Otherwise it stays as a fallback for when Claude is down.
6. **Eval cost:** about 300 to 400 calls, roughly $6 to $20 at list prices depending on retries, mostly for Opus [inferred]. It needs a Cloudflare API token, an Anthropic key and optionally a Groq or OpenRouter key.

## Sources (read 2026-09-24 unless stated)

- Cloudflare: developers.cloudflare.com/workers-ai/platform/pricing/ ; /workers-ai/features/json-mode/ ; /workers-ai/models/<id>/sync-input.json (the `response_format` schema for each model) ; /workers-ai/platform/limits/ ; /workers-ai/configuration/open-ai-compatibility/ ; /workers-ai/platform/data-usage/ ; /workers/platform/pricing/
- Groq: console.groq.com/docs/models ; /docs/rate-limits ; /docs/structured-outputs ; /docs/your-data
- Hugging Face: huggingface.co/docs/inference-providers/pricing ; router.huggingface.co/v1/models (public JSON) ; model repos and LICENSE files: openai/gpt-oss-120b, Qwen/Qwen3.8-27B, deepseek-ai/DeepSeek-V4-Flash, zai-org/GLM-5.3-Flash, moonshotai/Kimi-K2.6, google/gemma-4-26B-A4B-it (+ ai.google.dev/gemma/docs/gemma_4_license), mistralai/Mistral-Small-4-119B-2603 ; Llama licences: github.com/meta-llama/llama-models models/llama3_3/LICENSE and models/llama4/LICENSE
- Together: together.ai/pricing ; docs.together.ai/docs/billing
- OpenRouter: openrouter.ai/docs/api-reference/limits ; openrouter.ai/api/v1/models and /models/<id>/endpoints (public JSON) ; Google AI Studio unpaid terms: ai.google.dev/gemini-api/terms
- Anthropic: platform.claude.com/docs/en/about-claude/pricing (live) ; platform.claude.com/docs/en/build-with-claude/structured-outputs
- RunPod: runpod.io/pricing. Hetzner GPU prices wouldn't load without JavaScript, so they're not used.
- Quality: arxiv.org/abs/2501.10868 (JSONSchemaBench) ; artificialanalysis.ai/articles/gemma-4-everything-you-need-to-know ; benchlm.ai/benchmarks/aaIfBench [unverified aggregator] ; github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1105
- llama.cpp: tools/server/README.md and grammars/README.md ; vLLM: docs/features/structured_outputs.md
