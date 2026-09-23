# Project context

Last updated: 2026-09-23

Status labels used below:
- **[verified]** — confirmed against the primary source or by running it.
- **[research-agent]** — verified by a research subagent during this project; not yet re-run in a build session. Re-verify before relying on it in code.
- **[inferred]** — reasoned from verified facts, not measured.
- **[unverified]** — claimed somewhere, not confirmed.

## Repo

- `github.com/sydashir/asksite`, private, created 2026-09-23. Local folder: `/Users/ashir/Documents/workk2/web_maker`.
- Git identity is repo-local: `sydashir` <meetashirr@gmail.com>.
- This Mac has two GitHub accounts logged in. `dev778d` is the user's other project and normally active — leave it alone. For this repo: `gh auth switch --user sydashir` before GitHub work, `gh auth switch --user dev778d` after. Git's credential helper for github.com is `gh auth git-credential` (checked 2026-09-23), so the active gh account is the one that pushes.
- Repo name is not the product brand; brand and domain are undecided.

## The product

A small business answers a questionnaire. The Claude API returns structured JSON describing their site (which sections, order, all copy, palette, fonts). Our renderer fills pre-built sections with it and produces one static HTML page. The page is uploaded to Cloudflare R2 and served by one Cloudflare Worker that routes by Host header, live at `customer.<our-domain>`. A custom domain is the paid upgrade.

## User decisions (2026-09-23)

- Market: **US**.
- Niche: **any** — whatever the client tells us. Not locked to one vertical.
- Scope: **maximum** — a full-featured tool, no compromise on quality.
- Team: **the user + Claude**. Note: every earlier estimate already assumed "one engineer + Claude Code", so this does not shorten any estimate.
- Engine: Claude API, not Cursor.

## What the boss has been told (2026-09-22)

- The Elementor links he sent will not work (reasons under Rejected).
- We found AstroWind and other reusable pieces.
- MVP in about 2 weeks; fully self-serve about a week after.

**Conflict:** that timeline assumed one niche, no editor, invite-only, manual custom domains. The 2026-09-23 scope (any niche, full-featured, no quality compromise) is larger. A re-estimate is needed before any new number is given to the boss.

## Estimate history

- ~500h / 12–14 weeks — original full product. [inferred]
- 238h / 6 weeks — invite-only pilot, 10 section variants, 3 themes. Three independent estimates: 236, 237, 240h. [research-agent]
- 178h / 4.5 weeks — after scope cuts, corrected by hands-on repo checks. [research-agent]
- 118–133h / ~3 weeks — after the precompiled-stylesheet fix; 4 variants, one niche, no editor. 113h with one variant. [research-agent]

## Architecture (decided)

- **Generation:** Claude Messages API with structured outputs. One call returns JSON. The model never writes raw HTML. API key billing only.
  - Anthropic Commercial Terms permit powering products for our own customers; Consumer Terms forbid automated use of Pro/Max logins. [research-agent, 2026-09-16]
  - Prices on 2026-09-16 per million tokens: Opus 5 $5 in / $25 out; Sonnet 5 $2 / $10; Haiku 4.5 $1 / $5. [verified via claude-api skill + research-agent]
  - Opus 5.5 now exists. Its pricing has not been checked. [unverified]
- **Rendering:** vendored AstroWind section markup, filled by string interpolation. No per-site build.
  - Tailwind compiled **once** across all our sections into one shared stylesheet: 46,223 B raw / 7,874 B gzip. [research-agent]
  - Per-site colours and fonts = 12 CSS variables in an inline `<style>` block; the shared sheet stays identical for everyone. Tested in headless Chrome by a research agent. [research-agent]
  - Per-publish render measured at 0.063 ms. [research-agent]
  - 0 bytes of JavaScript on customer pages (FAQ uses native `<details name>`). [research-agent]
  - Rules: Tailwind `@source` must point at **our** templates; never build class names by string interpolation (variant switches are lookup tables of whole class strings); CI check that fails on class drift.
- **Hosting:** one Cloudflare Worker, Host header → R2 key. Never one deployment per customer.
  - Cloudflare Pages caps at 100 projects/account; Netlify caps at 500 sites/account. [research-agent, 2026-09-16]
  - Free Universal SSL covers first-level subdomains (`customer.domain.com`). [research-agent]
  - Custom domains later via Cloudflare for SaaS: 100 hostnames free, then $0.10/hostname/month, self-serve cap 50,000. [research-agent]
  - Cost ~$0.02–0.03/site/month at 1k sites, ~$0.007 at 100k. [inferred from pricing]
