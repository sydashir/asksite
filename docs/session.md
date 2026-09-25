# Session handoff

Last updated: 2026-09-23

## Where we are

- Research phase complete. No product code written yet.
- Repo: `github.com/sydashir/asksite` (private). First commit pushed 2026-09-23.
- Rules written to `CLAUDE.md`. Continuity files set up in `docs/`.

## Top open issue

- Scope decided: option C (one niche: US home services & trades; invite-only; no editor; ~3 weeks). Boss informed by the user.

## Speed plan (user 2026-09-25: real users waiting; local first; no hand-made sites; wait for the full tool)

- Critical path: Plan 1 final QA/review/verify (stage C, running) → merge → Stage 0 (= Plan 2 Tasks 1–6: A6 owner-hidden sections, @asksite/core, D1 schema, site-css; run in THIS session right after the merge) → user opens 3 sessions in parallel: Plan 2 Part B (Tasks 7–19), Plan 3, Plan 4, each in its own git worktree.
- Stage 0 must NOT start before Plan 1 merges: it edits the schema and uses Plan 1's golden fixtures, which final QA may still change.
- Cross-plan consistency pass runs as soon as Plan 4's plan is fixed. Moderator decisions M1–M6 appended to the design spec.
- Faster review loop (user 2026-09-25: NO quality compromise): a fixer may apply a plan-deviating fix only if strictly safer, proven to affect no later task (grep of all briefs), no interface change, and tests-first; it is logged as PROPOSED AMENDMENT, re-reviewed like any fix, and ratified by the moderator before merge. Every gate stays: per-task review + fix + re-review, checker for unverifiable items, QA (specialist + real user), whole-branch review, adversarial checks, moderator verification, no-regression rule.

## Parallel planning (started 2026-09-24)

- Run `wf_332cb519-948`: open-model research (`docs/superpowers/specs/2026-09-24-model-options.md`), system design (`docs/superpowers/specs/2026-09-24-system-design.md`) + adversarial design review, then Plans 2 (hosting/publish/leads), 3 (generation, provider-agnostic), 4 (owner app + editor + admin) written in parallel, each execution-checked + security-reviewed + fixed. Output files under `docs/superpowers/plans/2026-09-24-plan{2,3,4}-*.md`. Not committed yet (moderator commits after review).
- User 2026-09-24: speed matters but never at the cost of quality/security/regressions; offered to fire more sessions if needed. Likely use: once plans 2–4 are reviewed, run them in 2–3 separate sessions in parallel with Plan 1, this session moderating.
- User asked about open-source models instead of Claude. Verified 2026-09-24: Cloudflare Workers AI has 10,000 free Neurons/day then $0.011/1k Neurons (Workers Paid needed beyond free), e.g. Llama 3.2 3B $0.051/$0.335 per M tokens, Llama 3.1 70B $0.293/$2.253, Qwen 3 30B $0.051/$0.335; JSON-schema mode on a few models incl. llama-3.3-70b-instruct-fp8-fast, and it can fail with 'JSON Mode couldn't be met'.

## Cross-plan decisions (2026-09-25)

- Cross-plan report: `docs/superpowers/specs/2026-09-25-cross-plan-check.md` (10 mismatches, all fixed in plan text by `wf_10507a13-55d`).
- D1 worstCaseDailyMicrousd number|null; D2 first builds don't count toward the owner's lifetime cap of 20; D3 moderator edits the 3 Workers' AI settings in one commit; D4 Plan 2B runs in this folder on plan2-hosting, Plans 3/4 in worktrees OUTSIDE it: /Users/ashir/Documents/workk2/asksite-plan3 (plan3-generation), /Users/ashir/Documents/workk2/asksite-plan4 (plan4-app); D5 accept report recommendations 5–11; D6 owner-edited sentences stay strict (user confirmed).
- Later (after Stage 0 merges): Plan 1 small amendment from report §2 item 12 (U+200D literal, 'seven days'/'days a week' in round-the-clock pattern, test.slow on slow axe test).

