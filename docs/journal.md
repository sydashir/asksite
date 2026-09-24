# Journal

Append-only. Newest at the bottom.

## 2026-09-16 — Initial research

- Five parallel research agents: competitors, generation engine (Claude vs Cursor), questionnaire design, hosting/subdomains, risks.
- Findings: the questionnaire → site → subdomain mechanic is crowded; Hocoos (closest analog) shut down 2026; Wix retired ADI 2024. Real gap: structured intake feeding real generation with vertical depth.
- Engine: Claude API with structured output into our own renderer. Cursor rejected (no published per-run pricing, Beta).
- Hosting: one Cloudflare Worker + R2, routed by Host header. Never one deployment per customer.
- Published a feasibility brief as an Artifact. It was deleted server-side right after publishing; the link is dead.
- Built a 2-page proposal. HTML → PDF → the user needed .docx; the PDF re-flowed badly when opened in another app. Final: `AI-Website-Generator-Proposal.docx`, built with python-docx, mockups embedded as images. Sent to the boss.
- Timeline compression: three independent estimates for a 4–6 week pilot came back at 236, 237 and 240 hours → 6 weeks.

## 2026-09-21 — Boss pushback

- Boss said 6 weeks is too long and sent: `github.com/Algorismus-io/elementor-jsx`, `exjsx.dev`, and a LinkedIn post.
- Assessment (repo cloned, tests run, deploy source read): rejected. Needs WordPress per customer, breaks hosting economics, Elementor Pro licence forbids our use, young single-author project with a data-loss bug. 9–11 weeks if used.
- Open-source sweep found AstroWind (MIT). First estimate with it: 3.5 weeks.

## 2026-09-22 — Hands-on verification and parts list

- Correction: hands-on checks showed the 3.5-week figure relied on overstated claims (AstroWind saving ~6h not 14h; OpenPage mostly unusable). Revised to 4.5 weeks.
- Then the precompiled-stylesheet approach was tested: compile Tailwind once, publish by string interpolation, zero JS. This removed the build step. Revised to ~3 weeks (118–133h), 2.8 weeks with one visual variant.
- YouTube: nothing worth watching (AstroWind videos are outdated, top one 2,445 views).
- Messages drafted for the boss: links won't work + reasons; AstroWind and other free pieces; MVP in about 2 weeks, fully self-serve about a week after. The user sent a version of this.

## 2026-09-23 — Kickoff decisions and rules

- User answers: market US; niche any (client-specified); scope maximum, full-featured, no quality compromise; team = the user + Claude.
- Flagged: these answers exceed the scope behind the ~2-week figure given to the boss. Full-scope re-estimate started.
- Rules written to `CLAUDE.md`. Created `docs/context.md`, `docs/session.md`, `docs/journal.md`, and `.gitignore` for secrets.
- User created `github.com/sydashir/asksite` (private). Folder initialised as a git repo with repo-local identity `sydashir` <meetashirr@gmail.com>. Found the active gh account is `dev778d`; pushed with sydashir's token for that command only. Domain deferred.
- User rule: use sydashir for this project via `gh auth switch`, never touch dev778d. Added to CLAUDE.md; switch back to dev778d after each GitHub operation.
- Full-scope re-estimate done (`wf_dde65daa-3f3`): 583 / 713 / 769h from three estimators, reconciled to ~783h / ~20 weeks. Recommended any-niche approach: capabilities, not verticals. Verified Opus 5.5 pricing myself from the saved pricing page ($4/$20, cache $0.20). An agent's browser left a `.playwright-mcp/` folder in the project; it deleted it and I confirmed the folder and git status are clean.
- User chose option C and told the boss. Launch niche: US home services & trades. Started Plan 1 (renderer). Local toolchain: Node 25.6.1, pnpm 10.33.0, npm 11.9.0, Intel Mac (x86_64), Chrome installed, wrangler not installed.

## 2026-09-23 — Plan 1 (renderer) written

- Workflow `wf_da9a655f-d4c`: 3 researchers (AstroWind source, tooling verified by running it, US trades content), 1 drafter, 2 adversarial reviewers (one executed the plan in scratch), 1 fixer. 28 findings: 26 fixed, 2 rejected with reasons (noindex handled by plan 2 Worker header; CI workflow deferred to plan 2).
- Plan: 18 tasks, 17 commits, 306 unit tests, 148 browser tests. Pinned: TypeScript 7.0.2, Zod 4.6.5, Tailwind 4.3.3, Vitest 5.0.1, html-validate 11.16.0, Playwright 1.63.0, @axe-core/playwright 4.13.0 (all matched `npm view` today).
- My own checks: plan format, no placeholders, all commit messages 3 words, no `git add -A`, gh switch steps present. Ran the agents' replayed code: typecheck clean, 306/306 unit tests, 124 browser tests passed + 24 intentionally skipped. Measured 0px sideways overflow at 390 and 320px in Chromium and WebKit. A first phone screenshot looked clipped — that was my headless-Chrome screenshot method (minimum window width), not the page; confirmed with Playwright.
- Rule breaks by agents: two made git commits in throwaway scratch repos (never pushed; project repo untouched). An agent left the active gh account on `sydashir`; found and restored to `dev778d`. Deleted 30 leftover `asksite-render-*` temp folders from agent test runs.
- Open UX notes: fixture hero photo is a generic sea image (not trades); phone first screen shows three call buttons (header, hero, sticky bar) — deliberate for conversion, revisit with real users.

