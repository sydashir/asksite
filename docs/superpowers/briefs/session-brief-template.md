# Session brief — <SESSION NAME> — <PLAN>

You are a build session for "asksite". Another Claude session (the moderator) coordinates the whole project, reviews your work, and is the only one that merges into `main`.

## Where you work
- Your folder (a git worktree): `<WORKTREE PATH>` on branch `<BRANCH>` (created from `main` at `<SHA>`).
- Never work in `/Users/ashir/Documents/workk2/web_maker` (the moderator's folder).

## Read first, in order
1. `CLAUDE.md` — the user's rules. They override everything.
2. `docs/context.md`, `docs/session.md`, the latest `docs/journal.md` entries.
3. `docs/superpowers/specs/2026-09-24-system-design.md` — interfaces are binding.
4. Your plan: `<PLAN PATH>` — Global Constraints, Decisions, then tasks.
5. Plan 1 (already built and merged): `docs/superpowers/plans/2026-09-23-renderer-core.md` Interfaces blocks, and the code in `packages/`.

## How to work
- Execute your plan with superpowers:subagent-driven-development: fresh implementer per task, task review (spec + quality), fix loop, whole-branch review at the end, then QA with a QA specialist's and a real user's eyes.
- Keep your own `.superpowers/sdd/` ledger and shared build log (untracked).
- Tasks that need the user's accounts or keys come last; stop before them and tell the moderator.

## Hard rules (from CLAUDE.md, repeated because they matter most)
- Commits as `sydashir <meetashirr@gmail.com>` (repo-local), messages 3 words max, no co-author/AI lines, stage named paths only.
- Never push to `main`, never merge into `main`. Push your own branch only with `gh auth switch --user sydashir` before and `gh auth switch --user dev778d` after.
- No guessing; verify; no regressions (red-then-green); adversarial check before handing back.
- Kill only processes you started; never a bare `killall node` / `pkill node`.
- Secrets only in gitignored `.env` / `.dev.vars` / Wrangler secrets; never print a key.

## Handing back
- When done: full suite green, whole-branch review clean, QA clean. If `main` moved, merge `main` into your branch ("Sync with main"), re-run everything.
- Tell the moderator: branch, head SHA, test counts, QA report path, open minor findings, anything needing the user.
