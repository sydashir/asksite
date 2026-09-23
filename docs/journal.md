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