- **Public Suffix List:** submit the root domain as early as possible. Volunteer-reviewed, no SLA, weeks to months. Without it, one customer's subdomain can set cookies read by every other customer's subdomain. [research-agent]

## Parts we take

### AstroWind — `github.com/arthelokyo/astrowind`

MIT, no builder/generator restriction; keep the copyright notice. Checked at commit `14e1a69` (2026-09-12), Astro 7 + Tailwind v4. Bus factor 1, so we **vendor** (copy) the files and never depend on the package. [research-agent]

| Our section | File | Lines | Fix when porting |
|---|---|---|---|
| hero | `widgets/Hero.astro` | 116 | add `text-balance` to `<h1>`; cap actions at 2 |
| services | `widgets/Features2.astro` | 61 | inline the 8-line `getColumnsClass`; never copy `utils.ts` (imports `astrowind:config`) |
| gallery | `widgets/Gallery.astro` | 157 | keep thumbnail `srcset` or the lightbox shows the 400px crop |
| testimonials | `widgets/Testimonials.astro` | 119 | `line-clamp-6` on the quote |
| FAQ | `widgets/FAQs.astro` | 117 | replace `Math.random()` (line 31) with the section id |
| contact | `widgets/Contact.astro` + `ui/Form.astro` | 127 | `Form.astro` line 8 is a bare `<form>` — copy the action/method fix from `Newsletter.astro` lines 56–58; add honeypot and our submit endpoint |
| footer | `widgets/Footer.astro` | 104 | 2 config-coupled lines (3, 37) become props |
| shared | `ui/{Button,Headline,WidgetWrapper}`, `common/{Image (remote branch only), Intersect, StructuredData}`, `CustomStyles.astro` + trimmed `tailwind.css` | ~480 | drop `shadcn.css`, blog prose, `tailwind-merge` |