## 2026-09-23 — Plan 1 execution, stage A

- User approved subagent-driven execution, then asked for rigorous QA, shared context for all agents, and the main session as moderator. Stopped the first run (partial Task 1, no commits), cleaned it, relaunched in 3 moderated stages with a shared build log every agent reads and writes, plus two QA gates (QA specialist + real user).
- User rule added to CLAUDE.md: shut down dev servers, no orphan processes. Added a safety line: kill only this project's processes (the user's dmchat-tg node servers were running; a bare `killall node` would have killed them).
- Tasks 1–2 complete and reviewed. Task 3 stopped after 3 review rounds on a plan gap: AI-copy check missed numerals/currency written in other scripts ("五百元"). Reproduced myself. Decision (amendment A1): AI copy is Latin-script only; owner facts unaffected. Checked the plan has no non-Latin letters, so nothing downstream depends on it.
- The gh active account was found on sydashir twice. Traced it: the user's other Claude session QA-district-Tool runs `gh auth switch --user sydashir` and does not switch back. No build agent ran gh. Restored dev778d. User decision: keep using `gh auth switch` around pushes.
- 2026-09-24: Task 3 approved after the A1 fix (`a5e3265 Restrict copy script`). Moderator check: 69/69 tests, typecheck clean, rule blocks 五百元 / Cyrillic / hidden Cyrillic letters and accepts café, dashes, curly quotes, emoji. Committed CLAUDE.md process rule + docs on the branch; backup push of `plan1-renderer`.
- 2026-09-24: Task 4 stopped after 3 review rounds: claim checker missed double spaces and special hyphens ("Same  day", "Five‐star", 8 bypasses) and falsely blocked "Hassle‑free". Reproduced myself. Decided as moderator: A2 (normalise before matching) and A3 (ratify review extras: quoted-phrase rule, hidden-character check, owner hero photo can't be hidden). Relaunched Task 4 fix + Tasks 5–7.
- 2026-09-24: Task 4 approved (3f9e833..928d89c). Moderator check: 206/206 tests, typecheck clean, all 8 separator bypasses now caught, Hassle-free allowed, em-dash 'free' still caught. Build stopped only because a checker filed a non-defect note as a gap; tightened the checker definition in the stage script. Started Tasks 5–7.
- 2026-09-24: Task 5 stopped after 3 review rounds: the html template could be bypassed by nesting templates (dangerous link/click-handler could pass). Not used anywhere yet (blast radius 0, checked by grep of every later brief). Decided A4: harden the template (only trusted() fragments between attributes, fail closed on unknown/unfinished attributes, no interpolation inside literal style/script, track single quotes, lock SafeUrl constructor). Relaunched Task 5 fix + Tasks 6–7.
- 2026-09-24: Stage A complete (Tasks 1–7). Verified: 318/318 tests, typecheck clean, all commits sydashir/3 words/no trailers, only packages + lockfile touched. Pushed c2120d2 to GitHub (explicit commit, not the moving branch tip). Reviewer found the A4 hardening regressed 4 malformed-literal cases + tag-name via trusted(); reproduced all 5 live myself; exposure 0 (no brief uses those shapes). Decided A5: spec-following tracker + differential test vs parse5 + adversarial attacker. Running.
- 2026-09-24: User described the intended owner flow (questionnaire + comments + images → recommended look → preview → edit → ship). Current v1 (option C) had no editor. User chose: look switching + light editor (edit wording, swap photos, hide/reorder sections) in v1, ~+1 week. Owner still publishes through human approval. Goes into a later plan; Plan 1 unaffected except a future additive schema flag for owner-hidden sections.
- 2026-09-24: A5 ran 3 rounds (fix → reviewer + attacker in parallel). Round 1 attacker found a latent SVG-animation gap (fixed); round 2 reviewer found a comment look-ahead edge (fixed); round 3: attacker approved, reviewer left 2 Important TEST gaps (5 one-line mutants survive the suite). Code correct. Closing the gaps with mutant-killing tests. User rule added: fast-forward merge to main after each stage passes review + moderator checks + QA.