## Decisions pending communication

- Plan 3 (draft) caps AI model calls at 8/day by default so the worst case stays about $10.65/day on Opus 5.5 ($1.33 max per job); the design said 30/day (~$40/day worst case). User decides the model and the daily limit after the model eval. Admin can raise it any time.
- Parallel sessions: each works in its own git worktree + branch; branch syncs with main (merge commit "Sync with main") before review; main fast-forwards. Brief template: `docs/superpowers/briefs/session-brief-template.md`.

- 2026-09-24: user chose look switching + light editor for v1 (~+1 week). Timeline moves from ~3 to ~4 weeks; the user may want to tell the boss.

## Next steps

1. Plan 1 (renderer) EXECUTING, subagent-driven, on branch `plan1-renderer` (user approved 2026-09-23). Moderated stages: A = Tasks 1–7, B = Tasks 8–14 + QA checkpoint, C = Tasks 15–17 + whole-branch review + full QA + Task 18 checks. Moderator (main session) pushes; agents never push or run gh.
   - Process hygiene (user request 2026-09-24): run `.superpowers/sdd/cleanup-orphans.sh` at every stage boundary and whenever the Mac feels slow. It kills only orphaned processes whose command contains this repo or this session's scratchpad path; never other projects' node, never the Claude session. Every agent prompt also requires agents to stop what they started.
   - Recovery: ledger `.superpowers/sdd/progress.md`, shared log `.superpowers/sdd/build-log.md`, briefs/reports in `.superpowers/sdd/`, reusable stage script `~/.claude/projects/-Users-ashir-Documents-workk2-web-maker/072d5ae3-5e24-4502-8d9b-6e9b37ab7404/workflows/scripts/renderer-build-stage-wf_a9eb888e-a28.js` (args: stage, from, to, base, qa, final, fixFirst).
   - Status 2026-09-25: PLAN 1 COMPLETE and MERGED to main. Stage C = Tasks 15–17 (first-round clean) + full QA (r1: 1 Major, WebKit select height → fixed; r2 clean) + whole-branch review (1 promoted Important: hero tagline orphaning on phones → fixed with m5 select overflow; re-review approved) + Task 18 checks (3 adversarial breaks caught). Moderator verified: 557 unit + 138 e2e (34 intentionally skipped), commits clean, looked at hvac page on WebKit 390. STAGE 0 COMPLETE and MERGED to main (7 commits 777eac3..a03d7ff; whole-branch review 0/0; 675 unit + 14 workerd + 138 e2e; Plan 1 goldens byte-identical). Disk: 78 GB free after the user cleared the other project's temp. (Plan 2 Tasks 1–6 on branch plan2-hosting, base main 553adcf; artifacts `.superpowers/sdd/p2-*`; A6 recorded). After it merges: user opens sessions for Plan 2B (Tasks 7–19), Plan 3, Plan 4 in worktrees.
   Then plans 2–4: hosting + publish, AI generation, questionnaire + approval.
2. Repo done. GitHub work: `gh auth switch --user sydashir`, then switch back to `dev778d` after.
3. Domain: deferred by the user (2026-09-23). Reminder when chosen: Public Suffix List review takes weeks, submit early.
4. Accounts, user will provide when asked: Anthropic API key at plan 3 (~$20–50 prepaid credits; Pro/Max subscription cannot be used — Consumer Terms ban automated access except via API key, verified 2026-09-23); Cloudflare account at plan 2 (free plan fits the pilot). Later: Resend, Geoapify. Keys go only in Cloudflare secrets / gitignored `.dev.vars`.
5. Decide the any-niche questionnaire approach.
6. Kick off the build.

## Needed from the user

- Whether these rules should also go into the global `~/.claude/CLAUDE.md` (applies to every project).
