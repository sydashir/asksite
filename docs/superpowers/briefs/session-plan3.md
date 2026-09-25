# Session brief — asksite-generation

**Paste this whole file as the first message of the new session.** Open the session in the folder `/Users/ashir/Documents/workk2/asksite-plan3` (it will exist once the moderator creates it; see "Start").

You are the build session for **Plan 3 — AI generation (provider-agnostic, validation, retries, cost caps, eval)** of "asksite". Another Claude session, the **moderator** (working in `/Users/ashir/Documents/workk2/web_maker`), coordinates the project, reviews your work, and is the only one that merges into `main` and pushes `main`.

## Start
1. Your folder is a git worktree: `/Users/ashir/Documents/workk2/asksite-plan3` on branch `plan3-generation`, created by the moderator from `main` at commit `<FILLED AT MERGE TIME>` (after Stage 0 merged). Run: `cd /Users/ashir/Documents/workk2/asksite-plan3 && git branch --show-current && git log -1 --oneline` and confirm both.
2. Never work in `/Users/ashir/Documents/workk2/web_maker` or any folder under it (the moderator and Plan 2 run there, and its process-cleanup pattern would match your processes).
3. Git identity: run `git config user.name && git config user.email`; it must print `sydashir` and `meetashirr@gmail.com` (repo-local, shared by worktrees). Stop if not.

## Read first, in order
1. `CLAUDE.md` — the user's rules. They override everything, including skills.
2. `docs/context.md`, `docs/session.md`, the latest `docs/journal.md` entries.
3. `docs/superpowers/specs/2026-09-24-system-design.md` — interfaces are binding, including "Moderator decisions (2026-09-25)" M1–M6.
4. `docs/superpowers/specs/2026-09-25-cross-plan-check.md` — decisions D1–D6 are binding.
5. Your plan: `docs/superpowers/plans/2026-09-24-plan3-generation.md` — Global Constraints, Decisions, then tasks.
6. Plan 1 and Stage 0 (already merged): `docs/superpowers/plans/2026-09-23-renderer-core.md` and `docs/superpowers/plans/2026-09-24-plan2-hosting-publish.md` Tasks 1–6 Interfaces, and the code in `packages/`.

## How to work (no quality compromise)
- Use superpowers:subagent-driven-development: a fresh implementer per task (tests first, red then green), a task reviewer (spec + quality), a checker for anything the reviewer cannot verify, fix and re-review until clean, then a whole-branch review by the most capable model, then QA with a QA specialist's and a real user's eyes, then your plan's adversarial/verification task.
- Keep your own `.superpowers/sdd/` ledger and shared build log inside your worktree (untracked). Every agent reads the log before starting and appends to it when done.
- A fix that contradicts the plan text is allowed only if strictly safer, proven not to affect any other plan (grep them), with no interface change, tests-first; log it as "PROPOSED AMENDMENT" for the moderator. Otherwise stop and ask the moderator.
- Tasks that need the user's accounts or keys come last: stop before them and tell the moderator.

## Hard rules (repeated from CLAUDE.md because they matter most)
- Commits as `sydashir <meetashirr@gmail.com>`, messages 3 words max, no co-author or AI lines, stage named paths only. Never amend, rebase or force-push.
- Never merge into or push `main`. Push only your own branch, with `gh auth switch --user sydashir` right before and `gh auth switch --user dev778d` right after.
- No guessing; verify with real output; no regressions (red then green); adversarial check before handing back.
- LOW DISK: the Mac's disk filled up once. No extra clones or worktrees with installed packages; delete temp files right after use; before any install/test/build run `df -h /System/Volumes/Data` and stop if under 1.5 GB is free.
- Kill only processes you started (by PID or a pattern containing your worktree path); never a bare `killall node`/`pkill node` — the user's other projects run node.
- Secrets only in gitignored `.env` / `.dev.vars` / Wrangler secrets; never print a key.
- Talk to the user in short plain bullets, problems first, no emojis.

## Handing back to the moderator
- When done: full suite green, whole-branch review clean, QA clean, your plan's verification task done (without pushing `main`).
- If `main` moved meanwhile: merge `main` into your branch ("Sync with main"), re-run every check, and get the sync re-reviewed.
- Push your branch, then write `docs/superpowers/handoffs/plan3.md` on your branch with: head SHA, test counts (unit/workerd/e2e), QA report paths, open minor findings, PROPOSED AMENDMENTs, anything needing the user. Tell the user "ready for moderator review".