- Do **not** take `Header.astro` (309 lines of features we don't need). Write ~70 lines.
- **Hours + location section does not exist** in AstroWind or any library checked. Build it (~70 lines, LocalBusiness JSON-LD).
- Headline/subtitle text is protected by `text-balance`/`text-pretty` in `ui/Headline.astro`. Item-level body copy is not — add clamps.
- Theme = 12 CSS variables (9 colour, 3 font) in `CustomStyles.astro`.
- `.agents/skills/use-widgets.md` in the repo (16 files, 1,007 lines) documents how to drive the widgets — most of our prompt spec.
- Its `types.d.ts` (499 lines) is **not** cleanly convertible to JSON Schema (`Omit<>`, `unknown`, index signatures). Define the schema in Zod instead.

### Other pieces

| For | Take | Licence | Status |
|---|---|---|---|
| Extra section variants | HyperUI (`markmead/hyperui`) — ~106 unique files, ~60 page sections | MIT | [research-agent] |
| Theme presets | OpenPage `theme-presets` only (~330 lines); its renderer drops 6 of 19 block types | MIT | [research-agent] |
| AI output schema | Zod + the Anthropic SDK structured-output helper | MIT | helper name to be verified against SDK docs before use |
| Images | sharp + thumbhash, processed at upload | Apache-2.0 / MIT | [research-agent] |
| Static map | Geoapify — only provider found allowing permanent server-side caching | — | caching permission is in their docs, **not their terms** [unverified] — get it in writing |
| Search listing data | schema-dts (types only) | Apache-2.0 | [research-agent] |
| Output checks | html-validate; Playwright + axe-core + linkinator against golden fixtures in CI | MIT / Apache-2.0 / MPL-2.0 (dev only) | [research-agent] |
| Questionnaire | react-hook-form + zod, own stepper | MIT | [research-agent] |
| Slug blocklist | the-big-username-blacklist + reserved-usernames + obscenity, plus our own ~200 brand names | MIT | [research-agent] |
| Contact email | Resend | service | pricing [unverified] |
| Bot/spam | Cloudflare Turnstile + Workers Rate Limiting | service | Turnstile reportedly caps near ~200 hostnames on the free tier [research-agent] |

## Rejected, with reasons

- **Elementor / elementor-jsx** (`Algorismus-io/elementor-jsx`, exjsx.dev) — no static HTML output; needs a WordPress install + database + server per customer; hosting $1–5/site/month vs ~1¢; Elementor's KB: "Can I include Elementor Pro in my Theme / Hosting / DIY service?" → "No"; free Elementor forms don't submit; repo 48 days old, 1 star, 1 contributor; npm `latest` 2.1.1 silently destroys page styling when a second page is deployed; all three links are from the same author. Estimated 9–11 weeks. [research-agent, 2026-09-21]
- **Licences that ban use in a site builder:** Float UI, TailGrids, Cruip (also no LICENSE file), Preline Pro + Preline "Fair Use" attribution rider, Flowbite Blocks/Pro, OpenTailwind, HTML5 UP (CC BY 3.0), daisyUI paid templates, ScrewFast (depends on Preline). [research-agent]
- **Copyleft / restrictive / no licence:** Webstudio, Silex, Formbricks, OpnForm, HeyForm (AGPL); Typebot (FSL); Plasmic Studio (AGPL); dub, unkey (AGPL); vercel/platforms (no licence — read only). [research-agent]
- **Not a fork base:** bolt.diy, Open Lovable, llamacoder, Dyad, Onlook — chat-driven code sandboxes emitting React that needs a server per customer. [research-agent]
- **Meraki UI** — stale; contact inputs missing `name` attributes. [research-agent]
- **Cursor** as engine — no published per-run pricing for its Cloud Agents API; Beta; ToS permission only via forum posts. [research-agent, 2026-09-16]
- **Agent loop for generation** — 15–30x more expensive and 30–100x slower than one structured call for a one-page site. [research-agent]

## Questionnaire (current draft)

Required (8), four per screen:
1. What is your business called?
2. What kind of business is this? (routes layout, section order, imagery)
3. Your top 3–5 services (owner-typed, never invented)
4. Where are you based?
5. What makes you different? (becomes the headline, 140-char cap)
6. What should visitors do? (call / book / quote / order / visit)
7. How should it sound?
8. How can customers reach you? (email required, phone optional)

Nice to add: logo, brand colours (with "choose for me"), photos, years in business + solo/team, opening hours, prices shown or "get a quote", real reviews (pasted or from Google), social links. Free-text box: "Pretend you're texting a friend who's building this site for you. What do you tell them so they don't mess it up?"

After first preview: pick from 3 headlines, pick from 3 looks, swap photos, add FAQ, reorder/hide sections, connect own domain.

Open: "any niche" means the fixed per-vertical modules in the old plan no longer fit. Approach undecided.

## Risks to design for (US)

- **Editor** — generate-only is the #1 churn risk. Hocoos (quiz → site) shut down in 2026; Wix retired its questionnaire builder ADI in Nov 2024. [research-agent]
- **ADA / accessibility** — 5,000+ US website accessibility suits in 2025. FTC fined accessiBe $1M for claiming automated ADA compliance — never market "ADA compliant". [research-agent]
- **Fake facts** — services, prices, credentials and testimonials must be owner-entered, never generated. FTC fake-review rule: up to $53,088 per violation. [research-agent]
- **Abuse / phishing** — free subdomains attract phishing; one flagged subdomain can block the whole domain in Chrome. Needs PSL, pre-publish scanning, noindex until verified, abuse mailbox, fast takedown. [research-agent]
- **SEO** — Google Site Reputation Abuse policy: "subdomains aren't a safe harbor". Custom domains are the real SEO upgrade. [research-agent]
- **Cost** — uncapped "regenerate" can blow the AI budget; hard per-user caps from day one. [research-agent]
- **AI images** are not copyrightable; prefer wordmark logos and licensed stock or customer photos. [research-agent]

## Open questions

- Domain name — not chosen. Needed early (DNS, PSL lead time).
- Current model lineup and pricing (Opus 5.5) for the generation engine.
- Geoapify caching permission in their legal terms.
- Resend pricing and limits.
- Any-niche questionnaire approach.
- Full-scope estimate.

## Where the detail lives

- Research workflow journals (full agent outputs): `~/.claude/projects/-Users-ashir-Documents-workk2-web-maker/072d5ae3-5e24-4502-8d9b-6e9b37ab7404/subagents/workflows/`
  - `wf_6e79bd26-63c` — 4–6 week compression estimates
  - `wf_2823c282-b59` — Elementor / elementor-jsx assessment
  - `wf_039d288b-e1f` — open-source sweep
  - `wf_f03268d0-500` — hands-on repo verification
  - `wf_862f5375-e18` — parts list and precompiled-stylesheet test
- Proposal sent to the boss: `AI-Website-Generator-Proposal.docx` (repo root).
- Temporary files (may be wiped): `/private/tmp/claude-502/-Users-ashir-Documents-workk2-web-maker/072d5ae3-5e24-4502-8d9b-6e9b37ab7404/scratchpad/` — `build_docx.py`, `mock-q.html`, `mock-site.html`.
