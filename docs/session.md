# Session handoff

Last updated: 2026-09-23

## Where we are

- Research phase complete. No product code written yet.
- Repo: `github.com/sydashir/asksite` (private). First commit pushed 2026-09-23.
- Rules written to `CLAUDE.md`. Continuity files set up in `docs/`.

## Top open issue

- **Scope decision needed from the user.** Full scope (any niche, paid self-serve, editor) re-estimated at ~783h / ~20 weeks. The boss was told ~2 weeks MVP. The user must choose a scope before the build starts; see options reported 2026-09-23.

## Next steps

1. User picks scope (full ~20 wk / invite-only pilot ~13 wk / narrower). Then tell the boss.
2. Repo done. GitHub work: `gh auth switch --user sydashir`, then switch back to `dev778d` after.
3. Domain: deferred by the user (2026-09-23). Reminder when chosen: Public Suffix List review takes weeks, submit early.
4. Accounts: Anthropic API (key in `.env` only), Cloudflare (Workers Paid, R2), Resend, Geoapify.
5. Decide the any-niche questionnaire approach.
6. Kick off the build.

## Needed from the user

- Whether these rules should also go into the global `~/.claude/CLAUDE.md` (applies to every project).
