# Session handoff

Last updated: 2026-09-23

## Where we are

- Research phase complete. No product code written yet.
- Repo: `github.com/sydashir/asksite` (private). First commit pushed 2026-09-23.
- Rules written to `CLAUDE.md`. Continuity files set up in `docs/`.

## Top open issue

- Scope decided: option C (one niche: US home services & trades; invite-only; no editor; ~3 weeks). Boss informed by the user.

## Next steps

1. Plan 1 (renderer) written, reviewed and verified: `docs/superpowers/plans/2026-09-23-renderer-core.md` (18 tasks). Waiting for user approval + execution mode (subagent-driven recommended). Executes on branch `plan1-renderer`. Then plans 2–4: hosting + publish, AI generation, questionnaire + approval.
2. Repo done. GitHub work: `gh auth switch --user sydashir`, then switch back to `dev778d` after.
3. Domain: deferred by the user (2026-09-23). Reminder when chosen: Public Suffix List review takes weeks, submit early.
4. Accounts, user will provide when asked: Anthropic API key at plan 3 (~$20–50 prepaid credits; Pro/Max subscription cannot be used — Consumer Terms ban automated access except via API key, verified 2026-09-23); Cloudflare account at plan 2 (free plan fits the pilot). Later: Resend, Geoapify. Keys go only in Cloudflare secrets / gitignored `.dev.vars`.
5. Decide the any-niche questionnaire approach.
6. Kick off the build.

## Needed from the user

- Whether these rules should also go into the global `~/.claude/CLAUDE.md` (applies to every project).
