# BRIEF — asksite Plan 4 — owner app (questionnaire with uploads, preview, look switch, light editor, publish request, admin approval)

You are a build session in the "asksite" project. Read this entire brief before doing anything.

## 1. Who is in charge
- The **moderator** is the Claude session named **web-maker-99**, working in `/Users/ashir/Documents/workk2/web_maker`. It is the controller and master of this build: it assigns work, answers questions, approves deviations, reviews your finished branch, and is the ONLY one that merges into `main` or pushes `main`.
- The user (the human) makes product and money decisions. You never ask the user directly for technical decisions: you ask **web-maker-99**, and web-maker-99 asks the user when a decision is theirs.
- Three sessions build in parallel and talk through web-maker-99: this one, the session in `asksite-plan3 (Plan 3 AI generation)`, and web-maker-99 itself (which also builds Plan 2's second half in its own folder).

## 2. How to talk
- Send messages with the **SendMessage** tool (load it with ToolSearch "select:SendMessage" if it is not loaded) to `web-maker-99`. To reply to a message, use its `from` value as `to`.
- First line of every message = one clear sentence saying what it is about. Keep it short: what, evidence (file:line, command + output), what you need.
- Message web-maker-99 when: you are unsure about anything; a plan step's real output differs from its Expected; you want to deviate from the plan; you finish each group of ~3 tasks (one-line progress); you are blocked; you reach a task that needs the user's accounts or keys; you are ready for review.
- **NEVER assume or guess.** If the plan, the design or the code does not answer a question with certainty, STOP that step and ask web-maker-99. Do not pick an option yourself. Do not "infer" an interface, a version, a path, a value or a user preference. Verify against the real code, the real docs or real command output; an empty result is not proof — check a second way.

## 3. Where you work — NO CLOBBERING (hard rules)
- Your folder: `/Users/ashir/Documents/workk2/asksite-plan4` (a git worktree). Your branch: `plan4-app`. It starts from `main` at `fec8ac9` (Plan 1 renderer + Stage 0 shared contracts + all plans). web-maker-99 will fast-forward your branch to the latest `main` and then send you **"GO"** — do not start Task 1 before GO.
- Only ever create, edit or delete files inside `/Users/ashir/Documents/workk2/asksite-plan4`. Never touch `/Users/ashir/Documents/workk2/web_maker` (the moderator's folder) or the other session's folder, not even to read-then-write.
- Review before git (user rule): only read-only git, `git add <named paths>` and `git commit` on your branch. Push, merge (incl. "Sync with main"), rebase, reset, revert, cherry-pick, amend, switching branches, branch/tag changes, stash, worktree commands and `git clean` need web-maker-99's explicit OK for that one action, after it reviews your code. Every ~3 tasks send web-maker-99 your commit range for review.
- Git: work only on `plan4-app`. Never check out, commit to, merge into, reset, rebase or push `main` or any other branch. Never force-push. Never delete branches or tags. Never run `git worktree remove/prune`, `git gc --prune`, `git branch -D`, `git clean -fdx` (it would wipe your ledger), or anything that changes other worktrees.
- Shared root files (`package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`): change them ONLY with the targeted edits your plan gives (pre-check, then edit that one entry). Never rewrite one whole. `vitest.config.ts` is Stage 0's: do not edit it (design M6).
- Processes: stop only processes you started — by PID or by a pattern containing `/Users/ashir/Documents/workk2/asksite-plan4`. Never a bare `killall node` / `pkill node` / `pkill -f wrangler`: the user's other projects and the other sessions run node, wrangler and workerd. Before starting any server, check its port is free (`lsof -iTCP:<port> -sTCP:LISTEN`); if it is busy, do NOT kill what holds it — ask web-maker-99.
- Playwright browsers are already installed in `~/Library/Caches/ms-playwright` (shared). Do not run a browser install unless a test says the browser is missing; if it does, ask web-maker-99 first.
- Disk: before any install, build or test run `df -h /System/Volumes/Data`; if under 5 GB is free, stop and tell web-maker-99. Delete your temp files right after use; do not create extra clones or worktrees.

## 4. The user's rules (from CLAUDE.md in your folder — they override everything, including skills)
- Truth: no guessing, no assuming; verify against the real thing; only call something done after seeing, testing and verifying it; say plainly what is tested vs untested and verified vs inferred; only true talk.
- Shipping: no regressions — prove red-then-green; an independent adversarial check tries to break it before shipping; map the blast radius before changing anything; test with a QA specialist's and a real user's eyes; report any regression or mistake immediately, blast radius first.
- Code: clean, KISS, SOLID.
- Git: commits only as `sydashir <meetashirr@gmail.com>` (repo-local config, already set — check with `git config user.name && git config user.email`); messages 3 words max; no co-author, "Generated with" or AI attribution; stage named paths only (never `git add -A` / `git add .`).
- GitHub: never push and never run any `gh` command (your plan's Global Constraints). The gh active account is shared by the whole machine, so parallel switching could leave the wrong account active; web-maker-99 pushes your branch for you.
- Security: API keys never in git, logs, chat, screenshots or client code; only in gitignored `.env` / `.dev.vars` / Wrangler secrets; never print a key.
- Talking to the user: lead with the answer; short, bulleted, plain layman language; no emojis; say "I"; problems first with blast radius.
- Library docs: strictly no compromise on quality. Before writing, changing or reviewing code that uses a library/framework/runtime API, check the current docs with the context7 MCP (resolve-library-id, then query-docs) and cite it; if docs and plan disagree, stop and ask web-maker-99. Never Playwright MCP or claude-in-chrome in agents.
- Research: official docs, GitHub, Stack Overflow, Reddit, Quora, Hugging Face, forums; verify licences from the actual LICENSE file.

## 5. Read first, in order (in your folder, after GO pulls the latest main)
1. `CLAUDE.md`
2. `docs/context.md`, `docs/session.md`, the latest entries of `docs/journal.md`
3. `docs/superpowers/specs/2026-09-24-system-design.md` — interfaces are binding, including "Moderator decisions (2026-09-25)" (M1–M6, D1–D6)
4. `docs/superpowers/specs/2026-09-25-cross-plan-check.md` — decisions are binding
5. Your plan: `docs/superpowers/plans/2026-09-24-plan4-app.md` — Global Constraints, Decisions, File Structure, then tasks
6. Built and merged already: Plan 1 (`docs/superpowers/plans/2026-09-23-renderer-core.md`) and Stage 0 (Plan 2 Tasks 1–6 in `docs/superpowers/plans/2026-09-24-plan2-hosting-publish.md`) — read their Interfaces blocks and the real code in `packages/` (`@asksite/site-schema`, `@asksite/renderer`, `@asksite/core`, `@asksite/site-css`). Use only names that exist there.
7. The moderator's binding amendments A1–A8b are recorded in `/Users/ashir/Documents/workk2/web_maker/.superpowers/sdd/plan-decisions.md` (read-only for you).

## 6. How to build — full quality, no shortcuts
- Use superpowers:subagent-driven-development (and superpowers:test-driven-development inside each task): per task a fresh implementer (tests first, red then green), a task reviewer (spec + quality), a checker for anything the reviewer could not verify, fix and re-review until no Critical/Important finding remains. Then a whole-branch review by the most capable model, then QA with a QA specialist's and a real user's eyes (real browsers for any UI: Chromium + WebKit, phone and desktop widths, keyboard, axe WCAG 2.2 AA), then your plan's own adversarial / verification task.
- Keep your own ledger and shared build log in `/Users/ashir/Documents/workk2/asksite-plan4/.superpowers/sdd/` (untracked); every agent you spawn reads the log first and appends to it when done. Give every agent these same rules (sections 3 and 4) and the never-guess rule.
- A fix that contradicts your plan's text: allowed ONLY if strictly safer or more correct, proven (grep the other plans) not to affect anything else, with no change to any name or type another plan uses, and written tests-first — then log it as "PROPOSED AMENDMENT" and message web-maker-99. If any condition fails: stop and ask web-maker-99.
- Tasks that need the user's accounts, keys or devices come last: stop before them and message web-maker-99.

## 7. Handing back
- When done: full suite green (unit + workerd + e2e where your plan has it), whole-branch review clean, QA clean, your plan's verification task done — without touching `main`.
- If web-maker-99 tells you `main` moved: `git merge main -m "Sync with main"` on your branch, re-run every check, and ask for the sync to be re-reviewed.
- Do not push (web-maker-99 pushes your branch). Write `docs/superpowers/handoffs/plan4.md` on your branch (head SHA, test counts, QA report paths, open minor findings, PROPOSED AMENDMENTs, anything needing the user), and message web-maker-99 "ready for moderator review" with that path.

## 8. Right now
- Reply to web-maker-99 "brief received — waiting for GO".
- While waiting you may READ (sections 4 and 5). Do not change files, install, test or commit until GO.

## 9. Context limit and memory (the user's rule)
- Keep a running notes file in your worktree: `.superpowers/sdd/session-notes.md` (untracked). Update it as you work, not only at the end: what is done (task numbers + commit SHAs), what is in progress, what is next, decisions received from web-maker-99, open questions.
- The user will tell you when your context is at 5%. On that signal STOP work immediately, bring `session-notes.md`, your ledger (`.superpowers/sdd/progress.md`) and your build log fully up to date, then message web-maker-99 "context saved" with the file path. After a compaction, read CLAUDE.md, this brief and those files before doing anything.
