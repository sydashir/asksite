# Session handoff

Last updated: 2026-09-23

## Where we are

- Research phase complete. No product code written yet.
- Repo: `github.com/sydashir/asksite` (private). First commit pushed 2026-09-23.
- Rules written to `CLAUDE.md`. Continuity files set up in `docs/`.

## Top open issue

- Scope decided: option C (one niche: US home services & trades; invite-only; no editor; ~3 weeks). Boss informed by the user.

## Parallel planning (started 2026-09-24)

- Run `wf_332cb519-948`: open-model research (`docs/superpowers/specs/2026-09-24-model-options.md`), system design (`docs/superpowers/specs/2026-09-24-system-design.md`) + adversarial design review, then Plans 2 (hosting/publish/leads), 3 (generation, provider-agnostic), 4 (owner app + editor + admin) written in parallel, each execution-checked + security-reviewed + fixed. Output files under `docs/superpowers/plans/2026-09-24-plan{2,3,4}-*.md`. Not committed yet (moderator commits after review).
- User 2026-09-24: speed matters but never at the cost of quality/security/regressions; offered to fire more sessions if needed. Likely use: once plans 2–4 are reviewed, run them in 2–3 separate sessions in parallel with Plan 1, this session moderating.
- User asked about open-source models instead of Claude. Verified 2026-09-24: Cloudflare Workers AI has 10,000 free Neurons/day then $0.011/1k Neurons (Workers Paid needed beyond free), e.g. Llama 3.2 3B $0.051/$0.335 per M tokens, Llama 3.1 70B $0.293/$2.253, Qwen 3 30B $0.051/$0.335; JSON-schema mode on a few models incl. llama-3.3-70b-instruct-fp8-fast, and it can fail with 'JSON Mode couldn't be met'.

## Decisions pending communication

- 2026-09-24: user chose look switching + light editor for v1 (~+1 week). Timeline moves from ~3 to ~4 weeks; the user may want to tell the boss.

## Next steps

1. Plan 1 (renderer) EXECUTING, subagent-driven, on branch `plan1-renderer` (user approved 2026-09-23). Moderated stages: A = Tasks 1–7, B = Tasks 8–14 + QA checkpoint, C = Tasks 15–17 + whole-branch review + full QA + Task 18 checks. Moderator (main session) pushes; agents never push or run gh.
   - Process hygiene (user request 2026-09-24): run `.superpowers/sdd/cleanup-orphans.sh` at every stage boundary and whenever the Mac feels slow. It kills only orphaned processes whose command contains this repo or this session's scratchpad path; never other projects' node, never the Claude session. Every agent prompt also requires agents to stop what they started.
   - Recovery: ledger `.superpowers/sdd/progress.md`, shared log `.superpowers/sdd/build-log.md`, briefs/reports in `.superpowers/sdd/`, reusable stage script `~/.claude/projects/-Users-ashir-Documents-workk2-web-maker/072d5ae3-5e24-4502-8d9b-6e9b37ab7404/workflows/scripts/renderer-build-stage-wf_a9eb888e-a28.js` (args: stage, from, to, base, qa, final, fixFirst).
   - Status 2026-09-24: STAGE A DONE (Tasks 1–7, pushed c2120d2). A5 security hardening: 3 rounds of fix + review + adversarial attack (wf_7940cd65-e5b) — code judged correct at ad05b42 (tracker follows the WHATWG tokenizer; 0 unsafe disagreements vs parse5 in 500k+ fuzz; all attack payloads blocked); 2 remaining TEST gaps (4 corpus shapes + array threading) being closed with mutant proof in wf_a3136427-716. Then: moderator verifies, fast-forward merge to main, push, start stage B.
   Then plans 2–4: hosting + publish, AI generation, questionnaire + approval.
2. Repo done. GitHub work: `gh auth switch --user sydashir`, then switch back to `dev778d` after.
3. Domain: deferred by the user (2026-09-23). Reminder when chosen: Public Suffix List review takes weeks, submit early.
4. Accounts, user will provide when asked: Anthropic API key at plan 3 (~$20–50 prepaid credits; Pro/Max subscription cannot be used — Consumer Terms ban automated access except via API key, verified 2026-09-23); Cloudflare account at plan 2 (free plan fits the pilot). Later: Resend, Geoapify. Keys go only in Cloudflare secrets / gitignored `.dev.vars`.
5. Decide the any-niche questionnaire approach.
6. Kick off the build.

## Needed from the user

- Whether these rules should also go into the global `~/.claude/CLAUDE.md` (applies to every project).
