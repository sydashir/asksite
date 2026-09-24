# Hosting, Publish and Leads (Plan 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put approved pages on the internet safely: the shared contracts every later plan codes against (Stage 0), the publish pipeline that turns an owner's document into exact reviewed bytes and makes only admin-approved bytes live, the public Cloudflare Worker that serves `<slug>.<root>`, photos and contact forms, lead emails, one-command local development, CI, and a deploy runbook, all testable locally with no account or key.

**Architecture:** Part A (Stage 0, design §11.3) adds `@asksite/core` (ids, tokens, host parsing, schemas, `composeDocument`, API types), the D1 migration, `@asksite/site-css` (the compiled stylesheet as a module) and Plan 1 amendment A6 (owner-hidden sections). Part B adds `@asksite/mailer` (Resend or a local outbox table), `@asksite/publishing` (conditional D1 batches plus R2 copies: pending version → approve → live, reject, withdraw, takedown, restore, search-engine switch) and the `asksite-sites` Worker, which routes by Host header, lets D1 decide what is served while R2 only holds bytes, caches per data centre for 60 s (photos 300 s at the edge), and stores and emails contact-form leads. Everything runs in workerd locally through wrangler's `createTestHarness` (Vitest) and `wrangler dev` over https (Playwright + axe).

**Tech Stack:** Node 24.21.0 LTS or 25.6.1, pnpm 10.33.0 workspaces, TypeScript 7.0.2, Zod 4.6.5, wrangler 4.138.0 (workerd 1.20260921.1, Miniflare 5.20260921.1-alpha), @cloudflare/workers-types 5.20260924.1, Vitest 5.0.1, Playwright 1.63.0, @axe-core/playwright 4.13.0, Cloudflare Workers + D1 + R2 + Workers Rate Limiting + Cache API, Resend's HTTP API.

## Global Constraints

- TDD red-then-green: write the failing test, run it and watch it fail for the stated reason, then write the implementation and watch it pass. Never skip the red run.
- KISS and SOLID. One responsibility per file. Clean code; no framework in the Worker (the whole router is one `switch`).
- No regressions: Plan 1's golden files and browser tests must stay unchanged. Every task says how it proves that.
- Commit messages are 3 words maximum. No `Co-Authored-By`, no "Generated with", no AI attribution of any kind. Commits are made as the repo-local identity `sydashir` <meetashirr@gmail.com> (already configured; never change global git config).
- Stage named paths only (`git add <paths>`). Never `git add -A` or `git add .`. The moderating session's uncommitted edits under `docs/` stay unstaged; every git check that must ignore them uses the pathspec `-- . ':(exclude)docs'`.
- No pushes and no `gh` commands in this plan: the moderator pushes (after `gh auth switch --user sydashir`, and `gh auth switch --user dev778d` afterwards). Never log out, delete or change the `dev778d` account.
- Never commit secrets (`.env`, `.env.*`, `.dev.vars`, `*.pem`, `*.key`). Secrets live only in `wrangler secret put` or the gitignored `.dev.vars`; `.dev.vars.example` holds names and development-only values; a key is never printed, logged, pasted into chat or put in `vars` (design §9.1 "Secrets").
- Exact dependency versions, checked with `npm view` on 2026-09-24: `wrangler` 4.138.0, `@cloudflare/workers-types` 5.20260924.1, plus Plan 1's pins (`typescript` 7.0.2, `vitest` 5.0.1, `zod` 4.6.5, `@playwright/test` 1.63.0, `@axe-core/playwright` 4.13.0, `@types/node` 24.13.6), package manager `pnpm@10.33.0`. Never use `^` or `~` ranges. Do not add `@cloudflare/vitest-pool-workers` (0.22.0 needs `vitest ^4.1.0`; design §10.2).
- Node: `engines` `>=24.8.0`, `.nvmrc` 24.21.0; every command below was replayed on the Mac's default Node 25.6.1.
- Every Worker: `"compatibility_date": "2026-09-21"`, no `nodejs_compat`, `"workers_dev": false`, `"preview_urls": false`, `"observability": { "enabled": true, "logs": { "invocation_logs": false } }` (design §1.1, §1.2).
- The approval rule is enforced by bindings: `asksite-sites` binds only `DB`, `LIVE` and `MEDIA` (read-only; a test fails on any `put` or `delete`), and `FORM_RL`; it never binds `WORK`. Only `asksite-admin` writes `LIVE` (design §0.2, §1.2).
- D1 decides what is served; R2 only holds bytes. Everything except an approved, indexable page is sent with `X-Robots-Tag: noindex` (design §0.2, §7.4).
- Logs hold IDs and error codes only: never tokens, emails, IPs, lead content or keys. Raw IPs are never stored (`hashIp` with the secret `IP_HASH_KEY`). The lead email goes only to the owner's verified login email (design §1.2, §7.5, §9.1).
- WCAG 2.2 AA: every fixed page (404, 503, 429, 413/415, 400, thank-you, apex) passes axe (serious/critical WCAG 2.2 AA plus the structure rules) and reflows at 320 px (design §7.5, §9.2).
- Everything is testable locally without accounts or keys (`createTestHarness`, `wrangler dev`, fakes). Only Task 19 needs the user's Cloudflare and Resend accounts.
- Process hygiene (CLAUDE.md): stop every process you start. Never run a bare `killall node` or `pkill node` (the user's other projects run on node); stop by PID or by an exact pattern containing this repo's path, e.g. `pkill -f "/Users/ashir/Documents/workk2/web_maker/"`. After every task that starts `wrangler`, run the **leftover check** below; it must print `nothing left running`. It looks for this repo's path in any command line (wrangler and workerd from `node_modules`), and for `scripts/dev.ts`, `wrangler` or `workerd` processes whose working folder is this repo (`pnpm dev` and `node scripts/dev.ts` run with relative paths, so a path search alone misses them). Processes of another folder (another session's `pnpm dev`) are not listed and must be left alone. `pnpm dev` and the sites browser tests use fixed ports (8789, inspector 9239): two sessions cannot run either at the same time.

```bash
{ pgrep -fl "/Users/ashir/Documents/workk2/web_maker/"
  for p in $(pgrep -f "scripts/dev.ts|wrangler|workerd"); do
    [ "$(lsof -a -p "$p" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')" = "/Users/ashir/Documents/workk2/web_maker" ] && ps -o pid=,command= -p "$p"
  done; } | sort -u | grep . || echo "nothing left running"
```

- Shared root files (`package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `pnpm-workspace.yaml`) are never rewritten whole after Stage 0: Plans 3 and 4 edit them in parallel, and a full rewrite would silently drop their entries. Every later change is a targeted edit (`pnpm add`, `npm pkg set`, an appended block, or "replace this line"), each with a pre-check that prints what is there now. If a pre-check prints something other than the stated value, another plan changed that entry: make the same change by hand, keeping their part. Stage 0 (Tasks 1–6) may write a root file whole only after checking that it is still Plan 1's version (no other plan has started then). Task 18 checks that no other plan's line was lost.
- Do not use the Playwright MCP browser tools. Playwright runs only from this repo's dev dependencies.
- Label factual claims [verified] (checked against the official page or by running it), [inferred] or [unverified].
- Every `wrangler.jsonc` is plain JSON (no comments): `pnpm dev`, the config tests and `pnpm deploy:check` read it with `JSON.parse`.
- Every test that starts workerd (through `createTestHarness`) is named `*.workerd.test.ts`; `pnpm test` runs the `unit` Vitest project first and the `workerd` project after it (Decision 23).
- A Worker's main module exports only its handlers (workerd refuses any other named export) [verified: `Uncaught TypeError: Incorrect type for map entry 'PROBE_FORM_ACTION'`].
- Classes use explicit fields, never constructor parameter properties: the repo's `tsconfig.json` sets `erasableSyntaxOnly` [verified: `error TS1294: This syntax is not allowed when 'erasableSyntaxOnly' is enabled`].

## Decisions made while writing this plan

Each was checked in a scratch replay of this plan on top of the real Plan 1 code (items 1–23: Tasks 1–14 as committed on `plan1-renderer` at `24441ed`, Tasks 15–17 from Plan 1's own replay; items 24–33 and the final replay: `plan1-renderer` at `77f01b6`, Plan 1 Tasks 1–17 as committed). The design (`docs/superpowers/specs/2026-09-24-system-design.md`) is the contract; items 2–6, 9, 10, 13 and 15 differ from or add to its text and need the moderator's nod; item 22 records how this plan meets the Plan 3 draft; item 23 is a regression fix found by the replay. Items 24–33 come from the execution check and the security/spec review of this plan (2026-09-24); 24, 25, 28, 29 and 31 change the design's text or another plan's and need the moderator's nod.

1. **Stage 0 is Part A of this plan** (design §11.3 "written as Plan 2 Part A; executed first"). Tasks 1–6 are Stage 0; Tasks 7–19 are Plan 2. Plans 3 and 4 code against Part A's exports exactly as the design lists them.
2. **Error classes use explicit fields.** The design writes `constructor(readonly code: …)` for `MailerError`, `PublishError` (and Plan 3's `ProviderError`). That syntax fails `tsc` under the repo's `erasableSyntaxOnly` [verified]. The classes here declare `readonly code` (and `readonly detail?`) as fields: the public shape is the design's. Plan 3 needs the same change for `ProviderError`.
3. **`restore` also takes `ROOT_DOMAIN`.** Its contract returns `{ liveUrl }`, which cannot be built from `{ DB, LIVE, WORK }`. The env parameter is `{ DB, LIVE, WORK, MEDIA, ROOT_DOMAIN }` (`MEDIA` since Decision 29); the admin Worker has all five (design §10.3), so Plan 4 passes `env`.
4. **Each Worker's `Env` is written by hand** (design §10.3 says "generated by `wrangler types`"). `wrangler types` emits a global `interface Env` plus `Cloudflare.GlobalProps.mainModule`, which clash when two Workers share a TypeScript program, and it reads secret names from the gitignored `.dev.vars`, so its output differs between machines [verified with `wrangler types --include-runtime=false --strict-vars=false` with and without `.dev.vars`]. `apps/sites/test/config.test.ts` proves the hand-written `Env` lists exactly the config's bindings, variables and secrets.
5. **Worker-side code is type-checked by a second program, `tsconfig.workers.json`** (Node and Workers runtime types together); the root `tsconfig.json` excludes `packages/mailer`, `packages/publishing` and `apps/sites`. Adding `@cloudflare/workers-types` to the root program breaks Plan 1's `scripts/render-fixture.ts` [verified: `Type 'URL' is not assignable to type 'import("url").URL'`], because the Workers global `URL` replaces Node's. Files in the Workers program must not import `fixtures/index.ts` (same clash); they read fixture JSON by path. See Decision 22 for how this meets Plan 3's approach.
6. **`pnpm dev` runs a generated `apps/<name>/wrangler.dev.jsonc`: the production config minus `routes`.** With routes present, `wrangler dev` rewrites every request's Host to the route's zone (`asksite.example`), which breaks Host routing locally [verified: `curl https://joes.localhost:8799/` reached the Worker as `host: asksite.example`]. `createTestHarness` does not rewrite (it sets `inferOriginFromRoutes: false`) [verified]. The generated files are gitignored.
7. **Photos are cached 5 minutes at the edge with `s-maxage=300`.** The design asked which directive the Cache API honours: it "respects … Cache-Control … consistent with Cloudflare Cache-Control Directives", and for Cloudflare `s-maxage` "overrides the maximum age specified by either the max-age directive or the Expires header field" in shared caches [verified: developers.cloudflare.com/workers/runtime-apis/cache/ and /cache/concepts/cache-control/]. Photos send `public, max-age=86400, s-maxage=300`. The 5-minute takedown proof itself needs the real edge: Task 19 Step 11.
8. **No HSTS for a localhost root.** With `includeSubDomains`, HSTS from `https://localhost:8789/` would force https onto every local project on this Mac (browsers key HSTS by host, not port) [inferred]. Production sends HSTS on every HTML response.
9. **`SECURITY_TXT_EXPIRES` is a variable of `asksite-sites`** (not in the design's §10.3 table). The design says "set at build time"; there is no build step, so the deploy task sets it and `pnpm deploy:check` refuses a date outside 30–366 days ahead. security.txt is not served at all if the value is not a date.
10. **`createPendingVersion` re-parses its input and stores the parsed form**, so `document_sha256` always matches `documentSha256` of the parsed draft whatever the caller passes. Its D1 batch acts only while the site still belongs to the owner, still has the rendered slug and is not taken down; otherwise it throws `site_taken_down`, or `integrity` with `detail: { reason: "site_changed" }` (for example the slug changed between render and write, which would make the page's form action point at the wrong host).
11. **Audit rows are written with `INSERT … SELECT … WHERE changes() = 1`** right after the statement they record, inside the same D1 batch, so a retried or refused action never logs twice [verified in local D1: `changes()` refers to the previous statement of the batch; production D1 runs the same SQLite engine: inferred].
12. **Conditional inserts put the condition outside the aggregate.** `INSERT … SELECT … FROM site_versions WHERE <cond>` with `MAX(number)` still inserts when the condition is false, because an aggregate without `GROUP BY` always returns one row [verified: it raised a UNIQUE error in the replay]. The version insert uses `FROM (SELECT COALESCE(MAX(number), 0) + 1 AS n …) WHERE <cond>`.
13. **The contact form strips `\p{Cf}` as well as `\p{Cc}`** (keeping U+200D for emoji), so a U+202E cannot make a name read backwards in the owner's inbox. The design says "control characters are removed"; this is stricter.
14. **Additive exports** beyond the design's list, all backwards compatible: `utcDayStart` (core), `ipRateKey` (core, Decision 27), `LIMITS.publishRequestsPerSitePerDay` (core, Decision 25), `type CopyEdits` (core), `type MailerErrorCode`, `type PublishErrorCode` (with `publish_cap_reached` and `site_not_found`, Decisions 25 and 28). `composeDocument` matches service descriptions by the trimmed service name (the parsed facts trim it), and `ownerEditedPaths` reports a service description as `copy.serviceDescriptions.<service name>`. `photoRefIssues` reports every problem at `facts.heroPhoto.url` / `facts.photos.<i>.url` with code `photo_ref`.
15. **The lead email links only to the site itself.** `asksite-sites` has no `APP_ORIGIN` (design §10.3), so it cannot link to the app's Leads page without a new variable. Adding one is the moderator's call.
16. **Local D1 sharing is keyed by database id.** Every Worker's `wrangler.jsonc` must name the same `database_id` (the placeholder `00000000-0000-0000-0000-000000000000` until Task 19) and the bucket names `asksite-live`, `asksite-work`, `asksite-media` [verified: two Workers in one harness, and `wrangler dev` plus `getPlatformProxy` with the same `--persist-to`, share D1 and R2]. Test and seeding tools read the id from `apps/sites/wrangler.jsonc`, so they keep working after Task 19 commits the real id.
17. **Test harness values beat `.dev.vars`** [verified: with a `.dev.vars` saying `MAILER=resend`, the harness's `vars` won]. Harness tests therefore set every variable and secret the Worker reads, so a developer's `.dev.vars` (even one with a real Resend key) can never leak into tests.
18. **The real Resend mailer is tested inside workerd with no network.** The harness sends a Worker's outbound `fetch` through the test process's global `fetch` [verified], so `apps/sites/test/resend.workerd.test.ts` replaces it and answers for `api.resend.com` only.
19. **pnpm skips the `esbuild` and `workerd` install scripts** (`ignoredBuiltDependencies`); wrangler, `wrangler dev` and the harness work without them [verified].
20. **Playwright's web server stops with SIGTERM** (`gracefulShutdown`). Its default SIGKILLs the process group [verified: Playwright 1.63 `types/test.d.ts`], and the first replay left `wrangler` and `workerd` running until they were stopped by PID. `scripts/dev.ts` keeps its `wrangler` children in its own process group, so both a group SIGKILL and a SIGTERM to `dev.ts` alone leave nothing behind [verified both].
21. **`hashIp` throws on an empty key**, and the form answers 503 without `IP_HASH_KEY` rather than store an unkeyed hash. Plan 4's `AUTH_RL` keys must handle the same throw.
22. **Cross-plan alignment with the Plan 3 draft** (`2026-09-24-plan3-generation.md`, written in parallel). (a) The shared D1 placeholder id is `00000000-0000-0000-0000-000000000000`, the value Plans 3 and 4 use; Plan 3 adds a test that every `apps/*/wrangler.jsonc` binding `DB` names the same database and id. (b) Plan 3 type-checks its Worker code in the root program with importable types (`import type { D1Database } from "@cloudflare/workers-types"`) and adds `apps/*/src` and `apps/*/test` to the root `include`. The two approaches coexist: the root `exclude` keeps `apps/sites` (which uses the Workers globals, such as `caches` and `RateLimit`) out of the root program, and `tsconfig.workers.json` checks it. Unifying on one approach later is a mechanical change the moderator may schedule; neither plan depends on the other's choice. (c) Plan 3's `apps/generator` has a `build` script (`wrangler deploy --dry-run --outdir dist`), which `pnpm dev` runs before starting it (harmless: `dist/` is gitignored). (d) Plan 3's draft edits the root `vitest.config.ts` `include`; after Task 5 that file has two projects whose globs already cover `packages/*/test` and `apps/*/test`, so Plan 3 must not edit it at all, and its harness tests must be named `*.workerd.test.ts` to run in the `workerd` project (Decision 31).
23. **`pnpm test` runs two Vitest projects one after the other: `unit`, then `workerd`** (`*.workerd.test.ts`, every test that starts workerd through the harness). In one run, the eleven workerd test files competed for CPU with Plan 1's property test "holds at every split of every prefix of 1,000 seeded random strings of HTML-significant pieces" (`packages/renderer/test/html.test.ts`), which then took 5.2 s and failed Vitest's 5 s default timeout [verified: the final replay's Task 14 full run; alone it takes about 0.8 s]. That would have been a regression caused by this plan. With the split, the unit run never competes with workerd (it takes about 4–7 s), and the workerd project gets 30 s per test and 120 s per hook. The split alone is not enough on a heavily loaded machine: see Decision 33.
24. **R2 first, then D1, and the bytes must be D1's live version** (reverses the order in design §7.3; the moderator's nod). Every cache miss used to ask D1 first, so a request for any random `<xyz>.<root>/` or photo address cost one D1 query, with no login and no rate limit. D1 is single-threaded ("about 1,000 queries per second" at 1 ms per query, "overloaded" when its queue fills [verified: developers.cloudflare.com/d1/platform/limits/]) and all four Workers share it, so one script could stop sign-in, publishing, generation and every live site. Now the page reads `LIVE` first, a photo `MEDIA` first and a form `LIVE.head` first: an unknown slug, photo or form is a 404 that never reaches D1 (tests rename the D1 table and still get 404, not 503). D1 still decides what is served: no live row gives 404. The LIVE object's `customMetadata.versionId` (written by `approveVersion` and `restore`) must equal `sites.live_version_id`, otherwise 503, not cached, so a late or failed LIVE write of an older version is never served or cached. An R2 miss costs one Class B read, $0.36 per million (design §1.3), and does not touch the shared database.
25. **A daily publish cap per site** (a contract change: `LIMITS.publishRequestsPerSitePerDay` = 20 and `PublishError("publish_cap_reached", { retryAfter })`; Plan 4 answers `429 rate_limited` with `Retry-After`). Without it one owner account, or a hijacked one (design §2.2), could store about 172,800 versions a day at `API_RL`'s 120 per minute, each with its document in D1 and its page in WORK, and fill D1's 10 GB for every owner within days [inferred sizes]. The count is checked before rendering (a refused request stores nothing) and again inside the D1 batch, so racing requests cannot pass together (tested: of three racing requests for the last place, one wins). Every version counts, superseded and withdrawn ones too.
26. **The public Worker never shows the platform's error page, and the lead email runs after the response.** `fetch` wraps the router: any uncaught error becomes our 503 page (noindex, `Retry-After: 60`) and one `internal` log line (design §7.4: every response except an approved, indexable page carries noindex). The lead email is sent in `ctx.waitUntil` once the lead is stored and the 303 is returned, so a slow Resend (up to its 10 s timeout) never holds the visitor, and a failure there can never make the visitor see an error and submit twice. If recording the email's outcome fails, that is logged (`email_status_not_saved`) and the lead stays `pending`, still visible to the owner. Tests wait for the settled lead (`settledLeads`).
27. **Rate limits key an IPv6 address by its /64 network** (`ipRateKey`, an additive core export). One customer usually holds a whole /64, so a limit keyed on the full address could be dodged by changing the last 64 bits [inferred]. `FORM_RL` is keyed on `hashIp(key, ipRateKey(ip))`; the stored `ip_hash` still hashes the full address. Plan 4's `AUTH_RL` should use the same function.
28. **An unknown site id gets `site_not_found`** from `takeDown`, `restore` and `setIndexable` (a contract change: a new `PublishErrorCode`; design §4.5 answers 404, so Plan 4 maps it to `404 not_found`). Before, `takeDown` threw `integrity` (a 500) and `setIndexable` succeeded silently.
29. **`restore` also takes `MEDIA` and returns `missingPhotos`** (a contract change: `{ liveUrl, missingPhotos }`). A takedown with `purgeMedia` deletes the site's photos, so restoring it brings back a page with broken images. `restore` still restores (refusing would leave the admin no way back) and reports how many of the live page's photos are gone, so Plan 4 can warn the admin.
30. **LogMailer runs only when `ENVIRONMENT` is exactly `development`** (design §7.6 refuses only `production`). A typo such as `prod`, or an empty value, would otherwise store sign-in links in plain text in production's `dev_outbox`.
31. **Shared root files are edited, never rewritten, and Vitest uses generic globs.** Plans 3 and 4 edit `package.json`, `tsconfig.json` and `.gitignore` in parallel, so a full rewrite would silently drop their entries. After Stage 0 every change to a shared root file is a targeted edit (`pnpm add`, `npm pkg set`, an appended block, "replace this line") with a pre-check that prints the current value. Task 5's `vitest.config.ts` covers `packages/*/test`, `apps/*/test` and `scripts` in the `unit` project and every `*.workerd.test.ts` in the `workerd` project, so a later plan's ordinary tests need no edit to it (a plan that needs another test environment adds its own project by a targeted edit, keeping the unit project's `testTimeout`, Decision 33). Plan 3's draft still edits this file in its Step 3 (and shows a whole file without that timeout): the moderator should drop that half of the step (see Known limits). Task 18 Step 3 checks that no other plan's line was lost.
32. **The production smoke test seeds through the real publishing functions** (`node apps/sites/dev/seed.ts --remote`, the script behind `pnpm dev:seed`, through wrangler's remote bindings in `getPlatformProxy`). Decision 24 makes the Worker check the LIVE object's version metadata, which `wrangler r2 object put` cannot set [verified: its `--help` in wrangler 4.138.0], so a hand-made test site would never be served. The seed also proves the publishing functions and their audit rows on the production D1. Remote bindings exist in wrangler 4.138.0's type definitions [verified]; a real remote run is [unverified] until Task 19.
33. **Unit tests get 30 s each** (the `unit` project's `testTimeout`). The execution check saw Plan 1's property test "holds at every split of every prefix of 1,000 seeded random strings…" time out once in 9 full runs (6.3 s against Vitest's 5 s default) while other agents held the machine at a load average of 150–300; with only Plan 1's files it also reached 5.3 s, so this is a Plan 1 flake that load exposes, which the split of Decision 23 does not prevent [verified by the execution check]. Plan 2 owns `vitest.config.ts` from Task 5, so it raises the unit project's timeout instead of editing Plan 1's test; a hanging test still fails, after 30 s. Before Task 5 (Tasks 1–4) Plan 1's 5 s default still applies: on a loaded machine, rerun a full-suite step that fails only on that timeout, and report it. Giving that one test its own timeout is Plan 1's call (moderator).

## Interfaces this plan provides

Plans 3 and 4 code against these. Part A is the design's §2.8, §4.2 and §4.3 word for word, plus the additive exports in Decision 14.

```ts
// @asksite/core (Tasks 2–5): exactly design §2.8, §4.2, §4.3, plus
export const utcDayStart: (now: number) => number;          // 00:00 UTC of `now`, epoch ms
export function ipRateKey(ip: string): string;              // IPv4 whole, IPv6 its "/64" (Decision 27)
// LIMITS.publishRequestsPerSitePerDay = 20                  // Decision 25
export type CopyEdits = z.infer<typeof CopyEdits>;
// migrations: packages/core/migrations/0001_init.sql (design §2.6); every wrangler.jsonc:
//   "migrations_dir": "../../packages/core/migrations"

// @asksite/site-css (Task 6): generated by `pnpm build:css` (gitignored src/generated.ts)
export const SITE_CSS: string;
export const SITE_CSS_SHA256: string;                         // lower-case hex SHA-256 of SITE_CSS

// @asksite/mailer (Task 7): design §7.6, with explicit fields (Decision 2)
export type EmailTag = "lead" | "magic_link" | "invite" | "review_result" | "site_notice" | "admin_alert";
export interface OutgoingEmail { to: string; subject: string; text: string; html: string; replyTo?: string; tag: EmailTag; idempotencyKey: string }
export interface Mailer { send(email: OutgoingEmail): Promise<{ id: string }> }
export type MailerErrorCode = "rate_limited" | "rejected" | "unavailable" | "misconfigured";
export class MailerError extends Error { readonly code: MailerErrorCode; constructor(code: MailerErrorCode, message: string) }
export function createMailer(env: { MAILER: "resend" | "log"; MAIL_FROM: string; RESEND_API_KEY?: string; DB: D1Database; ENVIRONMENT: string }): Mailer;
export class ResendMailer implements Mailer { constructor(apiKey: string, from: string, fetchFn?: (input: string, init: RequestInit) => Promise<Response>) }
export class LogMailer implements Mailer { constructor(db: D1Database, environment: string) }
// Every Mailer strips control characters (CR and LF included) from the subject and refuses an
// address containing one ("rejected"). Unknown MAILER or a missing key fail on send ("misconfigured").
// LogMailer runs only when ENVIRONMENT === "development" (stricter than design §7.6; Decision 30).

// @asksite/publishing (Tasks 8–10): design §7.2, with Decisions 2, 3, 10, 25, 28 and 29
export type PublishErrorCode = "render_failed" | "nothing_pending" | "version_not_pending" | "site_taken_down" | "integrity" | "not_live"
  | "publish_cap_reached"  // Plan 4: 429 rate_limited, Retry-After = detail.retryAfter (Decision 25)
  | "site_not_found";      // Plan 4: 404 not_found (Decision 28)
export class PublishError extends Error { readonly code: PublishErrorCode; readonly detail?: unknown; constructor(code: PublishErrorCode, detail?: unknown) }
export async function createPendingVersion(env: { DB: D1Database; WORK: R2Bucket; ROOT_DOMAIN: string },
  input: { siteId: string; ownerId: string; slug: string; document: SiteDocument; edits: OwnerEdits; generationId: string | null; now: number }): Promise<VersionSummary>;
  // render_failed (detail: Issue[]); publish_cap_reached (detail: { retryAfter: seconds }); site_taken_down; integrity { reason: "site_changed" }
export async function withdrawPending(env: { DB: D1Database }, input: { siteId: string; ownerId: string; now: number }): Promise<void>; // nothing_pending
export async function approveVersion(env: { DB: D1Database; WORK: R2Bucket; LIVE: R2Bucket; ROOT_DOMAIN: string },
  input: { versionId: string; htmlSha256: string; reviewer: string; note: string | null; indexable: boolean; now: number }): Promise<{ siteId: string; slug: string; liveUrl: string }>;
  // version_not_pending (also for an unknown id); site_taken_down; integrity { reason: "reviewed_hash_mismatch" | "stored_bytes_mismatch" }
export async function rejectVersion(env: { DB: D1Database }, input: { versionId: string; reviewer: string; note: string; now: number }): Promise<{ siteId: string }>;
export async function takeDown(env: { DB: D1Database; LIVE: R2Bucket; MEDIA: R2Bucket },
  input: { siteId: string; reviewer: string; reason: string; purgeMedia: boolean; now: number }): Promise<void>; // site_not_found
export async function restore(env: { DB: D1Database; LIVE: R2Bucket; WORK: R2Bucket; MEDIA: R2Bucket; ROOT_DOMAIN: string },
  input: { siteId: string; reviewer: string; now: number }): Promise<{ liveUrl: string; missingPhotos: number }>; // site_not_found; not_live; integrity
  // missingPhotos: how many of the live page's photos are gone from MEDIA (a purge deleted them; Decision 29)
export async function setIndexable(env: { DB: D1Database }, input: { siteId: string; reviewer: string; indexable: boolean; now: number }): Promise<void>; // site_not_found
// Audit actors: "owner:<ownerId>" (createPendingVersion, withdrawPending), "admin:<reviewer>" (the rest).
// Emails (review result, site notice) are Plan 4's: publishing never sends email.
```

Conventions every Worker follows (Plans 3 and 4 included):

- **`pnpm dev`** (Task 15) starts every `apps/{sites,app,admin,generator}/wrangler.jsonc` that exists: sites 8789, app 8787, admin 8788 (https), generator 8790 (http), inspector ports 9239/9237/9238/9240, one shared `--persist-to .wrangler/state`. It copies `.dev.vars.example` to `.dev.vars` when missing, runs the package's `build` script first if there is one (Plan 4's Vite builds), applies the migrations once, and stops every child on Ctrl+C.
- **Local values**: production values in `wrangler.jsonc` `vars`; development values in `.dev.vars.example` (committed) → `.dev.vars` (gitignored), which override `vars` in `wrangler dev` and in the harness [verified].
- **Integration tests** are named `*.workerd.test.ts` (the `workerd` Vitest project, run after the `unit` project; Decision 23): `createTestHarness` from `wrangler` under Vitest 5.0.1, `root` = the repo, the Worker's real `wrangler.jsonc` plus `vars`/`secrets` overrides for every variable and secret; seed through `getWorker().getEnv()` or a second "tools" Worker in the same harness that names the same database id (Decision 16).
- **Type-checking**: Worker source and its tests go in `tsconfig.workers.json`; the root program must not import them.

## File Structure

```text
package.json                     (modify) scripts build:css, typecheck, dev, dev:seed, test:e2e:sites, check, deploy:check; dev deps
pnpm-workspace.yaml              (modify) + apps/*, ignored build scripts for esbuild and workerd
tsconfig.json                    (modify) exclude the Worker-side code (Decisions 5 and 22)
tsconfig.workers.json            Worker-side code and tests: Node + Workers runtime types
vitest.config.ts                 (modify) two projects: unit, then workerd (*.workerd.test.ts)
.gitignore                       (modify) + generated stylesheet module, generated wrangler.*.jsonc
.github/workflows/ci.yml         typecheck, unit + integration, both browser suites (actions pinned to SHAs)
deploy/dns-records.json          every DNS record of the product zone (tested against RESERVED_SLUGS)
scripts/dev.ts                   pnpm dev: build CSS, migrate local D1, run each Worker with wrangler dev
scripts/deploy-check.ts          pnpm deploy:check: refuses placeholders and unsafe switches before deploy
packages/site-schema/src/        (modify, A6) layout.ts, document.ts, index.ts: SiteDocument.hidden
packages/renderer/src/           (modify, A6) visibility.ts: hidden sections do not render
packages/core/                   @asksite/core: the shared contract (design §2.8, §4.2, §4.3)
  src/ids.ts tokens.ts ip.ts time.ts slug.ts keys.ts issues.ts    ids, tokens, hashes, rate-limit keys, host parsing, keys
  src/draft.ts compose.ts                                          AiDraft, OwnerEdits, composeDocument
  src/brief.ts looks.ts limits.ts errors.ts generation.ts audit.ts rows.ts views.ts api.ts
  migrations/0001_init.sql                                         the D1 schema (design §2.6)
packages/site-css/               @asksite/site-css: SITE_CSS + SITE_CSS_SHA256 from the renderer's site.css
packages/mailer/                 @asksite/mailer: Mailer, ResendMailer, LogMailer, createMailer
packages/publishing/             @asksite/publishing: versions.ts, review.ts, site-state.ts, shared.ts, errors.ts
apps/sites/                      asksite-sites Worker
  wrangler.jsonc                 production config (plain JSON)
  .dev.vars.example              local values
  src/index.ts                   handlers only: fetch (router) and scheduled (lead retention)
  src/router.ts                  Host → apex | www | media | site | unknown
  src/page.ts media.ts           D1-gated serving from LIVE and MEDIA with the Cache API
  src/form.ts lead.ts lead-email.ts   the contact form, field checks, the lead email
  src/pages.ts headers.ts apex.ts     fixed pages, response headers, security.txt
  src/cron.ts log.ts env.ts
  dev/seed.ts                    pnpm dev:seed: an approved demo site in the local state
  test/                          unit + harness integration tests
  e2e/                           Playwright over https against pnpm dev's Worker; smoke.* checks a deployed page
```

## Requirement coverage

| Design requirement | Task |
|---|---|
| §2.3 A6 owner-hidden sections, goldens unchanged | 1 |
| §2.8 `@asksite/core` ids, tokens, time, keys, `parseHost`, slug | 2 |
| §2.8 `AiDraft`, `OwnerEdits`, `SectionOrder`, `composeDocument`, `documentSha256`, `ownerEditedPaths`, `photoRefIssues` | 3 |
| §2.8, §4.2, §4.3 brief, looks, limits, errors, generation, audit, rows, views, api | 4 |
| §2.6 migration; partial unique index; single-use token race (§5.1) | 5 |
| §11.1 `@asksite/site-css`; a Worker importing `@asksite/renderer` builds and renders like Node | 6 |
| §7.6 `@asksite/mailer` (Resend, log outbox) | 7 |
| §7.1, §7.2 `createPendingVersion`, `withdrawPending` | 8 |
| §7.2 `approveVersion`, `rejectVersion` (reviewed-hash check, idempotent retry) | 9 |
| §7.2 `takeDown`, `restore`, `setIndexable` | 10 |
| §1.1, §1.2, §4.6, §7.4, §9.1 sites Worker: routing, apex, security.txt, www, headers, production-config test, no WORK and no writes | 11 |
| §7.3 page and photo serving, D1 gate, Cache API, 503 on D1 failure | 12 |
| §7.5 contact form, lead email, honeypot, rate limit, day cap, spam | 13 |
| §7.3 cron, and the whole pipeline end to end | 14 |
| §10.1 `pnpm dev`, `.dev.vars.example`, local seeding | 15 |
| §7.4 zero CSP violations on every fixture; §7.5 axe on fixed pages; real-browser form | 16 |
| §11.3 CI workflow; §1.1 DNS labels vs reserved slugs; deploy readiness check | 17 |
| Whole plan: full checks and adversarial mutations | 18 |
| §10.4 runbook: resources, DNS, Access checklist, secrets, deploy, smoke tests (needs the user) | 19 |

## Before you start

- [ ] **Step 1: Check the preconditions**

Plan 1 must be merged into `main` (its Task 18 finished and the moderator fast-forwarded `main`). Run:

```bash
cd /Users/ashir/Documents/workk2/web_maker
git switch main
git status --short -- . ':(exclude)docs'
ls packages/renderer/src/render.ts packages/renderer/src/visibility.ts fixtures/golden/plumber-austin.html e2e/fixtures.spec.ts
git config user.name && git config user.email
grep -q "^A6" .superpowers/sdd/plan-decisions.md && echo A6_RECORDED
```

Expected: the switch succeeds; `git status` prints nothing; the four files are listed; then `sydashir`, `meetashirr@gmail.com` and `A6_RECORDED`. If any file is missing, Plan 1 is not merged yet: stop and tell the moderator (Task 1 changes Plan 1's code and must not start before). If `A6_RECORDED` is missing, stop and ask the moderator to record amendment A6 (design §2.3) in `.superpowers/sdd/plan-decisions.md` first: Task 1 changes Plan 1's schema and renderer under it.

- [ ] **Step 2: Create the working branch and record Plan 1's totals**

```bash
git switch -c plan2-hosting
pnpm install && pnpm test 2>&1 | grep -E "Test Files|Tests |Snapshots"
```

Expected: `Switched to a new branch 'plan2-hosting'`; then Plan 1's totals, for example `Test Files  23 passed (23)` and `Tests  555 passed (555)` in the planning replay, and no `Snapshots` line. Write the two numbers down as **P** (files) and **T** (tests): every later "full suite" expectation is stated as P + n and T + n. From Task 5 on, `pnpm test` prints two summaries: the `unit` run (Plan 1 plus the pure tests, stated as P + n and T + n) and then the `workerd` run (stated exactly). No snapshot may be written (`Snapshots … written` must not appear).

- [ ] **Step 3: Make sure the browsers are installed**

Run: `pnpm e2e:install`
Expected: ends without error. The first time on this Mac it downloads Chrome Headless Shell and WebKit into `~/Library/Caches/ms-playwright` (Plan 1's replays used a folder in the scratchpad, so expect a download); later runs are a no-op.

---

## Part A: Stage 0, the shared contracts (design §11.3)

### Task 1: Plan 1 amendment A6 (owner-hidden sections)

**Files:**
- Modify: `packages/site-schema/src/layout.ts` (append), `packages/site-schema/src/document.ts` (2 lines), `packages/site-schema/src/index.ts` (1 export), `packages/renderer/src/visibility.ts` (`visibleSections`)
- Test: `packages/site-schema/test/hidden.test.ts`, `packages/renderer/test/hidden.test.ts`

**Interfaces:**
- Consumes: Plan 1's `SiteDocument`, `Layout`, `factSections`, `visibleSections`, `render`, test helper `FULL` (`packages/renderer/test/support/doc.ts`).
- Produces (from `@asksite/site-schema`): `HIDEABLE_SECTIONS = ["trust", "testimonials", "gallery", "about", "serviceArea", "faq"] as const`, `type HideableSectionId`, `OwnerHidden` (Zod: unique hideable ids, at most 6); `SiteDocument` gains `hidden: OwnerHidden.default([])` (parsed type: `HideableSectionId[]`). `visibleSections(doc)` leaves out `doc.hidden`, so hidden sections leave `<main>`, the header navigation and (for the FAQ) the FAQPage JSON-LD. LocalBusiness JSON-LD is unchanged.
- Regression proof: a document without `hidden` renders byte-for-byte as before, so all five Plan 1 golden files stay unchanged.

- [ ] **Step 1: Write the failing tests**

`packages/site-schema/test/hidden.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HIDEABLE_SECTIONS, OwnerHidden, SiteDocument, type SiteDocumentInput } from "../src/index.ts";

// Amendment A6: owner-hidden sections. Only the owner sets `hidden`; hero, services and contact
// can never be hidden, so every page says what the business does and how to reach it.
const doc: SiteDocumentInput = {
  facts: {
    businessName: "Mop",
    trade: "cleaning",
    phone: "+15125550142",
    email: "hello@example.com",
    location: { city: "Austin", state: "TX" },
    serviceArea: { places: ["Austin"] },
    services: [{ name: "House cleaning" }],
    testimonials: [{ quote: "Spotless every time.", name: "Ana" }],
  },
  copy: {
    heroHeadline: "A spotless home without lifting a finger",
    heroSubheadline: "Friendly, careful cleaners for homes across Austin.",
    ctaText: "Book a cleaning",
    serviceDescriptions: [{ service: "House cleaning", description: "Weekly or one-off cleans." }],
  },
  layout: [
    { id: "hero", variant: "centered" },
    { id: "services", variant: "cards" },
    { id: "testimonials", variant: "grid" },
    { id: "serviceArea", variant: "split" },
    { id: "contact", variant: "card" },
  ],
  theme: { palette: "green-amber", font: "clean" },
};

const issues = (input: unknown) => {
  const result = SiteDocument.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("SiteDocument.hidden (A6)", () => {
  it("defaults to an empty list, so documents without it parse as before", () => {
    expect(SiteDocument.parse(doc).hidden).toEqual([]);
  });

  it("lists exactly the six hideable sections", () => {
    expect(HIDEABLE_SECTIONS).toEqual(["trust", "testimonials", "gallery", "about", "serviceArea", "faq"]);
  });

  it("accepts hideable sections, including a fact section the layout must still list", () => {
    expect(issues({ ...doc, hidden: ["testimonials", "faq"] })).toEqual([]);
  });

  it.each(["hero", "services", "contact"])("rejects hiding %s", (id) => {
    expect(issues({ ...doc, hidden: [id] })).toHaveLength(1);
    expect(issues({ ...doc, hidden: [id] })[0]).toMatch(/^hidden\.0: /);
  });

  it("rejects an unknown section id", () => {
    expect(issues({ ...doc, hidden: ["header"] })).toHaveLength(1);
  });

  it("rejects a duplicate id", () => {
    expect(issues({ ...doc, hidden: ["faq", "faq"] })).toEqual(["hidden: A section can be hidden only once"]);
  });

  it("does not let hiding remove a fact section from the layout rule", () => {
    const withoutReviews = { ...doc, layout: doc.layout.filter((s) => s.id !== "testimonials"), hidden: ["testimonials"] };
    expect(issues(withoutReviews)).toEqual([
      "layout: The layout must include every section that shows owner facts; missing: testimonials",
    ]);
  });

  it("OwnerHidden caps the list at the number of hideable sections", () => {
    expect(OwnerHidden.safeParse([...HIDEABLE_SECTIONS, "faq"]).success).toBe(false);
  });
});
```

`packages/renderer/test/hidden.test.ts`:

```ts
import { SiteDocument, type SiteDocumentInput } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { render } from "../src/index.ts";
import { visibleSections } from "../src/visibility.ts";
import { FULL } from "./support/doc.ts";

// Amendment A6: a section the owner hid is gone from <main>, the header navigation and (for the
// FAQ) the FAQPage JSON-LD. LocalBusiness JSON-LD is unchanged: hiding hides, it deletes no facts.
const OPTIONS = { stylesheet: "/* css */", formAction: "https://forms.example.com/submit" };
const sectionIds = (page: string) => [...page.matchAll(/<section id="([a-z-]+)"/g)].map((m) => m[1]);
const withHidden = (hidden: string[]): SiteDocumentInput => ({ ...FULL, hidden } as SiteDocumentInput);

describe("owner-hidden sections (A6)", () => {
  it("visibleSections drops hidden sections and keeps the rest in order", () => {
    const doc = SiteDocument.parse(withHidden(["testimonials", "faq"]));
    expect(visibleSections(doc).map((s) => s.id)).toEqual(["hero", "trust", "services", "gallery", "about", "serviceArea", "contact"]);
  });

  it("removes a hidden section from <main> and the navigation", () => {
    const page = render(withHidden(["testimonials", "gallery"]), OPTIONS);
    expect(sectionIds(page)).toEqual(["top", "credentials", "services", "about", "service-area", "faq", "contact"]);
    expect(page).not.toContain('href="#reviews"');
    expect(page).not.toContain('href="#our-work"');
    expect(page).toContain('href="#services"');
  });

  it("drops FAQPage JSON-LD with a hidden FAQ but keeps LocalBusiness JSON-LD", () => {
    const page = render(withHidden(["faq"]), OPTIONS);
    expect(page).not.toContain('"@type":"FAQPage"');
    expect(page).not.toContain('<section id="faq"');
    expect(page).toContain('"@type":"Plumber"');
    expect(page).toContain("M-40123");
  });

  it("renders byte-for-byte the same page with hidden: [] as without the field", () => {
    expect(render(withHidden([]), OPTIONS)).toBe(render(FULL, OPTIONS));
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run packages/site-schema/test/hidden.test.ts packages/renderer/test/hidden.test.ts`
Expected: FAIL: `Test Files  2 failed (2)`, `Tests  13 failed | 1 passed (14)`. The schema tests fail with `Unrecognized key: "hidden"` or `expected undefined to deeply equal []`, the renderer tests with `ZodError` (the strict object has no `hidden` key yet). The one that passes is "rejects an unknown section id" (any unknown key is already refused).

- [ ] **Step 3: Write the implementation**

Append to `packages/site-schema/src/layout.ts` (the file already imports `z`):

```ts
/**
 * Amendment A6. Sections the OWNER may hide from the page. Hero, services and contact are not
 * here: every page must say what the business does and how to reach it.
 */
export const HIDEABLE_SECTIONS = ["trust", "testimonials", "gallery", "about", "serviceArea", "faq"] as const;
export type HideableSectionId = (typeof HIDEABLE_SECTIONS)[number];
/** Sections the OWNER chose to hide. Never produced by the AI. */
export const OwnerHidden = z
  .array(z.enum(HIDEABLE_SECTIONS))
  .max(HIDEABLE_SECTIONS.length)
  .refine((ids) => new Set(ids).size === ids.length, { error: "A section can be hidden only once" });
```

In `packages/site-schema/src/document.ts`, replace

```ts
import { Layout, type LayoutSection, type SectionId } from "./layout.ts";
```

with

```ts
import { Layout, OwnerHidden, type LayoutSection, type SectionId } from "./layout.ts";
```

In `packages/site-schema/src/document.ts`, replace

```ts
  .strictObject({ facts: Facts, copy: Copy, layout: Layout, theme: Theme })
```

with

```ts
  .strictObject({ facts: Facts, copy: Copy, layout: Layout, theme: Theme, hidden: OwnerHidden.default([]) })
```

In `packages/site-schema/src/index.ts`, replace

```ts
export { Layout, LayoutSection, SECTION_VARIANTS, type SectionId, type VariantOf } from "./layout.ts";
```

with

```ts
export {
  HIDEABLE_SECTIONS,
  Layout,
  LayoutSection,
  OwnerHidden,
  SECTION_VARIANTS,
  type HideableSectionId,
  type SectionId,
  type VariantOf,
} from "./layout.ts";
```

In `packages/renderer/src/visibility.ts`, replace

```ts
export function visibleSections(doc: SiteDocument): LayoutSection[] {
  return doc.layout.filter((section) => hasContent(doc, section.id));
}
```

with

```ts
/** Layout sections that render: they have content and the owner did not hide them (amendment A6). */
export function visibleSections(doc: SiteDocument): LayoutSection[] {
  const hidden: ReadonlySet<SectionId> = new Set(doc.hidden);
  return doc.layout.filter((section) => hasContent(doc, section.id) && !hidden.has(section.id));
}
```

If Plan 1's merged file differs from a "replace" snippet above (a reviewer reformatted it), make the same change by hand: import `OwnerHidden`, add `hidden: OwnerHidden.default([])` to the `SiteDocument` object, export the three names, and filter `doc.hidden` in `visibleSections`. Touch nothing else (design §2.3).

- [ ] **Step 4: Run the tests, the whole suite, the typecheck, and prove the goldens did not move**

Run: `pnpm vitest run packages/site-schema/test/hidden.test.ts packages/renderer/test/hidden.test.ts`
Expected: `Tests  14 passed (14)`.

Run: `pnpm test && pnpm typecheck && git status --short -- fixtures/golden`
Expected: `Test Files  P+2 passed`, `Tests  T+14 passed` (planning replay: 25 and 569); no `Snapshots … written` line; typecheck exits 0; `git status` prints nothing (all five golden files are byte-identical, which is the A6 regression proof).

- [ ] **Step 5: Commit**

```bash
git add packages/site-schema/src/layout.ts packages/site-schema/src/document.ts packages/site-schema/src/index.ts packages/renderer/src/visibility.ts packages/site-schema/test/hidden.test.ts packages/renderer/test/hidden.test.ts
git commit -m "Add hidden sections"
```

---
### Task 2: `@asksite/core` basics: ids, tokens, time, slugs, keys and host parsing

**Files:**
- Modify: `package.json` (dev dependency `@asksite/core`, added by `pnpm add`)
- Create: `packages/core/package.json`, `packages/core/src/{ids,tokens,ip,time,slug,keys,issues,index}.ts`
- Test: `packages/core/test/tokens.test.ts`, `packages/core/test/keys.test.ts`, `packages/core/test/time-issues.test.ts`

**Interfaces:**
- Consumes: nothing (Web Crypto only: `crypto.randomUUID`, `crypto.getRandomValues`, `crypto.subtle`, `btoa`, `TextEncoder`, all present in Workers and Node).
- Produces (design §2.8, verbatim names): `newId(): string`, `isId(s): boolean`; `TOKEN_PATTERN`, `newToken(): string` (43 base64url characters), `sha256Hex(input: string): Promise<string>`, `hashIp(key: string, ip: string): Promise<string>` (22 characters; throws on an empty key), `canonicalJson(value): string`; `utcDay(now)`, `utcDayStart(now)` (additive), `TTL`; `SLUG_PATTERN`, `RESERVED_SLUGS`, `slugIssue(slug): "invalid" | "reserved" | null`; `liveKey`, `versionKey`, `mediaKey`, `siteUrl`, `formActionUrl`, `previewFormActionUrl`, `mediaUrl`, `type HostKind`, `parseHost(host, root): HostKind`; `interface Issue`, `toIssues(error: z.ZodError): Issue[]`. Additive (Decision 27): `ipRateKey(ip): string`, the part of a client address a rate limit is keyed on (IPv4 whole, IPv6 its /64), for `FORM_RL` here and Plan 4's `AUTH_RL`.

- [ ] **Step 1: Add the package**

`packages/core/package.json` (its tests render Plan 1 fixtures, hence the dev dependency on the renderer):

```json
{
  "name": "@asksite/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@asksite/site-schema": "workspace:*",
    "zod": "4.6.5"
  },
  "devDependencies": {
    "@asksite/renderer": "workspace:*"
  }
}
```

Run: `pnpm add -D -w "@asksite/core@workspace:*"`
Expected: ends with `Done in …s using pnpm v10.33.0`; `git diff -- package.json` shows one added line, `"@asksite/core": "workspace:*",`, at the top of `devDependencies` (nothing else in the root `package.json` changes).

- [ ] **Step 2: Write the failing tests**

`packages/core/test/tokens.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { canonicalJson, hashIp, ipRateKey, isId, newId, newToken, sha256Hex, TOKEN_PATTERN } from "../src/index.ts";

describe("ids", () => {
  it("creates v4 UUIDs that isId accepts", () => {
    const id = newId();
    expect(isId(id)).toBe(true);
    expect(newId()).not.toBe(id);
  });

  it.each(["", "not-an-id", "7C9E6679-7425-40DE-944B-E07FC1F90AE7", "7c9e6679-7425-10de-944b-e07fc1f90ae7", "7c9e6679742540de944be07fc1f90ae7", "../7c9e6679-7425-40de-944b-e07fc1f90ae7"])(
    "isId rejects %j",
    (value) => {
      expect(isId(value)).toBe(false);
    },
  );
});

describe("tokens", () => {
  it("newToken is 43 base64url characters and never repeats", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => newToken()));
    expect(tokens.size).toBe(200);
    for (const token of tokens) expect(token).toMatch(TOKEN_PATTERN);
  });

  it("sha256Hex matches the FIPS 180-2 test vector and hashes UTF-8", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await sha256Hex("é")).toBe(await sha256Hex("é"));
    expect(await sha256Hex("é")).not.toBe(await sha256Hex("é"));
  });

  it("hashIp is a keyed, 22-character base64url hash", async () => {
    const a = await hashIp("key-one", "203.0.113.7");
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await hashIp("key-one", "203.0.113.7")).toBe(a);
    expect(await hashIp("key-two", "203.0.113.7")).not.toBe(a);
    expect(await hashIp("key-one", "203.0.113.8")).not.toBe(a);
    expect(a).not.toContain("203");
  });

  it("hashIp refuses an empty key instead of hashing without a secret", async () => {
    await expect(hashIp("", "203.0.113.7")).rejects.toThrow("non-empty key");
  });
});

describe("ipRateKey", () => {
  it("keeps an IPv4 address whole", () => {
    expect(ipRateKey("203.0.113.7")).toBe("203.0.113.7");
  });

  it("cuts an IPv6 address to its /64 network, whatever the notation", () => {
    const network = "2001:db8:85a3:0::/64";
    expect(ipRateKey("2001:0db8:85a3:0000:0000:8a2e:0370:7334")).toBe(network);
    expect(ipRateKey("2001:DB8:85A3::8A2E:370:7334")).toBe(network);
    expect(ipRateKey("2001:db8:85a3::1")).toBe(network);
    expect(ipRateKey("2001:db8:85a3:1::1")).toBe("2001:db8:85a3:1::/64");
    expect(ipRateKey("::1")).toBe("0:0:0:0::/64");
  });
});

describe("canonicalJson", () => {
  it("sorts keys recursively and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it("gives equal strings for equal values in any key order", () => {
    expect(canonicalJson({ x: 1, y: [1, 2] })).toBe(canonicalJson({ y: [1, 2], x: 1 }));
  });

  it("drops undefined values like JSON.stringify", () => {
    expect(canonicalJson({ a: undefined, b: 2 })).toBe('{"b":2}');
  });

  it("keeps a __proto__ key as data", () => {
    expect(canonicalJson(JSON.parse('{"__proto__":{"x":1},"a":2}'))).toBe('{"__proto__":{"x":1},"a":2}');
  });
});
```

`packages/core/test/keys.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  formActionUrl,
  liveKey,
  mediaKey,
  mediaUrl,
  parseHost,
  previewFormActionUrl,
  RESERVED_SLUGS,
  siteUrl,
  slugIssue,
  versionKey,
} from "../src/index.ts";

const SITE = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const VERSION = "0b0c2d3e-4f50-4a6b-8c7d-8e9fa0b1c2d3";

describe("keys", () => {
  it("builds every R2 key and URL from ids and slugs only", () => {
    expect(liveKey("joes")).toBe("joes.html");
    expect(versionKey(SITE, VERSION)).toBe(`versions/${SITE}/${VERSION}.html`);
    expect(mediaKey(SITE, VERSION)).toBe(`${SITE}/${VERSION}.webp`);
    expect(siteUrl("asksite.example", "joes")).toBe("https://joes.asksite.example/");
    expect(formActionUrl("localhost:8789", "joes", SITE)).toBe(`https://joes.localhost:8789/_f/${SITE}`);
    expect(previewFormActionUrl("asksite.example", null, SITE)).toBe(`https://preview.asksite.example/_f/${SITE}`);
    expect(previewFormActionUrl("asksite.example", "joes", SITE)).toBe(`https://joes.asksite.example/_f/${SITE}`);
    expect(mediaUrl("asksite.example", SITE, VERSION)).toBe(`https://media.asksite.example/${SITE}/${VERSION}.webp`);
  });
});

describe("parseHost", () => {
  const root = "asksite.example";

  it.each([
    ["asksite.example", { kind: "apex" }],
    ["www.asksite.example", { kind: "www" }],
    ["media.asksite.example", { kind: "media" }],
    ["joes.asksite.example", { kind: "site", slug: "joes" }],
    ["JOES.AskSite.Example", { kind: "site", slug: "joes" }],
    ["joes-plumbing-2.asksite.example", { kind: "site", slug: "joes-plumbing-2" }],
    ["app.asksite.example", { kind: "unknown" }],
    ["admin.asksite.example", { kind: "unknown" }],
    ["a.b.asksite.example", { kind: "unknown" }],
    ["www.joes.asksite.example", { kind: "unknown" }],
    ["jo.asksite.example", { kind: "unknown" }],
    ["jo--es.asksite.example", { kind: "unknown" }],
    ["joes.asksite.example.evil.test", { kind: "unknown" }],
    ["evilasksite.example", { kind: "unknown" }],
    ["joes.asksite.example:8443", { kind: "unknown" }],
    ["", { kind: "unknown" }],
  ])("%j", (host, kind) => {
    expect(parseHost(host, root)).toEqual(kind);
  });

  it("includes the port for local development", () => {
    expect(parseHost("joes.localhost:8789", "localhost:8789")).toEqual({ kind: "site", slug: "joes" });
    expect(parseHost("localhost:8789", "localhost:8789")).toEqual({ kind: "apex" });
    expect(parseHost("joes.localhost:8790", "localhost:8789")).toEqual({ kind: "unknown" });
    expect(parseHost("joes.localhost", "localhost:8789")).toEqual({ kind: "unknown" });
  });
});

describe("slugIssue", () => {
  it.each(["joes", "abc", "joes-plumbing", "a1b", "x".repeat(40)])("accepts %j", (slug) => {
    expect(slugIssue(slug)).toBeNull();
  });

  it.each(["ab", "x".repeat(41), "-joes", "joes-", "jo--es", "Joes", "joe's", "joe_s", "jöes", " joes", "joes.example"])(
    "rejects %j as invalid",
    (slug) => {
      expect(slugIssue(slug)).toBe("invalid");
    },
  );

  it("reserves every hostname, mail label and look-alike the design lists", () => {
    const listed = (
      "www app admin media api mail email smtp imap pop ftp static assets cdn img images files status help support docs " +
      "blog abuse security billing account accounts login signin signup auth dashboard staging stage dev test preview " +
      "ns1 ns2 mx autodiscover autoconfig webmail send inbound bounce"
    ).split(" ");
    for (const slug of listed) expect(RESERVED_SLUGS.has(slug), slug).toBe(true);
    expect(slugIssue("admin")).toBe("reserved");
    expect(slugIssue("preview")).toBe("reserved");
  });
});
```

`packages/core/test/time-issues.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toIssues, TTL, utcDay, utcDayStart } from "../src/index.ts";

describe("time", () => {
  it("utcDay and utcDayStart use UTC midnight", () => {
    const now = Date.parse("2026-09-24T23:59:59.999Z");
    expect(utcDay(now)).toBe("2026-09-24");
    expect(utcDayStart(now)).toBe(Date.parse("2026-09-24T00:00:00.000Z"));
    expect(utcDayStart(Date.parse("2026-09-25T00:00:00.000Z"))).toBe(Date.parse("2026-09-25T00:00:00.000Z"));
  });

  it("keeps the agreed token and session lifetimes", () => {
    expect(TTL).toEqual({ inviteMs: 604_800_000, loginTokenMs: 900_000, sessionMs: 2_592_000_000 });
  });
});

describe("toIssues", () => {
  it("flattens zod issues and turns symbol path keys into strings", () => {
    const sym = Symbol("s");
    const schema = z.object({ a: z.array(z.string()) }).superRefine((_, ctx) => {
      ctx.addIssue({ code: "custom", path: [sym], message: "symbolic" });
    });
    const result = schema.safeParse({ a: [1] });
    if (result.success) throw new Error("expected a type issue");
    expect(toIssues(result.error)).toEqual([{ path: ["a", 0], code: "invalid_type", message: "Invalid input: expected string, received number" }]);
    const refined = schema.safeParse({ a: ["x"] });
    if (refined.success) throw new Error("expected a refinement issue");
    expect(toIssues(refined.error)).toEqual([{ path: ["Symbol(s)"], code: "custom", message: "symbolic" }]);
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `pnpm vitest run packages/core`
Expected: FAIL: `Test Files  3 failed (3)`, each with `Error: Cannot find module '../src/index.ts'`.

- [ ] **Step 4: Write the implementation**

`packages/core/src/ids.ts`:

```ts
/** Every record id is a random v4 UUID. */
export const newId = (): string => crypto.randomUUID();

/** True for a lower-case v4 UUID, the only id shape we ever create. */
export const isId = (s: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(s);
```

`packages/core/src/tokens.ts`:

```ts
// Tokens, hashes and canonical JSON. Web Crypto only, so the same code runs in Workers and Node.

/** 32 random bytes as base64url without padding: always 43 characters. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** A new single-use secret (invite, magic link, session). Store only sha256Hex(token). */
export function newToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** Lower-case hex SHA-256 of the UTF-8 bytes of `input`. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** HMAC-SHA256(key, ip) as base64url, first 22 characters. Never store a raw IP. Throws on an empty key. */
export async function hashIp(key: string, ip: string): Promise<string> {
  if (key === "") throw new Error("hashIp needs a non-empty key");
  const cryptoKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(ip));
  return base64url(new Uint8Array(mac)).slice(0, 22);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  // A null-prototype object keeps a "__proto__" key as an ordinary own property.
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key]);
  return out;
}

/** JSON with object keys sorted recursively and no whitespace, so equal values give equal strings.
 *  For JSON-shaped data only (records, arrays, strings, numbers, booleans, null): a Date or Map becomes {}. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
```

`packages/core/src/ip.ts`:

```ts
/**
 * The part of a client IP address that a rate limit is keyed on. An IPv4 address is used whole. An
 * IPv6 address is cut to its /64 network: one customer usually holds a whole /64, so a limit keyed on
 * the full address could be dodged by changing the last 64 bits. Input is CF-Connecting-IP (one address).
 */
export function ipRateKey(ip: string): string {
  const address = ip.trim().toLowerCase();
  if (!address.includes(":")) return address;
  const halves = address.split("::");
  if (halves.length > 2) return address; // not an IPv6 address: keep it whole
  const head = halves[0] === "" || halves[0] === undefined ? [] : halves[0].split(":");
  const tail = halves.length === 2 && halves[1] !== "" && halves[1] !== undefined ? halves[1].split(":") : [];
  const zeros = halves.length === 2 ? Array.from({ length: Math.max(0, 8 - head.length - tail.length) }, () => "0") : [];
  const network = [...head, ...zeros, ...tail].slice(0, 4).map((group) => group.replace(/^0+(?=.)/, ""));
  return `${network.join(":")}::/64`;
}
```

`packages/core/src/time.ts`:

```ts
/** The UTC calendar day of an epoch-millisecond time, e.g. "2026-09-24". */
export const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);

/** Epoch milliseconds of 00:00 UTC on the day of `now`. */
export const utcDayStart = (now: number): number => Date.parse(`${utcDay(now)}T00:00:00.000Z`);

export const TTL = { inviteMs: 7 * 86_400_000, loginTokenMs: 15 * 60_000, sessionMs: 30 * 86_400_000 } as const;
```

`packages/core/src/slug.ts`:

```ts
/** 3-40 characters of a-z and 0-9 with single hyphens inside: no "--", no leading or trailing "-". */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?!-)){1,38}[a-z0-9]$/;

/**
 * Names that can never be a site. They are our own hostnames, mail and DNS labels (any label with
 * its own DNS record escapes the "*" wildcard, so a site with that slug would have no address),
 * and words that would let a site pose as us. Plan 4 adds the brand and obscenity blocklist.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "www", "app", "admin", "media", "api", "mail", "email", "smtp", "imap", "pop", "ftp", "static",
  "assets", "cdn", "img", "images", "files", "status", "help", "support", "docs", "blog", "abuse",
  "security", "billing", "account", "accounts", "login", "signin", "signup", "auth", "dashboard",
  "staging", "stage", "dev", "test", "preview", "ns1", "ns2", "mx", "autodiscover", "autoconfig",
  "webmail", "send", "inbound", "bounce",
]);

/** Shape and reserved-word check only. */
export function slugIssue(slug: string): "invalid" | "reserved" | null {
  if (!SLUG_PATTERN.test(slug)) return "invalid";
  if (RESERVED_SLUGS.has(slug)) return "reserved";
  return null;
}
```

`packages/core/src/keys.ts`:

```ts
import { slugIssue } from "./slug.ts";

// The only place R2 keys and public URLs are built. `root` is ROOT_DOMAIN: host[:port].

export const liveKey = (slug: string) => `${slug}.html`;
export const versionKey = (siteId: string, versionId: string) => `versions/${siteId}/${versionId}.html`;
export const mediaKey = (siteId: string, uploadId: string) => `${siteId}/${uploadId}.webp`; // in MEDIA
export const siteUrl = (root: string, slug: string) => `https://${slug}.${root}/`;
export const formActionUrl = (root: string, slug: string, siteId: string) => `https://${slug}.${root}/_f/${siteId}`;
/** The owner app's in-browser preview renders with this before a slug is chosen ("preview" is reserved;
 *  the sandboxed preview can never submit the form anyway). */
export const previewFormActionUrl = (root: string, slug: string | null, siteId: string) =>
  formActionUrl(root, slug ?? "preview", siteId);
export const mediaUrl = (root: string, siteId: string, uploadId: string) => `https://media.${root}/${siteId}/${uploadId}.webp`;

export type HostKind =
  | { kind: "apex" }
  | { kind: "www" }
  | { kind: "media" }
  | { kind: "site"; slug: string }
  | { kind: "unknown" };

/**
 * host = URL.host (lower-case, includes a non-default port); root = ROOT_DOMAIN.
 * host === root -> apex; "www." + root -> www; "media." + root -> media;
 * "<label>." + root where <label> has no "." and slugIssue(label) === null -> site;
 * anything else (deeper subdomains, reserved labels such as "app", other domains, a port mismatch) -> unknown.
 */
export function parseHost(host: string, root: string): HostKind {
  const h = host.toLowerCase();
  const r = root.toLowerCase();
  if (h === r) return { kind: "apex" };
  if (!h.endsWith(`.${r}`)) return { kind: "unknown" };
  const label = h.slice(0, h.length - r.length - 1);
  if (label === "www") return { kind: "www" };
  if (label === "media") return { kind: "media" };
  if (!label.includes(".") && slugIssue(label) === null) return { kind: "site", slug: label };
  return { kind: "unknown" };
}
```

`packages/core/src/issues.ts`:

```ts
import type { z } from "zod";

export interface Issue {
  path: Array<string | number>;
  code: string;
  message: string;
}

/** Flattens a ZodError into plain issues; symbol path keys become String(key). */
export function toIssues(error: z.ZodError): Issue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((key) => (typeof key === "symbol" ? String(key) : key)),
    code: issue.code,
    message: issue.message,
  }));
}
```

`packages/core/src/index.ts`:

```ts
export * from "./ids.ts";
export * from "./ip.ts";
export * from "./issues.ts";
export * from "./keys.ts";
export * from "./slug.ts";
export * from "./time.ts";
export * from "./tokens.ts";
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: `Test Files  3 passed (3)`, `Tests  55 passed (55)`; typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml packages/core/package.json packages/core/src packages/core/test
git commit -m "Add core basics"
```

---
### Task 3: `@asksite/core` drafts: `AiDraft`, `OwnerEdits` and `composeDocument`

**Files:**
- Create: `packages/core/src/draft.ts`, `packages/core/src/compose.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/compose.test.ts`

**Interfaces:**
- Consumes: A6's `OwnerHidden` (Task 1); `Copy`, `Layout`, `Theme`, `SECTION_VARIANTS`, `SiteDocument`, `type SiteDocumentInput`, `type LayoutSection`, `type SectionId` from `@asksite/site-schema`; `mediaUrl`, `canonicalJson`, `sha256Hex`, `Issue` (Task 2); Plan 1's `fixtures/index.ts` (`FIXTURES`, `loadFixture`) and `render` in tests.
- Produces (design §2.8): `AiDraft`, `type AiDraft`, `CopyEdits` (+ `type CopyEdits`), `SECTION_IDS`, `SectionOrder`, `OwnerEdits`, `type OwnerEdits`, `EMPTY_EDITS`; `interface CurrentAi { generationId: string; draft: AiDraft }`, `type ComposedDocument`, `composeDocument(facts: unknown, ai: CurrentAi, edits: OwnerEdits): ComposedDocument`, `documentSha256(parsed: SiteDocument): Promise<string>`, `ownerEditedPaths(ai, edits): string[]`, `photoRefIssues(facts, siteId, root, uploads): Issue[]`.
- Semantics proved by the tests (design §11.3 Stage 0 list): a first photo, review or licence added after generation still gives a valid document (missing sections are added before `contact`); a service named `constructor` or `__proto__` behaves like any other name; a stale `baseGenerationId` ignores copy and order edits but keeps `hidden` and `theme`; `EMPTY_EDITS` is frozen and a composed document never shares its `hidden` array with the edits; `SectionOrder` refuses partial or duplicate orders; owner text has whitespace runs collapsed and still meets every Plan 1 copy rule; re-parsing any Plan 1 fixture leaves `documentSha256` unchanged; `photoRefIssues` flags outside URLs, another site's uploads, deleted uploads and size mismatches.

- [ ] **Step 1: Write the failing test**

`packages/core/test/compose.test.ts`:

```ts
import { render } from "@asksite/renderer";
import { SiteDocument, type SiteDocumentInput } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { FIXTURES, loadFixture } from "../../../fixtures/index.ts";
import {
  AiDraft,
  canonicalJson,
  composeDocument,
  documentSha256,
  EMPTY_EDITS,
  mediaUrl,
  OwnerEdits,
  ownerEditedPaths,
  photoRefIssues,
  SECTION_IDS,
  SectionOrder,
  type CurrentAi,
} from "../src/index.ts";

const GEN = "11111111-1111-4111-8111-111111111111";
const OLD_GEN = "22222222-2222-4222-8222-222222222222";

/** A fixture split the way the app stores it: owner facts, and the AI draft from generation GEN. */
function split(input: SiteDocumentInput): { facts: unknown; ai: CurrentAi } {
  const { facts, copy, layout, theme } = input;
  return { facts, ai: { generationId: GEN, draft: AiDraft.parse({ copy, layout, theme }) } };
}

const edits = (patch: Partial<OwnerEdits> = {}): OwnerEdits => ({ ...EMPTY_EDITS, baseGenerationId: GEN, ...patch });
const issuesOf = (doc: unknown) => {
  const result = SiteDocument.safeParse(doc);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("composeDocument", () => {
  it.each(FIXTURES)("with no edits, %s composes to a document that renders the same page", (name) => {
    const fixture = loadFixture(name);
    const { facts, ai } = split(fixture);
    const composed = SiteDocument.parse(composeDocument(facts, ai, EMPTY_EDITS));
    const options = { stylesheet: "/* css */", formAction: "https://joes.asksite.example/_f/x" };
    expect(render(composed, options)).toBe(render(fixture, options));
  });

  it("stays valid when the owner adds a first photo, review and licence after generation", () => {
    const fixture = loadFixture("cleaning-minimal");
    const { facts, ai } = split({
      ...fixture,
      layout: [
        { id: "hero", variant: "centered" },
        { id: "services", variant: "cards" },
        { id: "serviceArea", variant: "split" },
        { id: "contact", variant: "card" },
      ],
    });
    const grown = {
      ...(facts as Record<string, unknown>),
      photos: [{ url: "https://media.asksite.example/a/b.webp", alt: "Clean kitchen", width: 1600, height: 1200 }],
      testimonials: [{ quote: "Spotless.", name: "Ana" }],
      licences: [{ label: "City business licence", number: "BL-1" }],
    };
    const composed = composeDocument(grown, ai, EMPTY_EDITS);
    expect(composed.layout.map((s) => s.id)).toEqual(["hero", "services", "serviceArea", "trust", "testimonials", "gallery", "about", "faq", "contact"]);
    expect(issuesOf(composed)).toEqual([]);
  });

  it("puts missing sections at the end when the AI layout has no contact section", () => {
    const { facts, ai } = split(loadFixture("cleaning-minimal"));
    const noContact = { ...ai, draft: { ...ai.draft, layout: ai.draft.layout.filter((s) => s.id !== "contact") } };
    expect(composeDocument(facts, noContact, EMPTY_EDITS).layout.at(-1)).toEqual({ id: "contact", variant: "card" });
  });

  it("applies wording edits with whitespace collapsed, and null removes an optional field", () => {
    const { facts, ai } = split(loadFixture("plumber-austin"));
    const composed = composeDocument(facts, ai, edits({
      copy: {
        heroHeadline: "Honest   plumbing\n\nfor Austin homes",
        about: null,
        sectionIntros: { services: null, faq: "Answers\tbefore you call." },
      },
    }));
    expect(composed.copy.heroHeadline).toBe("Honest plumbing for Austin homes");
    expect(composed.copy).not.toHaveProperty("about");
    expect(composed.copy.sectionIntros).not.toHaveProperty("services");
    expect(composed.copy.sectionIntros?.faq).toBe("Answers before you call.");
    expect(composed.copy.sectionIntros?.gallery).toBe(ai.draft.copy.sectionIntros.gallery);
    expect(issuesOf(composed)).toEqual([]);
  });

  it("still runs every Plan 1 copy rule on owner edits", () => {
    const { facts, ai } = split(loadFixture("plumber-austin"));
    const composed = composeDocument(facts, ai, edits({ copy: { heroHeadline: "Call 512-555-0142 now" } }));
    expect(issuesOf(composed)).toEqual(["copy.heroHeadline: Copy must not contain numbers, currency symbols, @ or links; facts come from the owner"]);
  });

  it("ignores copy and order edits made for an older generation, but keeps hidden and theme", () => {
    const { facts, ai } = split(loadFixture("plumber-austin"));
    const stale = edits({
      baseGenerationId: OLD_GEN,
      copy: { heroHeadline: "Old wording" },
      order: ["hero", "faq", ...SECTION_IDS.filter((id) => id !== "hero" && id !== "faq")],
      hidden: ["faq"],
      theme: { palette: "charcoal-red", font: "sturdy" },
    });
    const composed = composeDocument(facts, ai, stale);
    expect(composed.copy.heroHeadline).toBe(ai.draft.copy.heroHeadline);
    expect(composed.layout.map((s) => s.id)).toEqual(ai.draft.layout.map((s) => s.id));
    expect(composed.hidden).toEqual(["faq"]);
    expect(composed.theme).toEqual({ palette: "charcoal-red", font: "sturdy" });
    expect(ownerEditedPaths(ai, stale)).toEqual([]);
  });

  it("sorts the layout into the owner's order and keeps each variant", () => {
    const { facts, ai } = split(loadFixture("plumber-austin"));
    const order = ["hero", "faq", "services", "trust", "testimonials", "gallery", "about", "serviceArea", "contact"] as const;
    const composed = composeDocument(facts, ai, edits({ order: [...order] }));
    expect(composed.layout).toEqual([
      { id: "hero", variant: "photo" },
      { id: "faq", variant: "accordion" },
      { id: "services", variant: "cards" },
      { id: "trust", variant: "band" },
      { id: "testimonials", variant: "grid" },
      { id: "gallery", variant: "grid" },
      { id: "about", variant: "plain" },
      { id: "serviceArea", variant: "split" },
      { id: "contact", variant: "card" },
    ]);
  });

  it("matches service descriptions by name, including names that are Object.prototype keys", () => {
    const fixture = loadFixture("cleaning-minimal");
    const services = [{ name: "constructor" }, { name: "__proto__" }, { name: "toString" }];
    const { facts, ai } = split({
      ...fixture,
      facts: { ...fixture.facts, services },
      copy: {
        ...fixture.copy,
        serviceDescriptions: services.map((s) => ({ service: s.name, description: `AI text for ${s.name.replaceAll("_", "")}.` })),
      },
    });
    const owner = OwnerEdits.parse(JSON.parse(JSON.stringify({ ...edits(), copy: { serviceDescriptions: { constructor: "Owner  text." } } })));
    const composed = composeDocument(facts, ai, owner);
    expect(composed.copy.serviceDescriptions).toEqual([
      { service: "constructor", description: "Owner text." },
      { service: "__proto__", description: "AI text for proto." },
      { service: "toString", description: "AI text for toString." },
    ]);
    expect(issuesOf(composed)).toEqual([]);
  });

  it("leaves a new service's description empty so the document reports it", () => {
    const fixture = loadFixture("cleaning-minimal");
    const { facts, ai } = split(fixture);
    const grown = { ...(facts as Record<string, unknown>), services: [{ name: "House cleaning" }, { name: "Move-out cleaning" }, { name: "Window washing" }] };
    const composed = composeDocument(grown, ai, EMPTY_EDITS);
    expect(composed.copy.serviceDescriptions.at(-1)).toEqual({ service: "Window washing", description: "" });
    expect(issuesOf(composed)).toContain("copy.serviceDescriptions.2.description: Too small: expected string to have >=1 characters");
  });

  it("gives an empty service list when facts are not usable yet", () => {
    const { ai } = split(loadFixture("cleaning-minimal"));
    expect(composeDocument(null, ai, EMPTY_EDITS).copy.serviceDescriptions).toEqual([]);
    expect(composeDocument({ services: "oops" }, ai, EMPTY_EDITS).copy.serviceDescriptions).toEqual([]);
  });

  it("replaces the FAQ list with the owner's list", () => {
    const { facts, ai } = split(loadFixture("plumber-austin"));
    const composed = composeDocument(facts, ai, edits({ copy: { faq: [{ question: "Do you  clean up?", answer: "Always." }] } }));
    expect(composed.copy.faq).toEqual([{ question: "Do you clean up?", answer: "Always." }]);
  });

  it("never shares state: EMPTY_EDITS is frozen and the document gets its own hidden list", () => {
    expect([Object.isFrozen(EMPTY_EDITS), Object.isFrozen(EMPTY_EDITS.copy), Object.isFrozen(EMPTY_EDITS.hidden)]).toEqual([true, true, true]);
    const { facts, ai } = split(loadFixture("cleaning-minimal"));
    const owner = edits({ hidden: ["faq"] });
    const composed = composeDocument(facts, ai, owner);
    expect(composed.hidden).toEqual(["faq"]);
    expect(composed.hidden).not.toBe(owner.hidden);
  });
});

describe("SectionOrder", () => {
  it("accepts every section once with the hero first", () => {
    expect(SectionOrder.safeParse([...SECTION_IDS]).success).toBe(true);
  });

  it.each([
    ["a partial order", SECTION_IDS.slice(0, 5)],
    ["a duplicate", ["hero", "faq", "faq", ...SECTION_IDS.slice(3)]],
    ["hero not first", [...SECTION_IDS.slice(1), "hero"]],
  ])("rejects %s", (_label, order) => {
    expect(SectionOrder.safeParse(order).success).toBe(false);
  });
});

describe("ownerEditedPaths", () => {
  it("lists exactly the copy fields the owner set", () => {
    const { ai } = split(loadFixture("plumber-austin"));
    const paths = ownerEditedPaths(ai, edits({
      copy: { heroHeadline: "x", about: null, sectionIntros: { faq: "y" }, serviceDescriptions: { "Drain cleaning": "z" }, faq: [] },
    }));
    expect(paths).toEqual(["copy.heroHeadline", "copy.about", "copy.sectionIntros.faq", "copy.serviceDescriptions.Drain cleaning", "copy.faq"]);
    expect(ownerEditedPaths(ai, edits())).toEqual([]);
  });
});

describe("documentSha256", () => {
  it.each(FIXTURES)("is unchanged by re-parsing %s", async (name) => {
    const parsed = SiteDocument.parse(loadFixture(name));
    const reparsed = SiteDocument.parse(parsed);
    expect(canonicalJson(reparsed)).toBe(canonicalJson(parsed));
    expect(await documentSha256(reparsed)).toBe(await documentSha256(parsed));
  });

  it("ignores key order", async () => {
    const parsed = SiteDocument.parse(loadFixture("hvac-phoenix"));
    const reordered = JSON.parse(JSON.stringify({ theme: parsed.theme, layout: parsed.layout, hidden: parsed.hidden, copy: parsed.copy, facts: parsed.facts }));
    expect(await documentSha256(reordered)).toBe(await documentSha256(parsed));
  });
});

describe("photoRefIssues", () => {
  const siteId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  const up = { id: "0b0c2d3e-4f50-4a6b-8c7d-8e9fa0b1c2d3", width: 1600, height: 1200 };
  const url = mediaUrl("asksite.example", siteId, up.id);
  const photo = { url, alt: "A job", width: 1600, height: 1200 };

  it("accepts photos that are this site's uploads with matching sizes", () => {
    expect(photoRefIssues({ heroPhoto: photo, photos: [photo] }, siteId, "asksite.example", [up])).toEqual([]);
  });

  it("flags outside URLs, deleted uploads and size mismatches", () => {
    const issues = photoRefIssues(
      { heroPhoto: { ...photo, url: "https://evil.example/x.webp" }, photos: [photo, { ...photo, width: 10 }] },
      siteId,
      "asksite.example",
      [],
    );
    expect(issues.map((i) => [i.path.join("."), i.code])).toEqual([
      ["facts.heroPhoto.url", "photo_ref"],
      ["facts.photos.0.url", "photo_ref"],
      ["facts.photos.1.url", "photo_ref"],
    ]);
    const sized = photoRefIssues({ photos: [{ ...photo, height: 1 }] }, siteId, "asksite.example", [up]);
    expect(sized).toEqual([{ path: ["facts", "photos", 0, "url"], code: "photo_ref", message: "This photo's size does not match the upload; choose it again" }]);
  });

  it("flags another site's upload", () => {
    const other = mediaUrl("asksite.example", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", up.id);
    expect(photoRefIssues({ photos: [{ ...photo, url: other }] }, siteId, "asksite.example", [up])).toHaveLength(1);
  });

  it("returns nothing for facts that are not an object yet", () => {
    expect(photoRefIssues(null, siteId, "asksite.example", [up])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/core/test/compose.test.ts`
Expected: FAIL: `Test Files  1 failed (1)` with `TypeError: Cannot read properties of undefined (reading 'slice')` (`SECTION_IDS` is not exported yet).

- [ ] **Step 3: Write the implementation**

`packages/core/src/draft.ts`:

```ts
import { Copy, Layout, OwnerHidden, SECTION_VARIANTS, Theme, type SectionId } from "@asksite/site-schema";
import { z } from "zod";

/** What the model returns: Plan 1 copy, layout and theme. Owner facts never come from the model. */
export const AiDraft = z.strictObject({ copy: Copy, layout: Layout, theme: Theme });
export type AiDraft = z.infer<typeof AiDraft>;

const EditText = z.string().max(2000);

/** Owner wording edits. After composition every Plan 1 Copy rule applies to them (design §2.2). */
export const CopyEdits = z.strictObject({
  heroHeadline: EditText.optional(),
  heroSubheadline: EditText.optional(),
  ctaText: EditText.optional(),
  about: EditText.nullable().optional(), // null = remove the about text
  sectionIntros: z
    .strictObject({
      services: EditText.nullable().optional(),
      gallery: EditText.nullable().optional(),
      faq: EditText.nullable().optional(),
      contact: EditText.nullable().optional(),
    })
    .optional(),
  serviceDescriptions: z.record(z.string().max(40), EditText).optional(), // key = facts.services[].name, exact
  faq: z.array(z.strictObject({ question: EditText, answer: EditText })).max(8).optional(), // replaces the AI list
});
export type CopyEdits = z.infer<typeof CopyEdits>;

export const SECTION_IDS = Object.keys(SECTION_VARIANTS) as [SectionId, ...SectionId[]];

/** A full order: every section id exactly once, hero first. The editor always saves all of them
 *  (it lists only the visible ones and keeps the rest in place). */
export const SectionOrder = z
  .array(z.enum(SECTION_IDS))
  .length(SECTION_IDS.length)
  .refine((ids) => new Set(ids).size === ids.length && ids[0] === "hero", { error: "Order must list every section once, hero first" });

export const OwnerEdits = z.strictObject({
  baseGenerationId: z.string().nullable(), // copy and order edits apply only to this generation
  copy: CopyEdits,
  order: SectionOrder.nullable(),
  hidden: OwnerHidden, // A6 schema from @asksite/site-schema (unique, hideable ids only)
  theme: Theme.nullable(),
});
export type OwnerEdits = z.infer<typeof OwnerEdits>;

/** A site's edits before the owner changes anything. Frozen, arrays included: every caller shares it. */
export const EMPTY_EDITS: OwnerEdits = { baseGenerationId: null, copy: {}, order: null, hidden: [], theme: null };
Object.freeze(EMPTY_EDITS.copy);
Object.freeze(EMPTY_EDITS.hidden);
Object.freeze(EMPTY_EDITS);
```

`packages/core/src/compose.ts`:

```ts
import { SECTION_VARIANTS, type LayoutSection, type SiteDocument, type SiteDocumentInput } from "@asksite/site-schema";
import { SECTION_IDS, type AiDraft, type CopyEdits, type OwnerEdits } from "./draft.ts";
import type { Issue } from "./issues.ts";
import { mediaUrl } from "./keys.ts";
import { canonicalJson, sha256Hex } from "./tokens.ts";

export interface CurrentAi { generationId: string; draft: AiDraft }

/** SiteDocumentInput whose facts are unvalidated (they may be incomplete while drafting). */
export type ComposedDocument = Omit<SiteDocumentInput, "facts"> & { facts: unknown };

type Intros = NonNullable<ComposedDocument["copy"]["sectionIntros"]>;
const INTRO_KEYS = ["services", "gallery", "faq", "contact"] as const;

/** Owner strings: every whitespace run (including newlines) becomes one space. Nothing else changes. */
const tidy = (text: string): string => text.replace(/\s+/g, " ");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Optional field: null = leave it out, undefined = the AI value, a string = the owner's text. */
function optional(edit: string | null | undefined, ai: string | undefined): string | undefined {
  if (edit === null) return undefined;
  return edit === undefined ? ai : tidy(edit);
}

/** Every section id once: missing ones go directly before "contact" (at the end if there is none). */
function composeLayout(ai: AiDraft["layout"], order: OwnerEdits["order"]): LayoutSection[] {
  const listed = new Set(ai.map((s) => s.id));
  const missing = SECTION_IDS.filter((id) => !listed.has(id)).map((id) => ({ id, variant: SECTION_VARIANTS[id][0] }) as LayoutSection);
  const contactAt = ai.findIndex((s) => s.id === "contact");
  const layout = contactAt === -1 ? [...ai, ...missing] : [...ai.slice(0, contactAt), ...missing, ...ai.slice(contactAt)];
  if (order === null) return layout;
  const rank = new Map(order.map((id, i) => [id, i]));
  return layout.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
}

/**
 * Builds the page document. Never throws; validate the result with SiteDocument.safeParse.
 * Copy and order edits apply only while edits.baseGenerationId === ai.generationId; hidden and
 * theme always apply. Service descriptions are matched by the trimmed service name.
 */
export function composeDocument(facts: unknown, ai: CurrentAi, edits: OwnerEdits): ComposedDocument {
  const current = edits.baseGenerationId === ai.generationId;
  const e: CopyEdits = current ? edits.copy : {};
  const aiCopy = ai.draft.copy;

  const sectionIntros: Intros = {};
  for (const key of INTRO_KEYS) {
    const value = optional(e.sectionIntros?.[key], aiCopy.sectionIntros[key]);
    if (value !== undefined) sectionIntros[key] = value;
  }
  const about = optional(e.about, aiCopy.about);

  const services = isRecord(facts) && Array.isArray(facts.services) ? facts.services : [];
  const edited = e.serviceDescriptions ?? {};
  const serviceDescriptions = services.map((service: unknown) => {
    const name = isRecord(service) && typeof service.name === "string" ? service.name.trim() : "";
    const own = Object.hasOwn(edited, name) ? edited[name] : undefined;
    const description = own !== undefined ? tidy(own) : (aiCopy.serviceDescriptions.find((d) => d.service === name)?.description ?? "");
    return { service: name, description };
  });

  return {
    facts,
    copy: {
      heroHeadline: e.heroHeadline === undefined ? aiCopy.heroHeadline : tidy(e.heroHeadline),
      heroSubheadline: e.heroSubheadline === undefined ? aiCopy.heroSubheadline : tidy(e.heroSubheadline),
      ctaText: e.ctaText === undefined ? aiCopy.ctaText : tidy(e.ctaText),
      ...(about === undefined ? {} : { about }),
      sectionIntros,
      serviceDescriptions,
      faq: e.faq === undefined ? aiCopy.faq : e.faq.map((item) => ({ question: tidy(item.question), answer: tidy(item.answer) })),
    },
    layout: composeLayout(ai.draft.layout, current ? edits.order : null),
    theme: edits.theme ?? ai.draft.theme,
    hidden: [...edits.hidden], // a copy: the document never shares an array with the edits
  };
}

/** sha256Hex(canonicalJson(parsed)) for a parsed SiteDocument; used for document_sha256 and "Unpublished changes". */
export function documentSha256(parsed: SiteDocument): Promise<string> {
  return sha256Hex(canonicalJson(parsed));
}

/** Dotted paths of copy fields whose value came from the owner, e.g. "copy.heroHeadline", "copy.faq".
 *  A service description is "copy.serviceDescriptions.<service name>". */
export function ownerEditedPaths(ai: CurrentAi, edits: OwnerEdits): string[] {
  if (edits.baseGenerationId !== ai.generationId) return [];
  const copy = edits.copy;
  const paths: string[] = [];
  for (const key of ["heroHeadline", "heroSubheadline", "ctaText", "about"] as const) {
    if (copy[key] !== undefined) paths.push(`copy.${key}`);
  }
  for (const key of INTRO_KEYS) if (copy.sectionIntros?.[key] !== undefined) paths.push(`copy.sectionIntros.${key}`);
  for (const name of Object.keys(copy.serviceDescriptions ?? {})) paths.push(`copy.serviceDescriptions.${name}`);
  if (copy.faq !== undefined) paths.push("copy.faq");
  return paths;
}

/** Every facts photo (heroPhoto, photos[]) must equal mediaUrl(root, siteId, u.id) for a non-deleted upload u
 *  of this site, with width and height equal to the upload's. Returns issues at facts.heroPhoto.url etc. */
export function photoRefIssues(
  facts: unknown,
  siteId: string,
  root: string,
  uploads: ReadonlyArray<{ id: string; width: number; height: number }>,
): Issue[] {
  if (!isRecord(facts)) return [];
  const byUrl = new Map(uploads.map((u) => [mediaUrl(root, siteId, u.id), u]));
  const issues: Issue[] = [];
  const check = (photo: unknown, path: Array<string | number>) => {
    if (!isRecord(photo)) return;
    const upload = typeof photo.url === "string" ? byUrl.get(photo.url) : undefined;
    if (upload === undefined) {
      issues.push({ path: [...path, "url"], code: "photo_ref", message: "Choose a photo you uploaded for this site" });
    } else if (photo.width !== upload.width || photo.height !== upload.height) {
      issues.push({ path: [...path, "url"], code: "photo_ref", message: "This photo's size does not match the upload; choose it again" });
    }
  };
  check(facts.heroPhoto, ["facts", "heroPhoto"]);
  if (Array.isArray(facts.photos)) facts.photos.forEach((photo: unknown, i) => check(photo, ["facts", "photos", i]));
  return issues;
}
```

`packages/core/src/index.ts` (full new content):

```ts
export * from "./compose.ts";
export * from "./draft.ts";
export * from "./ids.ts";
export * from "./ip.ts";
export * from "./issues.ts";
export * from "./keys.ts";
export * from "./slug.ts";
export * from "./time.ts";
export * from "./tokens.ts";
```

- [ ] **Step 4: Run the core tests and the typecheck**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: `Test Files  4 passed (4)`, `Tests  86 passed (86)`; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/draft.ts packages/core/src/compose.ts packages/core/src/index.ts packages/core/test/compose.test.ts
git commit -m "Add draft composition"
```

---
### Task 4: `@asksite/core` contracts: brief, looks, limits, errors, rows, views and request bodies

**Files:**
- Create: `packages/core/src/{brief,looks,limits,errors,generation,audit,rows,views,api}.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/schemas.test.ts`

**Interfaces:**
- Consumes: `OwnerEdits`, `AiDraft` (Task 3), `TOKEN_PATTERN`, `Issue` (Task 2); `Theme`, `type Facts` from `@asksite/site-schema`.
- Produces (design §2.8, §4.2, §4.3, names verbatim): `TONES`, `GOALS`, `Brief`, `type Brief`; `LOOKS`; `LIMITS`; `ERROR_STATUS`, `type ErrorCode`, `interface ErrorBody`; `GENERATION_ERROR_CODES`, `type GenerationErrorCode`, `FALLBACK_REASONS`, `type FallbackReason`, `interface GenerationJob`, `interface GenerationInputSnapshot`; `AUDIT_ACTIONS`; the row interfaces `OwnerRow`, `SiteRow`, `InviteRow`, `LoginTokenRow`, `SessionRow`, `UploadRow`, `GenerationRow`, `SiteVersionRow`, `LeadRow`, `SettingRow`, `AuditRow`; the views `OwnerView`, `SiteSummary`, `GenerationView`, `VersionSummary`, `UploadView`, `SiteView`, `LeadView`, `InviteView`, `AdminSiteRow`, `ReviewChecks`, `AdminVersionDetail`, `AdminSettings`; the bodies `AcceptInviteBody`, `LoginBody`, `VerifyLoginBody`, `PatchDraftBody`, `SetSlugBody`, `PublishBody`, `CreateInviteBody`, `ApproveBody`, `RejectBody`, `TakedownBody`, `IndexableBody`, `DisableOwnerBody`, `SettingsBody`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/schemas.test.ts`:

```ts
import { PALETTE_IDS, Theme } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import {
  AcceptInviteBody,
  ApproveBody,
  AUDIT_ACTIONS,
  Brief,
  canonicalJson,
  EMPTY_EDITS,
  ERROR_STATUS,
  LIMITS,
  LOOKS,
  newToken,
  PatchDraftBody,
  SettingsBody,
  TakedownBody,
  type ErrorBody,
  type LeadView,
  type SiteRow,
  type VersionSummary,
} from "../src/index.ts";

describe("Brief", () => {
  it("fills defaults", () => {
    expect(Brief.parse({ tone: "friendly", goal: "call" })).toEqual({ tone: "friendly", goal: "call", comments: {}, reviewsAreReal: false });
  });

  it("keeps newlines in notes but rejects other control and invisible characters", () => {
    expect(Brief.safeParse({ tone: "friendly", goal: "call", notes: "Line one\nLine two" }).success).toBe(true);
    expect(Brief.safeParse({ tone: "friendly", goal: "call", notes: "a\u0007b" }).success).toBe(false);
    expect(Brief.safeParse({ tone: "friendly", goal: "call", notes: "a\u202Eb" }).success).toBe(false);
    expect(Brief.safeParse({ tone: "friendly", goal: "call", notes: "family \u{1F468}\u200D\u{1F469}" }).success).toBe(true);
  });

  it("caps comments at 20 and keys them by question id", () => {
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`q${i}`, "x"]));
    expect(Brief.safeParse({ tone: "friendly", goal: "call", comments: many }).success).toBe(false);
    expect(Brief.safeParse({ tone: "friendly", goal: "call", comments: { "Bad-Key": "x" } }).success).toBe(false);
    expect(Brief.safeParse({ tone: "friendly", goal: "call", comments: { services: "We do not do gas lines" } }).success).toBe(true);
  });

  it("rejects unknown keys", () => {
    expect(Brief.safeParse({ tone: "friendly", goal: "call", extra: 1 }).success).toBe(false);
  });
});

describe("request bodies", () => {
  it("accepts a real token and rejects anything else", () => {
    expect(AcceptInviteBody.safeParse({ token: newToken() }).success).toBe(true);
    expect(AcceptInviteBody.safeParse({ token: "short" }).success).toBe(false);
  });

  it("PatchDraftBody needs at least one part", () => {
    expect(PatchDraftBody.safeParse({ rev: 1 }).success).toBe(false);
    expect(PatchDraftBody.safeParse({ rev: 1, facts: {} }).success).toBe(true);
  });

  it("ApproveBody needs a lower-case sha256 and defaults indexable to true", () => {
    expect(ApproveBody.parse({ htmlSha256: "a".repeat(64) })).toEqual({ htmlSha256: "a".repeat(64), indexable: true });
    expect(ApproveBody.safeParse({ htmlSha256: "A".repeat(64) }).success).toBe(false);
  });

  it("TakedownBody and SettingsBody apply their caps", () => {
    expect(TakedownBody.parse({ reason: " phishing " })).toEqual({ reason: "phishing", purgeMedia: false });
    expect(TakedownBody.safeParse({ reason: "" }).success).toBe(false);
    expect(SettingsBody.safeParse({ dailyModelLimit: 1001 }).success).toBe(false);
  });
});

describe("constants", () => {
  it("maps error codes to HTTP statuses", () => {
    expect(ERROR_STATUS.site_taken_down).toBe(423);
    expect(ERROR_STATUS.email_failed).toBe(502);
    expect(ERROR_STATUS.rate_limited).toBe(429);
  });

  it("every look is a valid Plan 1 theme, and the four looks use four palettes", () => {
    for (const look of LOOKS) expect(Theme.safeParse(look.theme).success).toBe(true);
    expect(new Set(LOOKS.map((l) => l.theme.palette)).size).toBe(PALETTE_IDS.length);
  });

  it("keeps the agreed limits and lifetimes", () => {
    expect(LIMITS.leadsPerSitePerDay).toBe(50);
    expect(LIMITS.leadRetentionDays).toBe(180);
    expect(LIMITS.publishRequestsPerSitePerDay).toBe(20);
    expect(AUDIT_ACTIONS).toContain("site.taken_down");
  });
});

describe("row and view types", () => {
  it("describe the tables and API responses (checked by pnpm typecheck)", () => {
    const site: SiteRow = {
      id: "s", owner_id: "o", slug: null, facts_json: "{}", brief_json: "{}", edits_json: canonicalJson(EMPTY_EDITS), rev: 1,
      live_version_id: null, pending_version_id: null, indexable: 1, taken_down_at: null, takedown_reason: null, created_at: 1, updated_at: 1,
    };
    const version: VersionSummary = { id: "v", number: 1, status: "pending", requestedAt: 1, reviewedAt: null, reviewNote: null };
    const lead: LeadView = { id: "l", createdAt: 1, name: "n", phone: "p", email: null, service: null, message: null, emailStatus: "sent" };
    const body: ErrorBody = { error: { code: "conflict", message: "Changed elsewhere", currentRev: 2 } };
    expect([site.indexable, version.status, lead.emailStatus, ERROR_STATUS[body.error.code]]).toEqual([1, "pending", "sent", 409]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/core/test/schemas.test.ts`
Expected: FAIL: `Tests  12 failed (12)`, with errors such as `TypeError: Cannot read properties of undefined (reading 'parse')` and `TypeError: LOOKS is not iterable`.

- [ ] **Step 3: Write the implementation**

`packages/core/src/brief.ts`:

```ts
import { z } from "zod";

export const TONES = ["friendly", "professional", "no-nonsense"] as const;
export const GOALS = ["call", "quote", "book"] as const;

// Same hidden-character rule as Facts text (\p{Cc} and \p{Cf} rejected, U+200D allowed), except "\n" is also allowed.
const briefText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((s) => !/(?!\n)\p{Cc}|(?!\u200D)\p{Cf}/u.test(s), { error: "Invisible or control characters are not allowed" });

/** What the owner tells us about tone and goals. Sent to the model as data; never rendered. */
export const Brief = z.strictObject({
  tone: z.enum(TONES),
  goal: z.enum(GOALS),
  differentiator: briefText(140).optional(), // "What makes you different?"
  notes: briefText(2000).optional(), // "Pretend you're texting a friend..."
  comments: z
    .record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/), briefText(500))
    .refine((c) => Object.keys(c).length <= 20)
    .default({}), // per-question comments, keyed by question id
  reviewsAreReal: z.boolean().default(false), // owner attests pasted reviews are real (FTC)
});
export type Brief = z.infer<typeof Brief>;
```

`packages/core/src/looks.ts`:

```ts
import type { Theme } from "@asksite/site-schema";

/** Named theme presets the owner can switch between in the editor (Plan 1 proves their contrast). */
export const LOOKS = [
  { id: "classic", name: "Classic", theme: { palette: "navy-orange", font: "clean" } },
  { id: "bright", name: "Bright", theme: { palette: "blue-yellow", font: "friendly" } },
  { id: "outdoor", name: "Outdoor", theme: { palette: "green-amber", font: "sturdy" } },
  { id: "bold", name: "Bold", theme: { palette: "charcoal-red", font: "sturdy" } },
] as const satisfies ReadonlyArray<{ id: string; name: string; theme: Theme }>;
```

`packages/core/src/limits.ts`:

```ts
// Defaults; the caps are the user's call (design §12). Every one is an exact D1 count.
export const LIMITS = {
  generationsPerSitePerDay: 5,
  generationsPerOwnerTotal: 20,
  defaultDailyModelLimit: 30, // model-calling jobs per UTC day, all owners (overridden by settings / env)
  uploadsPerSite: 40, // non-deleted
  uploadsPerSiteTotal: 150, // every upload ever, soft-deleted included: bounds R2 and Images spend
  uploadMaxBytes: 10 * 1024 * 1024,
  loginTokensPerOwnerPerHour: 5,
  loginTokensPerOwnerPerDay: 10,
  leadsPerSitePerDay: 50,
  leadRetentionDays: 180,
  publishRequestsPerSitePerDay: 20, // publish clicks (versions) per site per UTC day: bounds D1 and R2 growth (Plan 2 Decision 25)
  factsJsonMaxBytes: 65_536,
  briefJsonMaxBytes: 16_384,
  editsJsonMaxBytes: 65_536,
} as const;
```

`packages/core/src/errors.ts`:

```ts
import type { Issue } from "./issues.ts";

/** Every API error code and its HTTP status. */
export const ERROR_STATUS = {
  bad_request: 400, unauthenticated: 401, forbidden: 403, owner_disabled: 403, not_found: 404,
  conflict: 409, slug_taken: 409, slug_locked: 409, generation_in_progress: 409,
  nothing_pending: 409, version_not_pending: 409,
  invite_invalid: 410, token_invalid: 410,
  payload_too_large: 413, unsupported_media_type: 415,
  validation_failed: 422, not_ready: 422, publish_invalid: 422, slug_invalid: 422, image_rejected: 422,
  site_taken_down: 423,
  rate_limited: 429, generation_cap_reached: 429, upload_limit_reached: 429,
  internal: 500, email_failed: 502, generation_disabled: 503, budget_exhausted: 503,
} as const;
export type ErrorCode = keyof typeof ERROR_STATUS;
export interface ErrorBody {
  error: { code: ErrorCode; message: string; issues?: Issue[]; retryAfter?: number; currentRev?: number };
}
```

`packages/core/src/generation.ts`:

```ts
import type { Facts } from "@asksite/site-schema";
import type { Brief } from "./brief.ts";

// Types shared with Plan 3 (generation).
export const GENERATION_ERROR_CODES = ["generation_disabled", "budget_exhausted",
  "provider_unavailable", "provider_timeout", "invalid_output", "internal"] as const;
export type GenerationErrorCode = (typeof GENERATION_ERROR_CODES)[number];
export const FALLBACK_REASONS = ["disabled", "budget", "provider_error", "invalid_output"] as const; // "budget" = today's model limit reached
export type FallbackReason = (typeof FALLBACK_REASONS)[number];
export interface GenerationJob { v: 1; generationId: string } // everything else is read from the row
export interface GenerationInputSnapshot { facts: Facts; brief: Brief } // stored in generations.input_json
```

`packages/core/src/audit.ts`:

```ts
/** Every audit_log.action value. */
export const AUDIT_ACTIONS = ["invite.created", "invite.revoked", "invite.accepted", "auth.login",
  "generation.requested", "version.requested", "version.withdrawn", "version.approved", "version.rejected",
  "site.taken_down", "site.restored", "site.indexable_changed", "owner.disabled", "owner.enabled",
  "settings.updated"] as const;
```

`packages/core/src/rows.ts`:

```ts
// One interface per D1 table (migrations/0001_init.sql), fields named exactly as the columns.
// Times are epoch milliseconds; INTEGER 0/1 flags are typed 0 | 1.

export interface OwnerRow {
  id: string;
  email: string;
  created_at: number;
  disabled_at: number | null;
  disabled_reason: string | null;
}

export interface SiteRow {
  id: string;
  owner_id: string;
  slug: string | null;
  facts_json: string;
  brief_json: string;
  edits_json: string;
  rev: number;
  live_version_id: string | null;
  pending_version_id: string | null;
  indexable: 0 | 1;
  taken_down_at: number | null;
  takedown_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface InviteRow {
  id: string;
  token_hash: string;
  email: string;
  created_by: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  revoked_at: number | null;
  owner_id: string | null;
  site_id: string | null;
}

export interface LoginTokenRow {
  token_hash: string;
  owner_id: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
}

export interface SessionRow {
  id_hash: string;
  owner_id: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
}

export interface UploadRow {
  id: string;
  site_id: string;
  width: number;
  height: number;
  bytes: number;
  created_at: number;
  deleted_at: number | null;
}

export interface GenerationRow {
  id: string;
  site_id: string;
  owner_id: string;
  kind: "first" | "regenerate";
  status: "queued" | "running" | "succeeded" | "failed";
  input_json: string;
  output_json: string | null;
  used_fallback: 0 | 1;
  fallback_reason: string | null;
  model_slot: 0 | 1;
  provider: string | null;
  model: string | null;
  attempts: number;
  input_tokens: number;
  output_tokens: number;
  cost_microusd: number;
  error_code: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface SiteVersionRow {
  id: string;
  site_id: string;
  number: number;
  status: "pending" | "approved" | "rejected" | "withdrawn" | "superseded";
  document_json: string;
  document_sha256: string;
  edits_json: string;
  generation_id: string | null;
  html_key: string;
  html_sha256: string;
  stylesheet_sha256: string;
  requested_by: string;
  requested_at: number;
  reviewed_by: string | null;
  reviewed_at: number | null;
  review_note: string | null;
}

export interface LeadRow {
  id: string;
  site_id: string;
  created_at: number;
  name: string;
  phone: string;
  email: string | null;
  service: string | null;
  message: string | null;
  spam: 0 | 1;
  email_status: "pending" | "sent" | "failed" | "skipped";
  email_error: string | null;
  ip_hash: string;
}

export interface SettingRow {
  key: string;
  value: string;
  updated_at: number;
  updated_by: string;
}

export interface AuditRow {
  id: number;
  at: number;
  actor: string;
  action: string;
  site_id: string | null;
  detail_json: string | null;
}
```

`packages/core/src/views.ts`:

```ts
import type { AiDraft, OwnerEdits } from "./draft.ts";
import type { FallbackReason, GenerationErrorCode } from "./generation.ts";
import type { Issue } from "./issues.ts";

// Response shapes of the owner and admin APIs (design §4.2).

export interface OwnerView { id: string; email: string }
export interface SiteSummary { id: string; slug: string | null; businessName: string | null; live: boolean; inReview: boolean; takenDown: boolean }
export interface GenerationView {
  id: string; kind: "first" | "regenerate"; status: "queued" | "running" | "succeeded" | "failed";
  createdAt: number; finishedAt: number | null; errorCode: GenerationErrorCode | null;
  usedFallback: boolean; fallbackReason: FallbackReason | null;
}
export interface VersionSummary {
  id: string; number: number; status: "pending" | "approved" | "rejected" | "withdrawn" | "superseded";
  requestedAt: number; reviewedAt: number | null; reviewNote: string | null;
}
export interface UploadView { id: string; url: string; width: number; height: number; bytes: number; createdAt: number }
export interface SiteView {
  id: string; slug: string | null; rev: number;
  live: boolean; inReview: boolean; takenDown: boolean; liveUrl: string | null;
  facts: unknown; brief: unknown; edits: OwnerEdits;
  ai: { generationId: string; draft: AiDraft; usedFallback: boolean } | null;
  activeGeneration: GenerationView | null;
  pendingVersion: VersionSummary | null; liveVersion: VersionSummary | null;
  draftDiffersFromLive: boolean;
  uploads: UploadView[];
  limits: { generationsLeftToday: number; generationsLeftTotal: number };
  issues: { facts: Issue[]; brief: Issue[]; photos: Issue[]; document: Issue[] }; // document: [] when ai is null
}
export interface LeadView {
  id: string; createdAt: number; name: string; phone: string; email: string | null;
  service: string | null; message: string | null; emailStatus: "pending" | "sent" | "failed" | "skipped";
}
export interface InviteView { id: string; email: string; createdBy: string; createdAt: number; expiresAt: number; usedAt: number | null; revokedAt: number | null; siteId: string | null }
export interface AdminSiteRow extends SiteSummary { ownerId: string; ownerEmail: string; ownerDisabled: boolean; indexable: boolean; createdAt: number; updatedAt: number }
export interface ReviewChecks {
  firstPublish: boolean; testimonials: number; reviewsAttested: boolean; hiddenSections: string[];
  socialHosts: string[]; photoCount: number; usedFallbackCopy: boolean; slugFlags: string[];
  textFlags: Array<{ path: string; reason: "web_address" | "at_sign" | "other_phone" | "phishing_word" }>;
}
export interface AdminVersionDetail {
  version: VersionSummary & { siteId: string; htmlSha256: string; generationId: string | null; requestedBy: string };
  site: AdminSiteRow; document: unknown; ownerEditedPaths: string[];
  liveDocument: unknown | null; checks: ReviewChecks; pageUrl: string; // "/api/admin/versions/<id>/page"
}
export interface AdminSettings {
  generationEnabled: boolean; envGenerationEnabled: boolean; dailyModelLimit: number;
  modelCallsToday: number; spentTodayMicrousd: number;
  worstCaseDailyMicrousd: number; // dailyModelLimit x worst-case cost of one job for the configured model
}
```

`packages/core/src/api.ts`:

```ts
import { z } from "zod";
import { OwnerEdits } from "./draft.ts";
import { TOKEN_PATTERN } from "./tokens.ts";

// Request bodies of the owner and admin APIs (design §4.3). Emails are trimmed and lower-cased
// before use; a body that fails its schema gets 422 validation_failed with issues.

const Token = z.string().regex(TOKEN_PATTERN);
const Rev = z.int().min(1);
const Json = z.record(z.string(), z.unknown());
export const AcceptInviteBody = z.strictObject({ token: Token });
export const LoginBody = z.strictObject({ email: z.email().max(254) });
export const VerifyLoginBody = z.strictObject({ token: Token });
export const PatchDraftBody = z
  .strictObject({ rev: Rev, facts: Json.optional(), brief: Json.optional(), edits: OwnerEdits.optional() })
  .refine((b) => b.facts !== undefined || b.brief !== undefined || b.edits !== undefined, { error: "Nothing to save" });
export const SetSlugBody = z.strictObject({ rev: Rev, slug: z.string().max(40) });
export const PublishBody = z.strictObject({ rev: Rev });
export const CreateInviteBody = z.strictObject({ email: z.email().max(254) }); // always emailed
export const ApproveBody = z.strictObject({
  htmlSha256: z.string().regex(/^[0-9a-f]{64}$/), // the version's html_sha256 as shown to the admin
  note: z.string().trim().max(1000).optional(),
  indexable: z.boolean().default(true),
});
export const RejectBody = z.strictObject({ note: z.string().trim().min(1).max(1000) });
export const TakedownBody = z.strictObject({
  reason: z.string().trim().min(1).max(1000),
  ownerMessage: z.string().trim().max(1000).optional(),
  purgeMedia: z.boolean().default(false),
});
export const IndexableBody = z.strictObject({ indexable: z.boolean() });
export const DisableOwnerBody = z.strictObject({ reason: z.string().trim().min(1).max(1000) });
export const SettingsBody = z.strictObject({
  generationEnabled: z.boolean().optional(),
  dailyModelLimit: z.int().min(0).max(1000).optional(),
});
```

`packages/core/src/index.ts` (full new content):

```ts
export * from "./api.ts";
export * from "./audit.ts";
export * from "./brief.ts";
export * from "./compose.ts";
export * from "./draft.ts";
export * from "./errors.ts";
export * from "./generation.ts";
export * from "./ids.ts";
export * from "./ip.ts";
export * from "./issues.ts";
export * from "./keys.ts";
export * from "./limits.ts";
export * from "./looks.ts";
export * from "./rows.ts";
export * from "./slug.ts";
export * from "./time.ts";
export * from "./tokens.ts";
export * from "./views.ts";
```

- [ ] **Step 4: Run the core tests and the typecheck**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: `Test Files  5 passed (5)`, `Tests  98 passed (98)`; typecheck exits 0 (it also checks the row and view types used in the last test).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src packages/core/test/schemas.test.ts
git commit -m "Add core contracts"
```

---
### Task 5: The D1 schema, proven in workerd

**Files:**
- Modify: `package.json` (dev dependencies `wrangler`, `@cloudflare/workers-types`; `test` runs two Vitest projects), `pnpm-workspace.yaml`, `vitest.config.ts` (projects `unit` and `workerd`)
- Create: `packages/core/migrations/0001_init.sql`
- Test: `packages/core/test/support/noop-worker.ts`, `packages/core/test/migration.workerd.test.ts`

**Interfaces:**
- Consumes: `EMPTY_EDITS`, `OwnerEdits` (Task 3); `createTestHarness` from `wrangler` 4.138.0 (`server.listen()`, `getWorker().applyD1Migrations("DB")`, `getWorker().getEnv()`, `server.close()`) [verified: exported by wrangler 4.138.0, runs under Vitest 5.0.1].
- Produces: `packages/core/migrations/0001_init.sql` (design §2.6, every table and index); the test Worker `packages/core/test/support/noop-worker.ts` (later tasks reuse it to get real local bindings); the proof that local D1 enforces foreign keys, allows many `NULL` slugs but no duplicate slug, enforces the partial unique index `generations_one_active`, the CHECK constraints and `UNIQUE (site_id, number)`, and that three racing single-use-token updates yield exactly one `changes = 1` (design §2.6, §5.1).

- [ ] **Step 1: Add wrangler, the Workers types and a separate Vitest project for workerd tests**

Stage 0 runs before any other plan starts, so `pnpm-workspace.yaml` and `vitest.config.ts` are still Plan 1's files and may be written whole. Check that first:

Run: `git diff --exit-code main -- pnpm-workspace.yaml vitest.config.ts && echo UNCHANGED_SINCE_PLAN1`
Expected: `UNCHANGED_SINCE_PLAN1`. If a diff prints instead, another plan has changed one of them: stop and ask the moderator.

`pnpm-workspace.yaml` (Plan 1's file plus `apps/*` and two deliberately ignored build scripts):

```yaml
packages:
  - "packages/*"
  - "apps/*"

ignoredBuiltDependencies:
  - "@parcel/watcher"
  - "esbuild"
  - "workerd"
```

`vitest.config.ts` (full new content):

```ts
import { configDefaults, defineConfig } from "vitest/config";

// Two projects that `pnpm test` runs one after the other. "unit": pure tests (all of Plan 1's).
// "workerd": tests that start workerd through wrangler's test harness (*.workerd.test.ts), kept apart
// so workerd never competes for CPU with Plan 1's timing-sensitive property tests. The globs cover
// every package and every apps/<worker>, so later plans add tests without editing this file.
const WORKERD = ["packages/*/test/**/*.workerd.test.ts", "apps/*/test/**/*.workerd.test.ts"];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "scripts/**/*.test.ts"],
          exclude: [...configDefaults.exclude, ...WORKERD],
          // Plan 1's seeded property test takes about 0.8 s alone but passed Vitest's 5 s default on a
          // heavily loaded machine (Decision 23). A hanging test still fails, after 30 s.
          testTimeout: 30_000,
        },
      },
      {
        test: { name: "workerd", include: WORKERD, testTimeout: 30_000, hookTimeout: 120_000 },
      },
    ],
  },
});
```

Every test that starts workerd through the harness is named `*.workerd.test.ts` and runs in the `workerd` project, after the `unit` project, so it never competes for CPU with Plan 1's timing-sensitive tests (Decision 23). The `apps/*/test` globs mean neither Task 11 nor Plans 3 and 4 edit this file again (Decision 31). `apps/*` in the workspace is for the Worker folders (Task 11). pnpm 10 does not run dependencies' install scripts unless allowed; wrangler, `wrangler dev` and the test harness work without the `esbuild` and `workerd` scripts [verified], so they are listed as deliberately ignored, which also silences pnpm's warning.

Then the root `package.json`, by targeted edits (Global Constraints): the two tools, and `test` running the `unit` project, then the `workerd` project. `@asksite/core`'s migration test starts workerd, so that package declares `wrangler` too.

```bash
npm pkg get scripts.test
pnpm add -D -w --save-exact wrangler@4.138.0 @cloudflare/workers-types@5.20260924.1
pnpm add -D --save-exact --filter @asksite/core wrangler@4.138.0
npm pkg set scripts.test="pnpm build:css && vitest run --project unit && vitest run --project workerd"
git diff --stat -- package.json packages/core/package.json
```

Expected: first `"pnpm build:css && vitest run"` (if something else prints, another plan changed `test`: make the same change by hand, keeping their part); both `pnpm add` runs end with `Done in …s using pnpm v10.33.0` and no "Ignored build scripts" warning; then `package.json | 6 ++++--` and `packages/core/package.json | 3 ++-`: the `test` line, `"@cloudflare/workers-types": "5.20260924.1"` and `"wrangler": "4.138.0"` (exact versions, no `^`; the line before gains a comma), and `wrangler` in the core package's `devDependencies`.

- [ ] **Step 2: Write the failing test**

`packages/core/test/support/noop-worker.ts`:

```ts
// The smallest Worker: tests use it only to get real local D1 bindings from createTestHarness.
export default {
  fetch(): Response {
    return new Response("ok");
  },
};
```

`packages/core/test/migration.workerd.test.ts`:

```ts
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";
import { EMPTY_EDITS, OwnerEdits } from "../src/index.ts";

// Applies packages/core/migrations to a real local D1 (workerd through wrangler's test harness)
// and proves the constraints the rest of the system relies on.
const server = createTestHarness({
  root: resolve(import.meta.dirname, "../../.."),
  workers: [
    {
      config: {
        name: "core-migration-test",
        main: "packages/core/test/support/noop-worker.ts",
        compatibility_date: "2026-09-21",
        d1_databases: [
          { binding: "DB", database_name: "asksite", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: "packages/core/migrations" },
        ],
      },
    },
  ],
});

// Typed loosely on purpose: this file is type-checked without the Workers runtime types.
let db: { prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<{ meta: { changes: number } }>; first<T>(): Promise<T | null> }; all<T>(): Promise<{ results: T[] }> } };

beforeAll(async () => {
  await server.listen();
  const worker = server.getWorker();
  await worker.applyD1Migrations("DB");
  db = (await worker.getEnv()).DB;
}, 120_000);
afterAll(async () => {
  await server.close();
});

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SITE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("0001_init.sql", () => {
  it("creates every table", async () => {
    const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name <> 'd1_migrations' ORDER BY name").all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual([
      "audit_log", "dev_outbox", "generations", "invites", "leads", "login_tokens", "owners", "sessions", "settings", "site_versions", "sites", "uploads",
    ]);
  });

  it("gives a new site the empty OwnerEdits and rev 1", async () => {
    await db.prepare("INSERT INTO owners (id, email, created_at) VALUES (?, ?, ?)").bind(OWNER, "owner@example.com", 1).run();
    await db.prepare("INSERT INTO sites (id, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(SITE, OWNER, 1, 1).run();
    const row = await db.prepare("SELECT edits_json, rev, indexable, slug FROM sites WHERE id = ?").bind(SITE).first<{ edits_json: string; rev: number; indexable: number; slug: string | null }>();
    expect(OwnerEdits.parse(JSON.parse(row?.edits_json ?? "null"))).toEqual(EMPTY_EDITS);
    expect(row).toMatchObject({ rev: 1, indexable: 1, slug: null });
  });

  it("enforces foreign keys", async () => {
    await expect(
      db.prepare("INSERT INTO sites (id, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?)").bind("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "no-such-owner", 1, 1).run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it("allows many sites without a slug but never two with the same slug", async () => {
    const insert = (id: string, slug: string | null) =>
      db.prepare("INSERT INTO sites (id, owner_id, slug, created_at, updated_at) VALUES (?, ?, ?, 1, 1)").bind(id, OWNER, slug).run();
    await insert("dddddddd-dddd-4ddd-8ddd-dddddddddddd", null);
    await insert("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "joes");
    await expect(insert("ffffffff-ffff-4fff-8fff-ffffffffffff", "joes")).rejects.toThrow(/UNIQUE constraint failed: sites.slug/);
  });

  it("allows at most one queued or running generation per site (partial unique index)", async () => {
    const insert = (id: string, status: string) =>
      db.prepare("INSERT INTO generations (id, site_id, owner_id, kind, status, input_json, created_at) VALUES (?, ?, ?, 'first', ?, '{}', 1)").bind(id, SITE, OWNER, status).run();
    await insert("10000000-0000-4000-8000-000000000001", "succeeded");
    await insert("10000000-0000-4000-8000-000000000002", "queued");
    await expect(insert("10000000-0000-4000-8000-000000000003", "queued")).rejects.toThrow(/UNIQUE constraint failed: generations.site_id/);
    await expect(insert("10000000-0000-4000-8000-000000000004", "running")).rejects.toThrow(/UNIQUE constraint failed/);
    await insert("10000000-0000-4000-8000-000000000005", "failed");
  });

  it("rejects values outside the CHECK constraints", async () => {
    await expect(db.prepare("UPDATE sites SET indexable = 2 WHERE id = ?").bind(SITE).run()).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      db.prepare("INSERT INTO leads (id, site_id, created_at, name, phone, email_status, ip_hash) VALUES ('l1', ?, 1, 'n', 'p', 'lost', 'h')").bind(SITE).run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("numbers versions uniquely per site", async () => {
    const insert = (id: string, n: number) =>
      db.prepare(
        "INSERT INTO site_versions (id, site_id, number, status, document_json, document_sha256, edits_json, html_key, html_sha256, stylesheet_sha256, requested_by, requested_at) VALUES (?, ?, ?, 'pending', '{}', 'd', '{}', 'k', 'h', 's', ?, 1)",
      ).bind(id, SITE, n, OWNER).run();
    await insert("20000000-0000-4000-8000-000000000001", 1);
    await expect(insert("20000000-0000-4000-8000-000000000002", 1)).rejects.toThrow(/UNIQUE constraint failed: site_versions.site_id, site_versions.number/);
  });

  it("consumes a single-use token exactly once, even when two verifies race", async () => {
    await db.prepare("INSERT INTO login_tokens (token_hash, owner_id, created_at, expires_at) VALUES ('t1', ?, 1, ?)").bind(OWNER, Number.MAX_SAFE_INTEGER).run();
    const consume = () =>
      db.prepare("UPDATE login_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?").bind(2, "t1", 2).run();
    const results = await Promise.all([consume(), consume(), consume()]);
    expect(results.map((r) => r.meta.changes).sort()).toEqual([0, 0, 1]);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm vitest run packages/core/test/migration.workerd.test.ts`
Expected: FAIL: `Error: No migrations present at …/packages/core/migrations.` and `Tests  8 skipped (8)`.

- [ ] **Step 4: Write the migration**

`packages/core/migrations/0001_init.sql`:

```sql
-- asksite schema v1 (design §2.6). All times are Unix epoch milliseconds. All ids are
-- crypto.randomUUID(). Emails are stored trimmed and lower-cased. Money is integer micro-USD.

CREATE TABLE owners (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  disabled_at INTEGER,
  disabled_reason TEXT
);

CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  slug TEXT UNIQUE,
  facts_json TEXT NOT NULL DEFAULT '{}',
  brief_json TEXT NOT NULL DEFAULT '{}',
  edits_json TEXT NOT NULL DEFAULT '{"baseGenerationId":null,"copy":{},"order":null,"hidden":[],"theme":null}',
  rev INTEGER NOT NULL DEFAULT 1,
  live_version_id TEXT,
  pending_version_id TEXT,
  indexable INTEGER NOT NULL DEFAULT 1 CHECK (indexable IN (0, 1)),
  taken_down_at INTEGER,
  takedown_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX sites_owner ON sites(owner_id);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  revoked_at INTEGER,
  owner_id TEXT REFERENCES owners(id),
  site_id TEXT REFERENCES sites(id)
);

CREATE TABLE login_tokens (
  token_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX login_tokens_owner ON login_tokens(owner_id, created_at);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX sessions_owner ON sessions(owner_id);

CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX uploads_site ON uploads(site_id);

CREATE TABLE generations (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  owner_id TEXT NOT NULL REFERENCES owners(id),
  kind TEXT NOT NULL CHECK (kind IN ('first', 'regenerate')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  input_json TEXT NOT NULL,
  output_json TEXT,
  used_fallback INTEGER NOT NULL DEFAULT 0 CHECK (used_fallback IN (0, 1)),
  fallback_reason TEXT,
  model_slot INTEGER NOT NULL DEFAULT 0 CHECK (model_slot IN (0, 1)), -- 1 = this job took one of today's model calls
  provider TEXT,
  model TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_microusd INTEGER NOT NULL DEFAULT 0, -- reporting only; limits are counts
  error_code TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX generations_site ON generations(site_id, created_at);
CREATE INDEX generations_owner ON generations(owner_id);
CREATE INDEX generations_slots ON generations(model_slot, started_at);
CREATE UNIQUE INDEX generations_one_active ON generations(site_id) WHERE status IN ('queued', 'running');

CREATE TABLE site_versions (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn', 'superseded')),
  document_json TEXT NOT NULL,          -- canonicalJson of the parsed SiteDocument that was rendered
  document_sha256 TEXT NOT NULL,        -- sha256Hex(document_json)
  edits_json TEXT NOT NULL,             -- OwnerEdits snapshot (provenance for review)
  generation_id TEXT REFERENCES generations(id),
  html_key TEXT NOT NULL,
  html_sha256 TEXT NOT NULL,
  stylesheet_sha256 TEXT NOT NULL,
  requested_by TEXT NOT NULL,           -- owner id
  requested_at INTEGER NOT NULL,
  reviewed_by TEXT,                     -- admin email
  reviewed_at INTEGER,
  review_note TEXT,
  UNIQUE (site_id, number)
);
CREATE INDEX site_versions_status ON site_versions(status, requested_at);

CREATE TABLE leads (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  created_at INTEGER NOT NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  service TEXT,
  message TEXT,
  spam INTEGER NOT NULL DEFAULT 0 CHECK (spam IN (0, 1)),
  email_status TEXT NOT NULL CHECK (email_status IN ('pending', 'sent', 'failed', 'skipped')),
  email_error TEXT,
  ip_hash TEXT NOT NULL
);
CREATE INDEX leads_site ON leads(site_id, created_at);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,                  -- 'admin:<email>' | 'owner:<id>' | 'system'
  action TEXT NOT NULL,                 -- one of AUDIT_ACTIONS
  site_id TEXT,
  detail_json TEXT
);
CREATE INDEX audit_site ON audit_log(site_id, at);

CREATE TABLE dev_outbox (               -- written only by LogMailer (development/test); never in production
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  text TEXT NOT NULL,
  tag TEXT NOT NULL
);
```

- [ ] **Step 5: Run the core tests and the typecheck**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: `Test Files  6 passed (6)`, `Tests  106 passed (106)`; typecheck exits 0. Then the leftover check (Global Constraints) prints `nothing left running` (the harness stopped its workerd).

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml pnpm-workspace.yaml vitest.config.ts packages/core/package.json packages/core/migrations/0001_init.sql packages/core/test/support/noop-worker.ts packages/core/test/migration.workerd.test.ts
git commit -m "Add D1 schema"
```

---
### Task 6: `@asksite/site-css`, and proof that a Worker renders exactly like Node

**Files:**
- Modify: `package.json` (`build:css` chains the new build; `typecheck` builds first), `.gitignore`
- Create: `packages/site-css/package.json`, `packages/site-css/scripts/build.ts`, `packages/site-css/src/index.ts`
- Generate: `packages/site-css/src/generated.ts` (by `pnpm build:css`; gitignored)
- Test: `packages/site-css/test/site-css.test.ts`, `packages/site-css/test/worker-render.workerd.test.ts`, `packages/site-css/test/support/render-probe.ts`, `packages/site-css/test/support/probe-form-action.ts`

**Interfaces:**
- Consumes: Plan 1's compiled `packages/renderer/styles/site.css` (`pnpm --filter @asksite/renderer run build:css`) and `render`; `sha256Hex` (Task 2); `createTestHarness` (Task 5).
- Produces: `SITE_CSS: string`, `SITE_CSS_SHA256: string` from `@asksite/site-css`; the root `pnpm build:css` now builds both; the proof (design §11.1, §11.3 "spikes") that wrangler's bundler handles Plan 1's `.ts` imports and that zod + `render()` run inside workerd, producing byte-identical pages for all five fixtures.

- [ ] **Step 1: Add the package and the build wiring**

`packages/site-css/package.json` (its tests hash with `@asksite/core`, render with `@asksite/renderer` and start workerd):

```json
{
  "name": "@asksite/site-css",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "build": "node scripts/build.ts"
  },
  "devDependencies": {
    "@asksite/core": "workspace:*",
    "@asksite/renderer": "workspace:*",
    "wrangler": "4.138.0"
  }
}
```

Then the root files, by targeted edits: `build:css` also runs `@asksite/site-css`'s build, `typecheck` runs `pnpm build:css` first (because `src/generated.ts` is gitignored), and `.gitignore` gets one block.

```bash
npm pkg get scripts.build:css scripts.typecheck
npm pkg set scripts.build:css="pnpm --filter @asksite/renderer run build:css && pnpm --filter @asksite/site-css run build" scripts.typecheck="pnpm build:css && tsc -p . && tsc -p e2e"
cat >> .gitignore <<'EOF'

# Generated by pnpm build:css (packages/site-css/scripts/build.ts)
packages/site-css/src/generated.ts
EOF
pnpm install
git diff --stat -- package.json .gitignore
```

Expected: first

```text
{
  "scripts.build:css": "pnpm --filter @asksite/renderer run build:css",
  "scripts.typecheck": "tsc -p . && tsc -p e2e"
}
```

(if either value differs, another plan changed it: make the same change by hand, keeping their part); `pnpm install` ends with `Done in …s using pnpm v10.33.0`; then `.gitignore | 3 +++` and `package.json | 4 ++--`.

- [ ] **Step 2: Write the failing tests**

`packages/site-css/test/site-css.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { sha256Hex } from "@asksite/core";
import { describe, expect, it } from "vitest";
import { SITE_CSS, SITE_CSS_SHA256 } from "../src/index.ts";

describe("@asksite/site-css", () => {
  it("is exactly the renderer's compiled stylesheet", () => {
    expect(SITE_CSS).toBe(readFileSync(new URL("../../renderer/styles/site.css", import.meta.url), "utf8"));
    expect(SITE_CSS).toContain("tailwindcss v4.3.3");
  });

  it("carries the SHA-256 that core's sha256Hex computes", async () => {
    expect(SITE_CSS_SHA256).toBe(await sha256Hex(SITE_CSS));
    expect(SITE_CSS_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("can be inlined: render() refuses a stylesheet containing </style", () => {
    expect(SITE_CSS).not.toMatch(/<\/style/i);
  });
});
```

`packages/site-css/test/support/probe-form-action.ts`:

```ts
// Shared by the render probe Worker and its test. A Worker's main module may export only
// handlers (workerd refuses other named exports), so the constant lives here.
export const PROBE_FORM_ACTION = "https://joes.asksite.example/_f/7c9e6679-7425-40de-944b-e07fc1f90ae7";
```

`packages/site-css/test/support/render-probe.ts`:

```ts
// A throwaway Worker for tests: renders the POSTed SiteDocument with the shared stylesheet, so a
// test can prove zod + render() bundle and run inside workerd exactly as they do in Node.
import { render } from "@asksite/renderer";
import type { SiteDocumentInput } from "@asksite/site-schema";
import { SITE_CSS } from "../../src/index.ts";
import { PROBE_FORM_ACTION } from "./probe-form-action.ts";

export default {
  async fetch(request: Request): Promise<Response> {
    const doc = (await request.json()) as SiteDocumentInput;
    try {
      const page = render(doc, { stylesheet: SITE_CSS, formAction: PROBE_FORM_ACTION });
      return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
    } catch (error) {
      return new Response(error instanceof Error ? error.name : "Error", { status: 422 });
    }
  },
};
```

`packages/site-css/test/worker-render.workerd.test.ts`:

```ts
import { resolve } from "node:path";
import { render } from "@asksite/renderer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";
import { FIXTURES, loadFixture } from "../../../fixtures/index.ts";
import { SITE_CSS } from "../src/index.ts";
import { PROBE_FORM_ACTION } from "./support/probe-form-action.ts";

// Proves the Worker bundle: wrangler (esbuild) bundles @asksite/renderer, zod and the generated
// stylesheet, and workerd renders every fixture byte-for-byte like Node does.
const server = createTestHarness({
  root: resolve(import.meta.dirname, "../../.."),
  workers: [{ config: { name: "render-probe", main: "packages/site-css/test/support/render-probe.ts", compatibility_date: "2026-09-21" } }],
});

beforeAll(async () => {
  await server.listen();
}, 120_000);
afterAll(async () => {
  await server.close();
});

describe("render() inside workerd", () => {
  it.each(FIXTURES)("renders %s exactly as Node does", async (name) => {
    const doc = loadFixture(name);
    const response = await server.fetch("https://probe.localhost/", { method: "POST", body: JSON.stringify(doc) });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(render(doc, { stylesheet: SITE_CSS, formAction: PROBE_FORM_ACTION }));
  });

  it("rejects an invalid document inside the Worker too", async () => {
    const doc = loadFixture("cleaning-minimal");
    const response = await server.fetch("https://probe.localhost/", {
      method: "POST",
      body: JSON.stringify({ ...doc, copy: { ...doc.copy, heroHeadline: "Call 512-555-0142" } }),
    });
    expect(response.status).toBe(422);
    expect(await response.text()).toBe("ZodError");
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `pnpm vitest run packages/site-css`
Expected: FAIL: `Test Files  2 failed (2)`, both with `Error: Cannot find module '../src/index.ts'`.

- [ ] **Step 4: Write the implementation and build**

`packages/site-css/scripts/build.ts`:

```ts
// Turns the renderer's compiled stylesheet into a TypeScript module, so Workers can import it
// (wrangler bundles .ts but has no CSS loader). Run by the root `pnpm build:css` after
// `@asksite/renderer`'s build:css. Output: src/generated.ts (gitignored).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const css = readFileSync(new URL("../../renderer/styles/site.css", import.meta.url), "utf8");
if (css.length === 0) throw new Error("packages/renderer/styles/site.css is empty; run the renderer build:css first");
const sha256 = createHash("sha256").update(css, "utf8").digest("hex");

writeFileSync(
  new URL("../src/generated.ts", import.meta.url),
  `// Generated by packages/site-css/scripts/build.ts. Do not edit.\n` +
    `export const SITE_CSS: string = ${JSON.stringify(css)};\n` +
    `export const SITE_CSS_SHA256: string = ${JSON.stringify(sha256)};\n`,
);
console.log(`wrote packages/site-css/src/generated.ts (${css.length} bytes, sha256 ${sha256})`);
```

`packages/site-css/src/index.ts`:

```ts
/** The shared compiled stylesheet every page inlines, and its SHA-256 (stored on each version for audit). */
export { SITE_CSS, SITE_CSS_SHA256 } from "./generated.ts";
```

Run: `pnpm build:css`
Expected: the Tailwind build prints `≈ tailwindcss v4.3.3` and `Done in …ms`, then `wrote packages/site-css/src/generated.ts (<n> bytes, sha256 <64 hex>)` (final replay, Plan 1 at `77f01b6`: 25202 bytes).

- [ ] **Step 5: Run the tests, the typecheck and the whole suite**

Run: `pnpm vitest run packages/site-css`
Expected: `Test Files  2 passed (2)`, `Tests  9 passed (9)`: all five fixtures render byte-for-byte the same inside workerd as in Node.

Run: `pnpm typecheck && pnpm test && git status --short -- fixtures/golden && git check-ignore packages/site-css/src/generated.ts`
Expected: typecheck exits 0; the `unit` run `Test Files  P+8 passed`, `Tests  T+115 passed` and the `workerd` run `Test Files  2 passed (2)`, `Tests  14 passed (14)` (planning replay: 31 / 670, then 2 / 14), no snapshot written; `git status` prints nothing; `git check-ignore` prints `packages/site-css/src/generated.ts`.

- [ ] **Step 6: Stage 0 gate: Plan 1's browser tests still pass**

Run: `pnpm test:e2e`
Expected: the same totals as Plan 1's final run, `0 failed` (Plan 1's plan recorded `124 passed`, `24 skipped`; the final replay, with Plan 1's own screenshot baselines, got that too). Rendered HTML did not change (Step 5's goldens), so no screenshot baseline may change either. Then the leftover check (Global Constraints) prints `nothing left running`.

On a heavily loaded machine one of Plan 1's slowest browser tests can pass Playwright's 30 s test timeout (the final replay, at a load average near 150: "roofing-extreme › passes axe …" on `chromium-390` took 31.7 s, `Error: page.evaluate: Test timeout of 30000ms exceeded.`; it took 6.5–14 s in earlier replays). Only for a failure whose sole error is `Test timeout of 30000ms exceeded`, run that test again by itself, for example `pnpm test:e2e --project chromium-390 --grep "roofing-extreme passes axe"` (the group title, a space, then the start of the test title). It must pass; report it to the moderator either way. Any other failure, or a timeout that repeats when the test runs alone, is a regression: stop.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml .gitignore packages/site-css/package.json packages/site-css/scripts/build.ts packages/site-css/src/index.ts packages/site-css/test
git commit -m "Add site stylesheet"
```

Stage 0 is complete: tell the moderator, who can start Plans 3 and 4 against `@asksite/core` now.

---
## Part B: Plan 2, hosting, publishing and leads

### Task 7: `@asksite/mailer` (Resend, and a local outbox)

**Files:**
- Modify: `tsconfig.json` (exclude the Worker-side code), `package.json` (`typecheck` adds the Workers program)
- Create: `tsconfig.workers.json` (every Worker-side folder of this plan, final), `packages/mailer/package.json`, `packages/mailer/src/{types,resend,log,index}.ts`
- Test: `packages/mailer/test/resend.test.ts`, `packages/mailer/test/log.workerd.test.ts`

**Interfaces:**
- Consumes: the `dev_outbox` table (Task 5); `createTestHarness` (Task 5).
- Produces: `@asksite/mailer` exactly as listed under "Interfaces this plan provides". Resend request [verified against resend.com/docs/api-reference/emails/send-email]: `POST https://api.resend.com/emails`, headers `Authorization: Bearer <key>`, `Content-Type: application/json`, `Idempotency-Key` (keys expire after 24 h, at most 256 characters), body `{ from, to: [to], subject, html, text, reply_to? }`, response `{ id }`. Status mapping (design §7.6): 429 → `rate_limited`, other 4xx → `rejected`, 5xx, network failure or a 10 s timeout → `unavailable`. Error messages carry only the status: never the key, the recipient or Resend's reply.

- [ ] **Step 1: Add the package and the Workers type-check program**

`packages/mailer/package.json` (its log-mailer test starts workerd):

```json
{
  "name": "@asksite/mailer",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "devDependencies": {
    "wrangler": "4.138.0"
  }
}
```

`tsconfig.workers.json` (new; it lists every Worker-side folder this plan creates, up front, so no later task edits it; TypeScript skips an `include` entry whose folder does not exist yet [verified: `tsc -p tsconfig.workers.json` exits 0 here, before `packages/publishing` and `apps/sites` exist]):

```json
{
  // Worker-side code and its tests: the Workers runtime types next to Node's. They cannot join the
  // root program: there the Workers global URL type breaks Plan 1's node:fs calls (verified).
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "types": ["node", "@cloudflare/workers-types"]
  },
  "include": [
    "packages/mailer/src",
    "packages/mailer/test",
    "packages/publishing/src",
    "packages/publishing/test",
    "apps/sites/src",
    "apps/sites/test",
    "apps/sites/dev"
  ],
  "exclude": []
}
```

The root program must leave the same folders out (Decisions 5 and 22).

In `tsconfig.json`, replace

```json
  "include": ["packages/*/src", "packages/*/test", "fixtures", "scripts", "vitest.config.ts"]
```

with

```json
  "include": ["packages/*/src", "packages/*/test", "fixtures", "scripts", "vitest.config.ts"],
  "exclude": ["packages/mailer", "packages/publishing", "apps/sites"]
```

If the `include` line already differs (another plan added entries), keep it exactly as it is: only add the comma and the `exclude` line.

Then the root `package.json`: `typecheck` also checks the Workers program.

```bash
npm pkg get scripts.typecheck
npm pkg set scripts.typecheck="pnpm build:css && tsc -p . && tsc -p e2e && tsc -p tsconfig.workers.json"
pnpm install
git diff --stat -- package.json tsconfig.json
```

Expected: first `"pnpm build:css && tsc -p . && tsc -p e2e"` (if it differs, another plan changed it: append ` && tsc -p tsconfig.workers.json` by hand instead); `pnpm install` ends with `Done in …s using pnpm v10.33.0`; then `package.json | 2 +-` and `tsconfig.json | 3 ++-`.

- [ ] **Step 2: Write the failing tests**

`packages/mailer/test/resend.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MailerError, ResendMailer, type OutgoingEmail } from "../src/index.ts";

const KEY = "re_test_not_a_real_key";
const EMAIL: OutgoingEmail = {
  to: "owner@example.com",
  subject: "New request from your website: Dana",
  text: "Hello",
  html: "<p>Hello</p>",
  replyTo: "dana@example.com",
  tag: "lead",
  idempotencyKey: "lead:7c9e6679-7425-40de-944b-e07fc1f90ae7",
};

interface Captured { url: string; init: RequestInit }

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: Captured[] = [];
  const fn = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond();
  };
  return { calls, fn };
}

async function failure(mailer: ResendMailer, email: OutgoingEmail = EMAIL): Promise<MailerError> {
  try {
    await mailer.send(email);
  } catch (error) {
    if (error instanceof MailerError) return error;
    throw error;
  }
  throw new Error("send did not fail");
}

describe("ResendMailer", () => {
  it("posts the documented request and returns Resend's id", async () => {
    const fake = fakeFetch(() => Response.json({ id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" }));
    const mailer = new ResendMailer(KEY, "asksite <leads@mail.asksite.example>", fake.fn);
    expect(await mailer.send(EMAIL)).toEqual({ id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" });
    expect(fake.calls).toHaveLength(1);
    const [call] = fake.calls;
    expect(call?.url).toBe("https://api.resend.com/emails");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.headers).toEqual({
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": EMAIL.idempotencyKey,
    });
    expect(JSON.parse(String(call?.init.body))).toEqual({
      from: "asksite <leads@mail.asksite.example>",
      to: ["owner@example.com"],
      subject: EMAIL.subject,
      html: EMAIL.html,
      text: EMAIL.text,
      reply_to: "dana@example.com",
    });
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("leaves reply_to out when there is none", async () => {
    const fake = fakeFetch(() => Response.json({ id: "x" }));
    const { replyTo: _dropped, ...noReply } = EMAIL;
    await new ResendMailer(KEY, "a@b.example", fake.fn).send(noReply);
    expect(JSON.parse(String(fake.calls[0]?.init.body))).not.toHaveProperty("reply_to");
  });

  it("strips CR, LF and other control characters from the subject", async () => {
    const fake = fakeFetch(() => Response.json({ id: "x" }));
    await new ResendMailer(KEY, "a@b.example", fake.fn).send({ ...EMAIL, subject: "Hi\r\nBcc: victim@example.com\u0007" });
    expect(JSON.parse(String(fake.calls[0]?.init.body)).subject).toBe("HiBcc: victim@example.com");
  });

  it("refuses an address with a line break before calling Resend", async () => {
    const fake = fakeFetch(() => Response.json({ id: "x" }));
    const error = await failure(new ResendMailer(KEY, "a@b.example", fake.fn), { ...EMAIL, replyTo: "a@b.example\r\nBcc: x@y.example" });
    expect(error.code).toBe("rejected");
    expect(fake.calls).toHaveLength(0);
  });

  it.each([
    [429, "rate_limited"],
    [400, "rejected"],
    [403, "rejected"],
    [422, "rejected"],
    [500, "unavailable"],
    [503, "unavailable"],
  ] as const)("maps HTTP %i to %s", async (status, code) => {
    const fake = fakeFetch(() => new Response(JSON.stringify({ message: "owner@example.com is invalid" }), { status }));
    const error = await failure(new ResendMailer(KEY, "a@b.example", fake.fn));
    expect(error.code).toBe(code);
    expect(error.message).toBe(`Resend returned ${status}`);
  });

  it("maps a network failure or timeout to unavailable", async () => {
    const error = await failure(new ResendMailer(KEY, "a@b.example", () => Promise.reject(new DOMException("timed out", "TimeoutError"))));
    expect(error.code).toBe("unavailable");
  });

  it("treats a 2xx without an id as unavailable", async () => {
    const error = await failure(new ResendMailer(KEY, "a@b.example", fakeFetch(() => new Response("{}")).fn));
    expect(error.code).toBe("unavailable");
  });

  it("is misconfigured without a key or sender, and never calls Resend", async () => {
    const fake = fakeFetch(() => Response.json({ id: "x" }));
    expect((await failure(new ResendMailer("", "a@b.example", fake.fn))).code).toBe("misconfigured");
    expect((await failure(new ResendMailer(KEY, "", fake.fn))).code).toBe("misconfigured");
    expect(fake.calls).toHaveLength(0);
  });

  it("never puts the key, the recipient or Resend's reply into an error message", async () => {
    const fake = fakeFetch(() => new Response(JSON.stringify({ message: "owner@example.com rejected" }), { status: 422 }));
    const error = await failure(new ResendMailer(KEY, "a@b.example", fake.fn));
    expect(error.message).not.toContain(KEY);
    expect(error.message).not.toContain("owner@example.com");
  });
});
```

`packages/mailer/test/log.workerd.test.ts`:

```ts
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";
import { createMailer, LogMailer, MailerError, type OutgoingEmail } from "../src/index.ts";

const server = createTestHarness({
  root: resolve(import.meta.dirname, "../../.."),
  workers: [
    {
      config: {
        name: "mailer-log-test",
        main: "packages/core/test/support/noop-worker.ts",
        compatibility_date: "2026-09-21",
        d1_databases: [{ binding: "DB", database_name: "asksite", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: "packages/core/migrations" }],
      },
    },
  ],
});
let DB: D1Database;

beforeAll(async () => {
  await server.listen();
  const worker = server.getWorker<{ DB: D1Database }>();
  await worker.applyD1Migrations("DB");
  DB = (await worker.getEnv()).DB;
}, 120_000);
afterAll(async () => {
  await server.close();
});

const EMAIL: OutgoingEmail = {
  to: "owner@example.com",
  subject: "New request\r\nfrom your website",
  text: "Name: Dana",
  html: "<p>Name: Dana</p>",
  tag: "lead",
  idempotencyKey: "lead:1",
};

describe("LogMailer", () => {
  it("writes the email to dev_outbox with a cleaned subject", async () => {
    const { id } = await new LogMailer(DB, "development").send(EMAIL);
    expect(id).toMatch(/^log:\d+$/);
    const row = await DB.prepare("SELECT to_addr, subject, text, tag FROM dev_outbox ORDER BY id DESC LIMIT 1").first();
    expect(row).toEqual({ to_addr: "owner@example.com", subject: "New requestfrom your website", text: "Name: Dana", tag: "lead" });
  });

  it("refuses to run unless ENVIRONMENT is exactly development, so a typo fails closed", async () => {
    for (const environment of ["production", "prod", "", "Development"]) {
      await expect(new LogMailer(DB, environment).send(EMAIL)).rejects.toMatchObject({ code: "misconfigured" });
    }
  });
});

describe("createMailer", () => {
  it("returns the log mailer for MAILER=log", async () => {
    const mailer = createMailer({ MAILER: "log", MAIL_FROM: "a@b.example", DB, ENVIRONMENT: "development" });
    expect(mailer).toBeInstanceOf(LogMailer);
  });

  it("fails closed on an unknown MAILER value", async () => {
    const mailer = createMailer({ MAILER: "smtp" as "log", MAIL_FROM: "a@b.example", DB, ENVIRONMENT: "development" });
    const error = await mailer.send(EMAIL).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MailerError);
    expect((error as MailerError).code).toBe("misconfigured");
  });

  it("uses Resend for MAILER=resend and is misconfigured without a key", async () => {
    const mailer = createMailer({ MAILER: "resend", MAIL_FROM: "a@b.example", DB, ENVIRONMENT: "production" });
    await expect(mailer.send(EMAIL)).rejects.toMatchObject({ code: "misconfigured" });
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `pnpm vitest run packages/mailer`
Expected: FAIL: `Test Files  2 failed (2)`, both with `Error: Cannot find module '../src/index.ts'`.

- [ ] **Step 4: Write the implementation**

`packages/mailer/src/types.ts`:

```ts
export type EmailTag = "lead" | "magic_link" | "invite" | "review_result" | "site_notice" | "admin_alert"; // site_notice: takedown message to the owner

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  tag: EmailTag;
  idempotencyKey: string;
}

export interface Mailer {
  send(email: OutgoingEmail): Promise<{ id: string }>;
}

export type MailerErrorCode = "rate_limited" | "rejected" | "unavailable" | "misconfigured";

// Written with an explicit field: the repo's tsconfig sets erasableSyntaxOnly, which forbids
// constructor parameter properties. The public shape is the design's `readonly code`.
export class MailerError extends Error {
  readonly code: MailerErrorCode;

  constructor(code: MailerErrorCode, message: string) {
    super(message);
    this.name = "MailerError";
    this.code = code;
  }
}

// Header safety, applied by every Mailer whatever template built the email: subjects lose control
// characters (CR and LF included) and addresses containing any control character are refused.
const CONTROL = /\p{Cc}/gu;

export function cleanSubject(subject: string): string {
  return subject.replace(CONTROL, "").trim();
}

export function assertAddresses(email: OutgoingEmail): void {
  for (const address of [email.to, email.replyTo]) {
    if (address !== undefined && (address === "" || /\p{Cc}/u.test(address))) {
      throw new MailerError("rejected", "Email address is empty or contains a control character");
    }
  }
}
```

`packages/mailer/src/resend.ts`:

```ts
import { assertAddresses, cleanSubject, MailerError, type Mailer, type OutgoingEmail } from "./types.ts";

const ENDPOINT = "https://api.resend.com/emails";
const TIMEOUT_MS = 10_000;

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Resend's HTTP API (POST /emails with an Idempotency-Key). Error messages carry only the HTTP
 * status, never the key, the recipient or Resend's response body.
 */
export class ResendMailer implements Mailer {
  readonly #apiKey: string;
  readonly #from: string;
  readonly #fetch: Fetch;

  // The default is a wrapper, not a stored reference to `fetch`: calling a detached `fetch` with
  // the wrong `this` throws "Illegal invocation" in workerd.
  constructor(apiKey: string, from: string, fetchFn: Fetch = (input, init) => fetch(input, init)) {
    this.#apiKey = apiKey;
    this.#from = from;
    this.#fetch = fetchFn;
  }

  async send(email: OutgoingEmail): Promise<{ id: string }> {
    if (this.#apiKey === "" || this.#from === "") throw new MailerError("misconfigured", "RESEND_API_KEY and MAIL_FROM must be set");
    assertAddresses(email);
    const body = {
      from: this.#from,
      to: [email.to],
      subject: cleanSubject(email.subject),
      html: email.html,
      text: email.text,
      ...(email.replyTo === undefined ? {} : { reply_to: email.replyTo }),
    };

    let response: Response;
    try {
      response = await this.#fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": email.idempotencyKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new MailerError("unavailable", "Resend could not be reached");
    }

    if (response.status === 429) throw new MailerError("rate_limited", "Resend returned 429");
    if (response.status >= 400 && response.status < 500) throw new MailerError("rejected", `Resend returned ${response.status}`);
    if (!response.ok) throw new MailerError("unavailable", `Resend returned ${response.status}`);
    const result: unknown = await response.json().catch(() => null);
    const id = typeof result === "object" && result !== null && "id" in result ? result.id : undefined;
    if (typeof id !== "string") throw new MailerError("unavailable", "Resend returned no email id");
    return { id };
  }
}
```

`packages/mailer/src/log.ts`:

```ts
import { assertAddresses, cleanSubject, MailerError, type Mailer, type OutgoingEmail } from "./types.ts";

/** Development and test mailer: writes each email to the dev_outbox table. It runs only when ENVIRONMENT is
 *  exactly "development" (Decision 30), so a typo or an empty value can never store sign-in links in production. */
export class LogMailer implements Mailer {
  readonly #db: D1Database;
  readonly #environment: string;

  constructor(db: D1Database, environment: string) {
    this.#db = db;
    this.#environment = environment;
  }

  async send(email: OutgoingEmail): Promise<{ id: string }> {
    if (this.#environment !== "development") throw new MailerError("misconfigured", "The log mailer runs only when ENVIRONMENT is development");
    assertAddresses(email);
    const result = await this.#db
      .prepare("INSERT INTO dev_outbox (at, to_addr, subject, text, tag) VALUES (?, ?, ?, ?, ?)")
      .bind(Date.now(), email.to, cleanSubject(email.subject), email.text, email.tag)
      .run();
    return { id: `log:${result.meta.last_row_id}` };
  }
}
```

`packages/mailer/src/index.ts`:

```ts
import { LogMailer } from "./log.ts";
import { ResendMailer } from "./resend.ts";
import { MailerError, type Mailer } from "./types.ts";

export { LogMailer } from "./log.ts";
export { ResendMailer } from "./resend.ts";
export { MailerError, type EmailTag, type Mailer, type MailerErrorCode, type OutgoingEmail } from "./types.ts";

/** Picks the mailer from configuration. A missing key or an unknown MAILER fails on send, as "misconfigured". */
export function createMailer(env: {
  MAILER: "resend" | "log";
  MAIL_FROM: string;
  RESEND_API_KEY?: string;
  DB: D1Database;
  ENVIRONMENT: string;
}): Mailer {
  const kind: string = env.MAILER;
  if (kind === "resend") return new ResendMailer(env.RESEND_API_KEY ?? "", env.MAIL_FROM);
  if (kind === "log") return new LogMailer(env.DB, env.ENVIRONMENT);
  return {
    send: () => Promise.reject(new MailerError("misconfigured", "MAILER must be resend or log")),
  };
}
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `pnpm vitest run packages/mailer && pnpm typecheck`
Expected: `Test Files  2 passed (2)`, `Tests  19 passed (19)`; typecheck exits 0 (all three programs).

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json tsconfig.workers.json packages/mailer
git commit -m "Add mailer"
```

---
### Task 8: Publishing: `createPendingVersion` and `withdrawPending`

**Files:**
- Create: `packages/publishing/package.json`, `packages/publishing/src/{errors,shared,versions,index}.ts`
- Test: `packages/publishing/test/support/harness.ts`, `packages/publishing/test/support/errors.ts`, `packages/publishing/test/versions.workerd.test.ts`

**Interfaces:**
- Consumes: `SiteDocument` (Plan 1 + A6), `render` (Plan 1), `SITE_CSS`, `SITE_CSS_SHA256` (Task 6), `canonicalJson`, `documentSha256`, `formActionUrl`, `versionKey`, `newId`, `sha256Hex`, `toIssues`, `utcDayStart`, `LIMITS`, `AUDIT_ACTIONS`, `type OwnerEdits`, `type VersionSummary` (Tasks 2–4), the tables (Task 5). `tsconfig.workers.json` already lists `packages/publishing` (Task 7).
- Produces: `PublishError` (explicit fields, Decision 2), `type PublishErrorCode`, `createPendingVersion`, `withdrawPending` (signatures under "Interfaces this plan provides"); internal helpers `auditIfChanged`, `sha256OfBytes`, `verifiedVersionBytes`, `HTML_TYPE` in `shared.ts`. Test support used by Tasks 9 and 10: `publishingHarness(name)`, `seedSite(db)`, `doc(fixture)`, `EDITS`, `auditActions`, `siteRow`, `versionRow`, `publishFailure`.
- Behaviour (design §7.1, §7.2, plus Decision 25): at most `LIMITS.publishRequestsPerSitePerDay` (20) version requests per site per UTC day, checked by a cheap count before rendering and again inside the D1 batch, so racing requests cannot pass it together (`publish_cap_reached`, `detail: { retryAfter }` in seconds until 00:00 UTC; nothing is stored). The page is rendered with `SITE_CSS` and `formActionUrl(ROOT_DOMAIN, slug, siteId)`; the exact bytes go to `WORK: versions/<siteId>/<versionId>.html` with `contentType` and `customMetadata { siteId, versionId, sha256 }`; then one D1 batch supersedes the pending version, inserts the new one as `pending` with `number = max + 1`, points `sites.pending_version_id` at it and writes the `version.requested` audit row.

- [ ] **Step 1: Add the package**

`packages/publishing/package.json` (its tests start workerd):

```json
{
  "name": "@asksite/publishing",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@asksite/core": "workspace:*",
    "@asksite/renderer": "workspace:*",
    "@asksite/site-css": "workspace:*",
    "@asksite/site-schema": "workspace:*"
  },
  "devDependencies": {
    "wrangler": "4.138.0"
  }
}
```

Run: `pnpm install`
Expected: `Done in …s using pnpm v10.33.0`.

- [ ] **Step 2: Write the test support and the failing tests**

`packages/publishing/test/support/harness.ts`:

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EMPTY_EDITS, newId, type OwnerEdits } from "@asksite/core";
import { SiteDocument } from "@asksite/site-schema";
import { createTestHarness } from "wrangler";

/** The bindings the publishing functions use, backed by real local D1 and R2 (workerd). */
export interface PublishEnv {
  DB: D1Database;
  WORK: R2Bucket;
  LIVE: R2Bucket;
  MEDIA: R2Bucket;
  ROOT_DOMAIN: string;
}

export const ROOT = "asksite.example";

export function publishingHarness(name: string) {
  const server = createTestHarness({
    root: resolve(import.meta.dirname, "../../../.."),
    workers: [
      {
        config: {
          name,
          main: "packages/core/test/support/noop-worker.ts",
          compatibility_date: "2026-09-21",
          d1_databases: [{ binding: "DB", database_name: "asksite", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: "packages/core/migrations" }],
          r2_buckets: [
            { binding: "WORK", bucket_name: "asksite-work" },
            { binding: "LIVE", bucket_name: "asksite-live" },
            { binding: "MEDIA", bucket_name: "asksite-media" },
          ],
        },
      },
    ],
  });
  return {
    server,
    async start(): Promise<PublishEnv> {
      await server.listen();
      const worker = server.getWorker<Omit<PublishEnv, "ROOT_DOMAIN">>();
      await worker.applyD1Migrations("DB");
      return { ...(await worker.getEnv()), ROOT_DOMAIN: ROOT };
    },
  };
}

let counter = 0;

/** A fresh owner and site with a slug. Each test gets its own ids and slug, so tests never share rows. */
export async function seedSite(db: D1Database): Promise<{ ownerId: string; siteId: string; slug: string }> {
  counter += 1;
  const ownerId = newId();
  const siteId = newId();
  const slug = `site-${counter}-${siteId.slice(0, 8)}`;
  await db.batch([
    db.prepare("INSERT INTO owners (id, email, created_at) VALUES (?, ?, 1)").bind(ownerId, `${ownerId}@example.com`),
    db.prepare("INSERT INTO sites (id, owner_id, slug, created_at, updated_at) VALUES (?, ?, ?, 1, 1)").bind(siteId, ownerId, slug),
  ]);
  return { ownerId, siteId, slug };
}

/** A Plan 1 fixture, parsed. Read by path (not through fixtures/index.ts, whose node:fs + URL calls do
 *  not type-check next to the Workers runtime types in tsconfig.workers.json). */
export function doc(name: "plumber-austin" | "hvac-phoenix" | "cleaning-minimal" | "electrical-xss" | "roofing-extreme" = "plumber-austin"): SiteDocument {
  const path = resolve(import.meta.dirname, "../../../../fixtures", `${name}.json`);
  return SiteDocument.parse(JSON.parse(readFileSync(path, "utf8")));
}

export const EDITS: OwnerEdits = EMPTY_EDITS;

export async function auditActions(db: D1Database, siteId: string): Promise<string[]> {
  const { results } = await db.prepare("SELECT action FROM audit_log WHERE site_id = ? ORDER BY id").bind(siteId).all<{ action: string }>();
  return results.map((r) => r.action);
}

export async function siteRow(db: D1Database, siteId: string) {
  return db
    .prepare("SELECT live_version_id, pending_version_id, indexable, taken_down_at, takedown_reason FROM sites WHERE id = ?")
    .bind(siteId)
    .first<{ live_version_id: string | null; pending_version_id: string | null; indexable: number; taken_down_at: number | null; takedown_reason: string | null }>();
}

export async function versionRow(db: D1Database, versionId: string) {
  return db.prepare("SELECT * FROM site_versions WHERE id = ?").bind(versionId).first<Record<string, unknown>>();
}
```

`packages/publishing/test/support/errors.ts`:

```ts
import { PublishError } from "../../src/index.ts";

/** Awaits a call that must fail with a PublishError and returns it. */
export async function publishFailure(promise: Promise<unknown>): Promise<PublishError> {
  const error = await promise.then(() => null, (e: unknown) => e);
  if (!(error instanceof PublishError)) throw new Error(`expected a PublishError, got ${String(error)}`);
  return error;
}
```

`packages/publishing/test/versions.workerd.test.ts`:

```ts
import { canonicalJson, documentSha256, formActionUrl, LIMITS, sha256Hex, versionKey } from "@asksite/core";
import { render } from "@asksite/renderer";
import { SITE_CSS, SITE_CSS_SHA256 } from "@asksite/site-css";
import type { SiteDocument } from "@asksite/site-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPendingVersion, withdrawPending } from "../src/index.ts";
import { publishFailure as failure } from "./support/errors.ts";
import { auditActions, doc, EDITS, publishingHarness, ROOT, seedSite, siteRow, versionRow, type PublishEnv } from "./support/harness.ts";

const harness = publishingHarness("publishing-versions-test");
let env: PublishEnv;
beforeAll(async () => {
  env = await harness.start();
}, 120_000);
afterAll(async () => {
  await harness.server.close();
});

describe("createPendingVersion", () => {
  it("stores the exact rendered page and a pending version pointing at it", async () => {
    const { ownerId, siteId, slug } = await seedSite(env.DB);
    const document = doc();
    const summary = await createPendingVersion(env, { siteId, ownerId, slug, document, edits: EDITS, generationId: null, now: 1000 });
    expect(summary).toMatchObject({ number: 1, status: "pending", requestedAt: 1000, reviewedAt: null, reviewNote: null });

    const expected = render(document, { stylesheet: SITE_CSS, formAction: formActionUrl(ROOT, slug, siteId) });
    const object = await env.WORK.get(versionKey(siteId, summary.id));
    expect(await object?.text()).toBe(expected);
    expect(object?.httpMetadata?.contentType).toBe("text/html; charset=utf-8");
    expect(object?.customMetadata).toEqual({ siteId, versionId: summary.id, sha256: await sha256Hex(expected) });
    expect(expected).toContain(`action="https://${slug}.asksite.example/_f/${siteId}"`);

    expect(await versionRow(env.DB, summary.id)).toMatchObject({
      site_id: siteId, number: 1, status: "pending",
      document_json: canonicalJson(document), document_sha256: await documentSha256(document),
      edits_json: canonicalJson(EDITS), generation_id: null,
      html_key: versionKey(siteId, summary.id), html_sha256: await sha256Hex(expected), stylesheet_sha256: SITE_CSS_SHA256,
      requested_by: ownerId, requested_at: 1000, reviewed_by: null,
    });
    expect((await siteRow(env.DB, siteId))?.pending_version_id).toBe(summary.id);
    expect(await auditActions(env.DB, siteId)).toEqual(["version.requested"]);
  });

  it("supersedes the version already in review", async () => {
    const { ownerId, siteId, slug } = await seedSite(env.DB);
    const first = await createPendingVersion(env, { siteId, ownerId, slug, document: doc(), edits: EDITS, generationId: null, now: 1 });
    const second = await createPendingVersion(env, { siteId, ownerId, slug, document: doc("hvac-phoenix"), edits: EDITS, generationId: null, now: 2 });
    expect(second.number).toBe(2);
    expect((await versionRow(env.DB, first.id))?.status).toBe("superseded");
    expect((await versionRow(env.DB, second.id))?.status).toBe("pending");
    expect((await siteRow(env.DB, siteId))?.pending_version_id).toBe(second.id);
  });

  it("stores the parsed document whatever the caller passed", async () => {
    const { ownerId, siteId, slug } = await seedSite(env.DB);
    const document = doc();
    const untrimmed = { ...document, copy: { ...document.copy, heroHeadline: `  ${document.copy.heroHeadline}  ` } } as SiteDocument;
    const summary = await createPendingVersion(env, { siteId, ownerId, slug, document: untrimmed, edits: EDITS, generationId: null, now: 1 });
    expect((await versionRow(env.DB, summary.id))?.document_sha256).toBe(await documentSha256(document));
  });

  it("refuses an invalid document with its issues and writes nothing", async () => {
    const { ownerId, siteId, slug } = await seedSite(env.DB);
    const document = doc();
    const invalid = { ...document, copy: { ...document.copy, heroHeadline: "Call 512-555-0142" } } as SiteDocument;
    const error = await failure(createPendingVersion(env, { siteId, ownerId, slug, document: invalid, edits: EDITS, generationId: null, now: 1 }));
    expect(error.code).toBe("render_failed");
    expect(error.detail).toEqual([
      { path: ["copy", "heroHeadline"], code: "custom", message: "Copy must not contain numbers, currency symbols, @ or links; facts come from the owner" },
    ]);
    expect((await siteRow(env.DB, siteId))?.pending_version_id).toBeNull();
    expect(await auditActions(env.DB, siteId)).toEqual([]);
  });

  it("refuses a taken-down site and keeps the version already in review", async () => {
    const { ownerId, siteId, slug } = await seedSite(env.DB);
    const first = await createPendingVersion(env, { siteId, ownerId, slug, document: doc(), edits: EDITS, generationId: null, now: 1 });
    await env.DB.prepare("UPDATE sites SET taken_down_at = 5 WHERE id = ?").bind(siteId).run();
    const error = await failure(createPendingVersion(env, { siteId, ownerId, slug, document: doc(), edits: EDITS, generationId: null, now: 6 }));
    expect(error.code).toBe("site_taken_down");
    expect((await versionRow(env.DB, first.id))?.status).toBe("pending");
    expect(await auditActions(env.DB, siteId)).toEqual(["version.requested"]);
  });

  it("refuses when the slug or the owner no longer matches (integrity)", async () => {
    const { ownerId, siteId, slug } = await seedSite(env.DB);
    const wrongSlug = await failure(createPendingVersion(env, { siteId, ownerId, slug: `${slug}-x`, document: doc(), edits: EDITS, generationId: null, now: 1 }));
    expect(wrongSlug.code).toBe("integrity");
    const other = await seedSite(env.DB);
    const wrongOwner = await failure(createPendingVersion(env, { siteId, ownerId: other.ownerId, slug, document: doc(), edits: EDITS, generationId: null, now: 1 }));
    expect(wrongOwner.code).toBe("integrity");
    expect((await siteRow(env.DB, siteId))?.pending_version_id).toBeNull();
  });
});

describe("the daily publish cap (Decision 25)", () => {
  const versionCount = async (siteId: string) =>
    (await env.DB.prepare("SELECT COUNT(*) AS n FROM site_versions WHERE site_id = ?").bind(siteId).first<{ n: number }>())?.n;

  it("allows LIMITS.publishRequestsPerSitePerDay requests a UTC day, then refuses without storing anything", async () => {
    const { ownerId, siteId, slug } = await seedSite(env.DB);
    const day = Date.parse("2026-09-24T00:00:00.000Z");
    const publish = (now: number) => createPendingVersion(env, { siteId, ownerId, slug, document: doc("cleaning-minimal"), edits: EDITS, generationId: null, now });
    for (let i = 0; i < LIMITS.publishRequestsPerSitePerDay; i++) await publish(day + i);
    const error = await failure(publish(day + 3_600_000));
    expect(error.code).toBe("publish_cap_reached");
    expect(error.detail).toEqual({ retryAfter: 82_800 }); // 23 hours until 00:00 UTC
    expect(await versionCount(siteId)).toBe(LIMITS.publishRequestsPerSitePerDay);
    expect((await env.WORK.list({ prefix: `versions/${siteId}/` })).objects).toHaveLength(LIMITS.publishRequestsPerSitePerDay);
    expect((await publish(day + 86_400_000)).number).toBe(LIMITS.publishRequestsPerSitePerDay + 1);
  });

  it("stays exact when requests race: one of three gets the last place", async () => {
    const { ownerId, siteId, slug } = await seedSite(env.DB);
    const day = Date.parse("2026-09-25T00:00:00.000Z");
    const publish = (now: number) => createPendingVersion(env, { siteId, ownerId, slug, document: doc("cleaning-minimal"), edits: EDITS, generationId: null, now });
    for (let i = 0; i < LIMITS.publishRequestsPerSitePerDay - 1; i++) await publish(day + i);
    const results = await Promise.allSettled([publish(day + 100), publish(day + 101), publish(day + 102)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "publish_cap_reached" });
    expect(await versionCount(siteId)).toBe(LIMITS.publishRequestsPerSitePerDay);
  });
});

describe("withdrawPending", () => {
  it("withdraws the version in review once", async () => {
    const { ownerId, siteId, slug } = await seedSite(env.DB);
    const version = await createPendingVersion(env, { siteId, ownerId, slug, document: doc(), edits: EDITS, generationId: null, now: 1 });
    await withdrawPending(env, { siteId, ownerId, now: 2 });
    expect((await versionRow(env.DB, version.id))?.status).toBe("withdrawn");
    expect((await siteRow(env.DB, siteId))?.pending_version_id).toBeNull();
    expect(await auditActions(env.DB, siteId)).toEqual(["version.requested", "version.withdrawn"]);
    expect((await failure(withdrawPending(env, { siteId, ownerId, now: 3 }))).code).toBe("nothing_pending");
    expect(await auditActions(env.DB, siteId)).toEqual(["version.requested", "version.withdrawn"]);
  });

  it("does nothing for another owner's site", async () => {
    const { ownerId, siteId, slug } = await seedSite(env.DB);
    await createPendingVersion(env, { siteId, ownerId, slug, document: doc(), edits: EDITS, generationId: null, now: 1 });
    const other = await seedSite(env.DB);
    expect((await failure(withdrawPending(env, { siteId, ownerId: other.ownerId, now: 2 }))).code).toBe("nothing_pending");
    expect((await siteRow(env.DB, siteId))?.pending_version_id).not.toBeNull();
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `pnpm vitest run packages/publishing`
Expected: FAIL: `Test Files  1 failed (1)` with `Error: Cannot find module '../src/index.ts'`.

- [ ] **Step 4: Write the implementation**

`packages/publishing/src/errors.ts`:

```ts
export type PublishErrorCode =
  | "render_failed" | "nothing_pending" | "version_not_pending" | "site_taken_down" | "integrity" | "not_live"
  | "publish_cap_reached" // Decision 25: Plan 4 answers 429 rate_limited with Retry-After = detail.retryAfter
  | "site_not_found"; // Decision 28: Plan 4 answers 404 not_found

// An explicit field instead of a constructor parameter property (the repo's tsconfig sets
// erasableSyntaxOnly). Public shape as in the design: readonly code, readonly detail.
export class PublishError extends Error {
  readonly code: PublishErrorCode;
  readonly detail?: unknown;

  constructor(code: PublishErrorCode, detail?: unknown) {
    super(code);
    this.name = "PublishError";
    this.code = code;
    this.detail = detail;
  }
}
```

`packages/publishing/src/shared.ts`:

```ts
import { AUDIT_ACTIONS, canonicalJson } from "@asksite/core";

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const HTML_TYPE = "text/html; charset=utf-8";

/**
 * An audit row that is written only when the statement just before it in the same D1 batch
 * changed exactly one row (SQLite changes()), so a retried or refused action never logs twice.
 */
export function auditIfChanged(
  db: D1Database,
  entry: { at: number; actor: string; action: AuditAction; siteId: string; detail: Record<string, unknown> },
): D1PreparedStatement {
  return db
    .prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) SELECT ?, ?, ?, ?, ? WHERE changes() = 1")
    .bind(entry.at, entry.actor, entry.action, entry.siteId, canonicalJson(entry.detail));
}

/** Lower-case hex SHA-256 of raw bytes (the stored page, exactly as R2 returns it). */
export async function sha256OfBytes(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Reads a stored version and proves its bytes still hash to `expected`. */
export async function verifiedVersionBytes(work: R2Bucket, key: string, expected: string): Promise<ArrayBuffer | null> {
  const object = await work.get(key);
  if (object === null) return null;
  const bytes = await object.arrayBuffer();
  return (await sha256OfBytes(bytes)) === expected ? bytes : null;
}
```

`packages/publishing/src/versions.ts`:

```ts
import {
  canonicalJson,
  documentSha256,
  formActionUrl,
  LIMITS,
  newId,
  sha256Hex,
  toIssues,
  utcDayStart,
  versionKey,
  type OwnerEdits,
  type VersionSummary,
} from "@asksite/core";
import { render } from "@asksite/renderer";
import { SITE_CSS, SITE_CSS_SHA256 } from "@asksite/site-css";
import { SiteDocument } from "@asksite/site-schema";
import { PublishError } from "./errors.ts";
import { auditIfChanged, HTML_TYPE } from "./shared.ts";

const DAY_MS = 86_400_000;

/**
 * The owner's Publish: render the page, store the exact bytes in WORK, then (one D1 batch)
 * supersede any pending version, add this one as pending and point the site at it.
 * The batch only acts while the site is the owner's, still has this slug, is not taken down and has
 * fewer than LIMITS.publishRequestsPerSitePerDay requests today (Decision 25).
 */
export async function createPendingVersion(
  env: { DB: D1Database; WORK: R2Bucket; ROOT_DOMAIN: string },
  input: { siteId: string; ownerId: string; slug: string; document: SiteDocument; edits: OwnerEdits; generationId: string | null; now: number },
): Promise<VersionSummary> {
  const { siteId, ownerId, slug, edits, generationId, now } = input;
  const db = env.DB;

  // Store the parsed form (trimmed, NFKC, defaults), whatever the caller passed; re-parsing a parsed
  // document is a no-op, so document_sha256 matches documentSha256 of the parsed draft.
  const parsed = SiteDocument.safeParse(input.document);
  if (!parsed.success) throw new PublishError("render_failed", toIssues(parsed.error));
  const document = parsed.data;

  // A cheap count first, so a request over the cap renders and stores nothing. The batch re-checks it.
  const dayStart = utcDayStart(now);
  const capReached = () => new PublishError("publish_cap_reached", { retryAfter: Math.ceil((dayStart + DAY_MS - now) / 1000) });
  if ((await requestsSince(db, siteId, dayStart)) >= LIMITS.publishRequestsPerSitePerDay) throw capReached();

  let html: string;
  try {
    html = render(document, { stylesheet: SITE_CSS, formAction: formActionUrl(env.ROOT_DOMAIN, slug, siteId) });
  } catch (error) {
    throw new PublishError("render_failed", [{ path: [], code: "render_failed", message: error instanceof Error ? error.message : "Render failed" }]);
  }

  const versionId = newId();
  const key = versionKey(siteId, versionId);
  const htmlSha256 = await sha256Hex(html);
  // Orphaned objects (a failed batch below) are harmless: nothing ever serves WORK publicly.
  await env.WORK.put(key, html, { httpMetadata: { contentType: HTML_TYPE }, customMetadata: { siteId, versionId, sha256: htmlSha256 } });

  const siteIsReady = "EXISTS (SELECT 1 FROM sites WHERE id = ? AND owner_id = ? AND slug = ? AND taken_down_at IS NULL)";
  const underCap = "(SELECT COUNT(*) FROM site_versions WHERE site_id = ? AND requested_at >= ?) < ?";
  const cap = LIMITS.publishRequestsPerSitePerDay;
  const results = await db.batch([
    db.prepare(`UPDATE site_versions SET status = 'superseded' WHERE site_id = ? AND status = 'pending' AND ${siteIsReady} AND ${underCap}`)
      .bind(siteId, siteId, ownerId, slug, siteId, dayStart, cap),
    db
      .prepare(
        `INSERT INTO site_versions (id, site_id, number, status, document_json, document_sha256, edits_json, generation_id,
           html_key, html_sha256, stylesheet_sha256, requested_by, requested_at)
         SELECT ?, ?, next.n, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM (SELECT COALESCE(MAX(number), 0) + 1 AS n FROM site_versions WHERE site_id = ?) AS next
         WHERE ${siteIsReady} AND ${underCap}
         RETURNING number`,
      )
      .bind(versionId, siteId, canonicalJson(document), await documentSha256(document), canonicalJson(edits), generationId,
        key, htmlSha256, SITE_CSS_SHA256, ownerId, now, siteId, siteId, ownerId, slug, siteId, dayStart, cap),
    // Only when the INSERT above happened (same transaction), so the site never points at a missing version.
    db.prepare("UPDATE sites SET pending_version_id = ?, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM site_versions WHERE id = ? AND site_id = ?)")
      .bind(versionId, now, siteId, versionId, siteId),
    auditIfChanged(db, { at: now, actor: `owner:${ownerId}`, action: "version.requested", siteId, detail: { versionId } }),
  ]);

  const number = (results[1]?.results[0] as { number?: number } | undefined)?.number;
  if (number === undefined) {
    const site = await db.prepare("SELECT taken_down_at FROM sites WHERE id = ? AND owner_id = ?").bind(siteId, ownerId).first<{ taken_down_at: number | null }>();
    if (site !== null && site.taken_down_at !== null) throw new PublishError("site_taken_down");
    if ((await requestsSince(db, siteId, dayStart)) >= cap) throw capReached();
    throw new PublishError("integrity", { reason: "site_changed" });
  }
  return { id: versionId, number, status: "pending", requestedAt: now, reviewedAt: null, reviewNote: null };
}

/** Version requests of a site since `since` (every status counts: superseded and withdrawn ones used D1 too). */
async function requestsSince(db: D1Database, siteId: string, since: number): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM site_versions WHERE site_id = ? AND requested_at >= ?").bind(siteId, since).first<{ n: number }>();
  return row?.n ?? 0;
}

/** The owner's Withdraw: the pending version becomes "withdrawn" and the site has nothing in review. */
export async function withdrawPending(env: { DB: D1Database }, input: { siteId: string; ownerId: string; now: number }): Promise<void> {
  const { siteId, ownerId, now } = input;
  const db = env.DB;
  const site = await db.prepare("SELECT pending_version_id FROM sites WHERE id = ? AND owner_id = ?").bind(siteId, ownerId).first<{ pending_version_id: string | null }>();
  const versionId = site?.pending_version_id ?? null;
  if (versionId === null) throw new PublishError("nothing_pending");

  const results = await db.batch([
    db.prepare("UPDATE sites SET pending_version_id = NULL, updated_at = ? WHERE id = ? AND owner_id = ? AND pending_version_id = ?").bind(now, siteId, ownerId, versionId),
    auditIfChanged(db, { at: now, actor: `owner:${ownerId}`, action: "version.withdrawn", siteId, detail: { versionId } }),
    db.prepare("UPDATE site_versions SET status = 'withdrawn' WHERE id = ? AND status = 'pending'").bind(versionId),
  ]);
  if (results[0]?.meta.changes !== 1) throw new PublishError("nothing_pending");
}
```

`packages/publishing/src/index.ts`:

```ts
export { PublishError, type PublishErrorCode } from "./errors.ts";
export { createPendingVersion, withdrawPending } from "./versions.ts";
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `pnpm vitest run packages/publishing && pnpm typecheck`
Expected: `Test Files  1 passed (1)`, `Tests  10 passed (10)`; typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add pnpm-lock.yaml packages/publishing
git commit -m "Add version publishing"
```

---
### Task 9: Publishing: `approveVersion` and `rejectVersion`

**Files:**
- Create: `packages/publishing/src/review.ts`
- Modify: `packages/publishing/src/index.ts`
- Test: `packages/publishing/test/review.workerd.test.ts`

**Interfaces:**
- Consumes: `createPendingVersion` and the test support (Task 8); `liveKey`, `siteUrl` (Task 2).
- Produces: `approveVersion`, `rejectVersion` (signatures under "Interfaces this plan provides").
- Behaviour (design §7.2): approve refuses unless the reviewed `htmlSha256` equals the row's and the stored bytes still hash to it (`integrity`; nothing changes); then one conditional batch makes it live (`live_version_id`, `pending_version_id = NULL`, `indexable`, the version `approved` with reviewer, time and note, the audit row); a retry after a failed LIVE write takes the idempotent branch without a second audit row; then the same bytes go to `LIVE: <slug>.html`. An older approved version can never overwrite a newer live page. Reject marks the pending version `rejected` with the note and clears the review.

- [ ] **Step 1: Write the failing test**

`packages/publishing/test/review.workerd.test.ts`:

```ts
import { liveKey, sha256Hex, versionKey } from "@asksite/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approveVersion, createPendingVersion, rejectVersion } from "../src/index.ts";
import { publishFailure as failure } from "./support/errors.ts";
import { auditActions, doc, EDITS, publishingHarness, seedSite, siteRow, versionRow, type PublishEnv } from "./support/harness.ts";

const harness = publishingHarness("publishing-review-test");
let env: PublishEnv;
beforeAll(async () => {
  env = await harness.start();
}, 120_000);
afterAll(async () => {
  await harness.server.close();
});

/** A site with one version in review; returns what the admin was shown. */
async function pending(document = doc()) {
  const site = await seedSite(env.DB);
  const version = await createPendingVersion(env, { ...site, document, edits: EDITS, generationId: null, now: 10 });
  const row = await versionRow(env.DB, version.id);
  return { ...site, versionId: version.id, htmlSha256: String(row?.html_sha256) };
}

const approve = (versionId: string, htmlSha256: string, extra: Partial<{ indexable: boolean; note: string | null; now: number }> = {}) =>
  approveVersion(env, { versionId, htmlSha256, reviewer: "admin@example.com", note: null, indexable: true, now: 20, ...extra });

describe("approveVersion", () => {
  it("makes the reviewed bytes live and records who approved them", async () => {
    const p = await pending();
    const result = await approve(p.versionId, p.htmlSha256, { note: "Looks good", indexable: false });
    expect(result).toEqual({ siteId: p.siteId, slug: p.slug, liveUrl: `https://${p.slug}.asksite.example/` });

    const work = await (await env.WORK.get(versionKey(p.siteId, p.versionId)))?.text();
    const live = await env.LIVE.get(liveKey(p.slug));
    expect(await live?.text()).toBe(work);
    expect(live?.httpMetadata?.contentType).toBe("text/html; charset=utf-8");
    expect(live?.customMetadata).toEqual({ siteId: p.siteId, versionId: p.versionId, sha256: p.htmlSha256 });
    expect(await sha256Hex(String(work))).toBe(p.htmlSha256);

    expect(await siteRow(env.DB, p.siteId)).toMatchObject({ live_version_id: p.versionId, pending_version_id: null, indexable: 0 });
    expect(await versionRow(env.DB, p.versionId)).toMatchObject({ status: "approved", reviewed_by: "admin@example.com", reviewed_at: 20, review_note: "Looks good" });
    expect(await auditActions(env.DB, p.siteId)).toEqual(["version.requested", "version.approved"]);
  });

  it("refuses when the admin saw different bytes, and changes nothing", async () => {
    const p = await pending();
    const error = await failure(approve(p.versionId, "0".repeat(64)));
    expect(error.code).toBe("integrity");
    expect(await siteRow(env.DB, p.siteId)).toMatchObject({ live_version_id: null, pending_version_id: p.versionId });
    expect(await env.LIVE.get(liveKey(p.slug))).toBeNull();
  });

  it("refuses when the stored bytes were changed after review", async () => {
    const p = await pending();
    await env.WORK.put(versionKey(p.siteId, p.versionId), "<!DOCTYPE html><p>tampered</p>");
    expect((await failure(approve(p.versionId, p.htmlSha256))).code).toBe("integrity");
    expect((await siteRow(env.DB, p.siteId))?.live_version_id).toBeNull();
  });

  it("is idempotent: a retry after a failed LIVE write finishes the job without a second audit row", async () => {
    const p = await pending();
    await approve(p.versionId, p.htmlSha256);
    await env.LIVE.delete(liveKey(p.slug)); // as if step 3 had failed
    await approve(p.versionId, p.htmlSha256, { now: 30 });
    expect(await env.LIVE.get(liveKey(p.slug))).not.toBeNull();
    expect(await auditActions(env.DB, p.siteId)).toEqual(["version.requested", "version.approved"]);
    expect((await versionRow(env.DB, p.versionId))?.reviewed_at).toBe(20);
  });

  it("refuses a rejected, superseded or unknown version", async () => {
    const rejected = await pending();
    await rejectVersion(env, { versionId: rejected.versionId, reviewer: "admin@example.com", note: "No", now: 11 });
    expect((await failure(approve(rejected.versionId, rejected.htmlSha256))).code).toBe("version_not_pending");

    const superseded = await pending();
    await createPendingVersion(env, { siteId: superseded.siteId, ownerId: superseded.ownerId, slug: superseded.slug, document: doc(), edits: EDITS, generationId: null, now: 12 });
    expect((await failure(approve(superseded.versionId, superseded.htmlSha256))).code).toBe("version_not_pending");

    expect((await failure(approve("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "0".repeat(64)))).code).toBe("version_not_pending");
  });

  it("refuses a site that was taken down while in review", async () => {
    const p = await pending();
    await env.DB.prepare("UPDATE sites SET taken_down_at = 15 WHERE id = ?").bind(p.siteId).run();
    expect((await failure(approve(p.versionId, p.htmlSha256))).code).toBe("site_taken_down");
    expect(await env.LIVE.get(liveKey(p.slug))).toBeNull();
  });

  it("never lets an older approved version overwrite the newer live page", async () => {
    const p = await pending();
    await approve(p.versionId, p.htmlSha256);
    const second = await createPendingVersion(env, { siteId: p.siteId, ownerId: p.ownerId, slug: p.slug, document: doc("hvac-phoenix"), edits: EDITS, generationId: null, now: 40 });
    const secondSha = String((await versionRow(env.DB, second.id))?.html_sha256);
    await approve(second.id, secondSha, { now: 41 });
    expect((await failure(approve(p.versionId, p.htmlSha256, { now: 42 }))).code).toBe("version_not_pending");
    expect((await env.LIVE.get(liveKey(p.slug)))?.customMetadata?.["versionId"]).toBe(second.id);
    expect((await versionRow(env.DB, p.versionId))?.status).toBe("approved");
  });
});

describe("rejectVersion", () => {
  it("rejects with the note and clears the review", async () => {
    const p = await pending();
    expect(await rejectVersion(env, { versionId: p.versionId, reviewer: "admin@example.com", note: "Remove the phone number from the caption", now: 11 })).toEqual({ siteId: p.siteId });
    expect(await versionRow(env.DB, p.versionId)).toMatchObject({ status: "rejected", reviewed_by: "admin@example.com", reviewed_at: 11, review_note: "Remove the phone number from the caption" });
    expect((await siteRow(env.DB, p.siteId))?.pending_version_id).toBeNull();
    expect(await auditActions(env.DB, p.siteId)).toEqual(["version.requested", "version.rejected"]);
  });

  it("refuses a version that is not in review, without a second audit row", async () => {
    const p = await pending();
    await rejectVersion(env, { versionId: p.versionId, reviewer: "admin@example.com", note: "No", now: 11 });
    expect((await failure(rejectVersion(env, { versionId: p.versionId, reviewer: "admin@example.com", note: "No", now: 12 }))).code).toBe("version_not_pending");
    expect((await failure(rejectVersion(env, { versionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", reviewer: "a", note: "n", now: 1 }))).code).toBe("version_not_pending");
    expect(await auditActions(env.DB, p.siteId)).toEqual(["version.requested", "version.rejected"]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/publishing/test/review.workerd.test.ts`
Expected: FAIL: `Tests  9 failed (9)` with `TypeError: approveVersion is not a function` and `TypeError: rejectVersion is not a function`.

- [ ] **Step 3: Write the implementation**

`packages/publishing/src/review.ts`:

```ts
import { liveKey, siteUrl } from "@asksite/core";
import { PublishError } from "./errors.ts";
import { auditIfChanged, HTML_TYPE, verifiedVersionBytes } from "./shared.ts";

interface VersionForReview {
  site_id: string;
  html_key: string;
  html_sha256: string;
  slug: string | null;
}

/**
 * The admin's Approve. What the admin was shown is what goes live:
 * 1) the reviewed htmlSha256 must equal the row's, and the stored bytes must still hash to it;
 * 2) one conditional D1 batch makes it the live version (a retry after a failed step 3 is accepted);
 * 3) the same bytes are copied to LIVE. The sites Worker serves them only while D1 says live.
 */
export async function approveVersion(
  env: { DB: D1Database; WORK: R2Bucket; LIVE: R2Bucket; ROOT_DOMAIN: string },
  input: { versionId: string; htmlSha256: string; reviewer: string; note: string | null; indexable: boolean; now: number },
): Promise<{ siteId: string; slug: string; liveUrl: string }> {
  const { versionId, reviewer, note, indexable, now } = input;
  const db = env.DB;
  const row = await db
    .prepare("SELECT v.site_id, v.html_key, v.html_sha256, s.slug FROM site_versions v JOIN sites s ON s.id = v.site_id WHERE v.id = ?")
    .bind(versionId)
    .first<VersionForReview>();
  if (row === null || row.slug === null) throw new PublishError("version_not_pending");
  const { site_id: siteId, slug } = row;

  if (input.htmlSha256 !== row.html_sha256) throw new PublishError("integrity", { reason: "reviewed_hash_mismatch" });
  const bytes = await verifiedVersionBytes(env.WORK, row.html_key, row.html_sha256);
  if (bytes === null) throw new PublishError("integrity", { reason: "stored_bytes_mismatch" });

  const results = await db.batch([
    db.prepare("UPDATE sites SET live_version_id = ?, pending_version_id = NULL, indexable = ?, updated_at = ? WHERE id = ? AND pending_version_id = ? AND taken_down_at IS NULL")
      .bind(versionId, indexable ? 1 : 0, now, siteId, versionId),
    db.prepare("UPDATE site_versions SET status = 'approved', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM sites WHERE id = ? AND live_version_id = ?)")
      .bind(reviewer, now, note, versionId, siteId, versionId),
    auditIfChanged(db, { at: now, actor: `admin:${reviewer}`, action: "version.approved", siteId, detail: { versionId, indexable } }),
  ]);

  if (results[1]?.meta.changes !== 1) {
    const state = await db
      .prepare("SELECT v.status, s.live_version_id, s.taken_down_at FROM site_versions v JOIN sites s ON s.id = v.site_id WHERE v.id = ?")
      .bind(versionId)
      .first<{ status: string; live_version_id: string | null; taken_down_at: number | null }>();
    const alreadyLive = state !== null && state.status === "approved" && state.live_version_id === versionId && state.taken_down_at === null;
    if (!alreadyLive) throw new PublishError(state !== null && state.taken_down_at !== null ? "site_taken_down" : "version_not_pending");
  }

  await env.LIVE.put(liveKey(slug), bytes, { httpMetadata: { contentType: HTML_TYPE }, customMetadata: { siteId, versionId, sha256: row.html_sha256 } });
  return { siteId, slug, liveUrl: siteUrl(env.ROOT_DOMAIN, slug) };
}

/** The admin's Reject: the pending version becomes "rejected" with the note; the site has nothing in review. */
export async function rejectVersion(
  env: { DB: D1Database },
  input: { versionId: string; reviewer: string; note: string; now: number },
): Promise<{ siteId: string }> {
  const { versionId, reviewer, note, now } = input;
  const db = env.DB;
  const row = await db.prepare("SELECT site_id FROM site_versions WHERE id = ?").bind(versionId).first<{ site_id: string }>();
  if (row === null) throw new PublishError("version_not_pending");
  const siteId = row.site_id;

  const results = await db.batch([
    db.prepare("UPDATE site_versions SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ? AND status = 'pending'")
      .bind(reviewer, now, note, versionId),
    auditIfChanged(db, { at: now, actor: `admin:${reviewer}`, action: "version.rejected", siteId, detail: { versionId } }),
    db.prepare("UPDATE sites SET pending_version_id = NULL, updated_at = ? WHERE id = ? AND pending_version_id = ?").bind(now, siteId, versionId),
  ]);
  if (results[0]?.meta.changes !== 1) throw new PublishError("version_not_pending");
  return { siteId };
}
```

`packages/publishing/src/index.ts` (full new content):

```ts
export { PublishError, type PublishErrorCode } from "./errors.ts";
export { approveVersion, rejectVersion } from "./review.ts";
export { createPendingVersion, withdrawPending } from "./versions.ts";
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `pnpm vitest run packages/publishing && pnpm typecheck`
Expected: `Test Files  2 passed (2)`, `Tests  19 passed (19)`; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/publishing/src/review.ts packages/publishing/src/index.ts packages/publishing/test/review.workerd.test.ts
git commit -m "Add review actions"
```

---
### Task 10: Publishing: `takeDown`, `restore` and `setIndexable`

**Files:**
- Create: `packages/publishing/src/site-state.ts`
- Modify: `packages/publishing/src/index.ts`
- Test: `packages/publishing/test/site-state.workerd.test.ts`

**Interfaces:**
- Consumes: Tasks 8–9; `mediaKey`, `mediaUrl`, `liveKey`, `siteUrl`, `versionKey`, `newId` (Task 2).
- Produces: `takeDown`, `restore` (with `ROOT_DOMAIN` and `MEDIA`, Decisions 3 and 29), `setIndexable`. An unknown site id gets `PublishError("site_not_found")` from all three (Decision 28; design §4.5 answers 404).
- Behaviour (design §7.2): takedown is one D1 batch (`taken_down_at` kept from the first call, reason, pending version `rejected` with "Site taken down", audit once), which alone stops the page and photos being served (Task 12); then `LIVE` is deleted and, with `purgeMedia`, every `MEDIA <siteId>/` object is deleted (paged `list` + batched `delete`) and the uploads are marked deleted. Restore copies the live version's verified bytes back to LIVE first, then clears the takedown; it refuses a site that was never live (`not_live`) or whose stored bytes changed (`integrity`), and returns `missingPhotos`: how many of the live page's photos are gone from `MEDIA` (a takedown with `purgeMedia` deletes them), so Plan 4 can tell the admin the restored page shows broken images (Decision 29). The search-engine switch is D1 only and audits only real changes.

- [ ] **Step 1: Write the failing test**

`packages/publishing/test/site-state.workerd.test.ts`:

```ts
import { liveKey, mediaKey, mediaUrl, newId, versionKey } from "@asksite/core";
import { SiteDocument } from "@asksite/site-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approveVersion, createPendingVersion, restore, setIndexable, takeDown } from "../src/index.ts";
import { publishFailure as failure } from "./support/errors.ts";
import { auditActions, doc, EDITS, publishingHarness, ROOT, seedSite, siteRow, versionRow, type PublishEnv } from "./support/harness.ts";

const harness = publishingHarness("publishing-site-state-test");
let env: PublishEnv;
beforeAll(async () => {
  env = await harness.start();
}, 120_000);
afterAll(async () => {
  await harness.server.close();
});

const ADMIN = "admin@example.com";

/** A live site (version 1 approved) and, optionally, version 2 in review. */
async function liveSite(withPending = false) {
  const site = await seedSite(env.DB);
  const v1 = await createPendingVersion(env, { ...site, document: doc(), edits: EDITS, generationId: null, now: 1 });
  const sha = String((await versionRow(env.DB, v1.id))?.html_sha256);
  await approveVersion(env, { versionId: v1.id, htmlSha256: sha, reviewer: ADMIN, note: null, indexable: true, now: 2 });
  const v2 = withPending ? await createPendingVersion(env, { ...site, document: doc("hvac-phoenix"), edits: EDITS, generationId: null, now: 3 }) : null;
  return { ...site, liveVersionId: v1.id, pendingVersionId: v2?.id ?? null };
}

async function addUpload(siteId: string): Promise<string> {
  const uploadId = newId();
  await env.DB.prepare("INSERT INTO uploads (id, site_id, width, height, bytes, created_at) VALUES (?, ?, 1600, 1200, 4, 1)").bind(uploadId, siteId).run();
  await env.MEDIA.put(mediaKey(siteId, uploadId), "webp");
  return uploadId;
}

describe("takeDown", () => {
  it("marks the site taken down in D1, rejects the pending version and deletes the live copy", async () => {
    const s = await liveSite(true);
    await takeDown(env, { siteId: s.siteId, reviewer: ADMIN, reason: "Phishing", purgeMedia: false, now: 50 });
    expect(await siteRow(env.DB, s.siteId)).toMatchObject({ taken_down_at: 50, takedown_reason: "Phishing", pending_version_id: null, live_version_id: s.liveVersionId });
    expect(await versionRow(env.DB, String(s.pendingVersionId))).toMatchObject({ status: "rejected", review_note: "Site taken down", reviewed_by: ADMIN });
    expect(await env.LIVE.get(liveKey(s.slug))).toBeNull();
    expect(await auditActions(env.DB, s.siteId)).toEqual(["version.requested", "version.approved", "version.requested", "site.taken_down"]);
  });

  it("is idempotent and keeps the first takedown time", async () => {
    const s = await liveSite();
    await takeDown(env, { siteId: s.siteId, reviewer: ADMIN, reason: "Spam", purgeMedia: false, now: 50 });
    await takeDown(env, { siteId: s.siteId, reviewer: ADMIN, reason: "Spam again", purgeMedia: false, now: 60 });
    expect(await siteRow(env.DB, s.siteId)).toMatchObject({ taken_down_at: 50, takedown_reason: "Spam" });
    expect((await auditActions(env.DB, s.siteId)).filter((a) => a === "site.taken_down")).toHaveLength(1);
  });

  it("purges only this site's photos when asked", async () => {
    const s = await liveSite();
    const other = await liveSite();
    const mine = [await addUpload(s.siteId), await addUpload(s.siteId)];
    const theirs = await addUpload(other.siteId);
    await takeDown(env, { siteId: s.siteId, reviewer: ADMIN, reason: "Abuse", purgeMedia: true, now: 70 });
    for (const id of mine) expect(await env.MEDIA.get(mediaKey(s.siteId, id))).toBeNull();
    expect(await env.MEDIA.get(mediaKey(other.siteId, theirs))).not.toBeNull();
    const { results } = await env.DB.prepare("SELECT deleted_at FROM uploads WHERE site_id = ?").bind(s.siteId).all<{ deleted_at: number | null }>();
    expect(results.map((r) => r.deleted_at)).toEqual([70, 70]);
    const { results: kept } = await env.DB.prepare("SELECT deleted_at FROM uploads WHERE site_id = ?").bind(other.siteId).all<{ deleted_at: number | null }>();
    expect(kept.map((r) => r.deleted_at)).toEqual([null]);
  });
});

describe("an unknown site id", () => {
  it("gets site_not_found from takeDown, restore and setIndexable (Plan 4 answers 404)", async () => {
    const siteId = newId();
    expect((await failure(takeDown(env, { siteId, reviewer: ADMIN, reason: "x", purgeMedia: false, now: 1 }))).code).toBe("site_not_found");
    expect((await failure(restore(env, { siteId, reviewer: ADMIN, now: 1 }))).code).toBe("site_not_found");
    expect((await failure(setIndexable(env, { siteId, reviewer: ADMIN, indexable: false, now: 1 }))).code).toBe("site_not_found");
  });
});

describe("restore", () => {
  it("puts the live version's bytes back, then clears the takedown", async () => {
    const s = await liveSite();
    await takeDown(env, { siteId: s.siteId, reviewer: ADMIN, reason: "Mistake", purgeMedia: false, now: 50 });
    expect(await restore(env, { siteId: s.siteId, reviewer: ADMIN, now: 60 })).toEqual({ liveUrl: `https://${s.slug}.asksite.example/`, missingPhotos: 0 });
    const work = await (await env.WORK.get(versionKey(s.siteId, s.liveVersionId)))?.text();
    expect(await (await env.LIVE.get(liveKey(s.slug)))?.text()).toBe(work);
    expect(await siteRow(env.DB, s.siteId)).toMatchObject({ taken_down_at: null, takedown_reason: null });
    expect((await auditActions(env.DB, s.siteId)).slice(-2)).toEqual(["site.taken_down", "site.restored"]);
  });

  it("is retry-safe and audits once", async () => {
    const s = await liveSite();
    await takeDown(env, { siteId: s.siteId, reviewer: ADMIN, reason: "x", purgeMedia: false, now: 50 });
    await restore(env, { siteId: s.siteId, reviewer: ADMIN, now: 60 });
    await restore(env, { siteId: s.siteId, reviewer: ADMIN, now: 61 });
    expect((await auditActions(env.DB, s.siteId)).filter((a) => a === "site.restored")).toHaveLength(1);
  });

  it("refuses a site that was never live", async () => {
    const site = await seedSite(env.DB);
    expect((await failure(restore(env, { siteId: site.siteId, reviewer: ADMIN, now: 1 }))).code).toBe("not_live");
  });

  it("counts the photos a purge deleted, so the admin knows the page will show broken images", async () => {
    const site = await seedSite(env.DB);
    const photos = [await addUpload(site.siteId), await addUpload(site.siteId)].map((id) => ({ url: mediaUrl(ROOT, site.siteId, id), alt: "A finished job", width: 1600, height: 1200 }));
    const base = doc("plumber-austin");
    const document = SiteDocument.parse({ ...base, facts: { ...base.facts, heroPhoto: photos[0], photos: [photos[1]] } });
    const v1 = await createPendingVersion(env, { ...site, document, edits: EDITS, generationId: null, now: 1 });
    await approveVersion(env, { versionId: v1.id, htmlSha256: String((await versionRow(env.DB, v1.id))?.html_sha256), reviewer: ADMIN, note: null, indexable: true, now: 2 });
    await takeDown(env, { siteId: site.siteId, reviewer: ADMIN, reason: "Abuse", purgeMedia: true, now: 3 });
    expect(await restore(env, { siteId: site.siteId, reviewer: ADMIN, now: 4 })).toEqual({ liveUrl: `https://${site.slug}.asksite.example/`, missingPhotos: 2 });
    expect((await siteRow(env.DB, site.siteId))?.taken_down_at).toBeNull();
  });

  it("refuses when the stored bytes no longer match, and leaves the site taken down", async () => {
    const s = await liveSite();
    await takeDown(env, { siteId: s.siteId, reviewer: ADMIN, reason: "x", purgeMedia: false, now: 50 });
    await env.WORK.put(versionKey(s.siteId, s.liveVersionId), "tampered");
    expect((await failure(restore(env, { siteId: s.siteId, reviewer: ADMIN, now: 60 }))).code).toBe("integrity");
    expect((await siteRow(env.DB, s.siteId))?.taken_down_at).toBe(50);
    expect(await env.LIVE.get(liveKey(s.slug))).toBeNull();
  });
});

describe("setIndexable", () => {
  it("switches search engines off and on in D1, auditing only real changes", async () => {
    const s = await liveSite();
    await setIndexable(env, { siteId: s.siteId, reviewer: ADMIN, indexable: false, now: 5 });
    expect((await siteRow(env.DB, s.siteId))?.indexable).toBe(0);
    await setIndexable(env, { siteId: s.siteId, reviewer: ADMIN, indexable: false, now: 6 });
    await setIndexable(env, { siteId: s.siteId, reviewer: ADMIN, indexable: true, now: 7 });
    expect((await siteRow(env.DB, s.siteId))?.indexable).toBe(1);
    expect((await auditActions(env.DB, s.siteId)).filter((a) => a === "site.indexable_changed")).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/publishing/test/site-state.workerd.test.ts`
Expected: FAIL: `Tests  10 failed (10)` with `TypeError: takeDown is not a function` (also `restore`, `setIndexable`).

- [ ] **Step 3: Write the implementation**

`packages/publishing/src/site-state.ts`:

```ts
import { liveKey, siteUrl } from "@asksite/core";
import { PublishError } from "./errors.ts";
import { auditIfChanged, HTML_TYPE, verifiedVersionBytes } from "./shared.ts";

/**
 * The admin's Take down. The D1 batch alone stops the page and its photos being served (the sites
 * Worker checks D1 on every cache miss). Deleting LIVE and purging MEDIA come after, as defence in
 * depth, and are retried by calling takeDown again (it is idempotent).
 */
export async function takeDown(
  env: { DB: D1Database; LIVE: R2Bucket; MEDIA: R2Bucket },
  input: { siteId: string; reviewer: string; reason: string; purgeMedia: boolean; now: number },
): Promise<void> {
  const { siteId, reviewer, reason, purgeMedia, now } = input;
  const db = env.DB;
  const site = await db.prepare("SELECT slug FROM sites WHERE id = ?").bind(siteId).first<{ slug: string | null }>();
  if (site === null) throw new PublishError("site_not_found");

  await db.batch([
    db.prepare("UPDATE site_versions SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = 'Site taken down' WHERE site_id = ? AND status = 'pending'")
      .bind(reviewer, now, siteId),
    db.prepare("UPDATE sites SET taken_down_at = ?, takedown_reason = ?, pending_version_id = NULL, updated_at = ? WHERE id = ? AND taken_down_at IS NULL")
      .bind(now, reason, now, siteId),
    auditIfChanged(db, { at: now, actor: `admin:${reviewer}`, action: "site.taken_down", siteId, detail: { reason, purgeMedia } }),
  ]);

  if (site.slug !== null) await env.LIVE.delete(liveKey(site.slug));
  if (purgeMedia) {
    await deletePrefix(env.MEDIA, `${siteId}/`);
    await db.prepare("UPDATE uploads SET deleted_at = ? WHERE site_id = ? AND deleted_at IS NULL").bind(now, siteId).run();
  }
}

async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list(cursor === undefined ? { prefix } : { prefix, cursor });
    if (page.objects.length > 0) await bucket.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
}

/**
 * The admin's Restore. Copies the live version's verified bytes back to LIVE first (not served yet:
 * D1 still says taken down), then clears taken_down_at. Retry-safe.
 * Takes ROOT_DOMAIN (not in the design's signature) because it returns the live URL, and MEDIA to
 * count the page's photos a purge deleted (Decision 29): the page still goes back up.
 */
export async function restore(
  env: { DB: D1Database; LIVE: R2Bucket; WORK: R2Bucket; MEDIA: R2Bucket; ROOT_DOMAIN: string },
  input: { siteId: string; reviewer: string; now: number },
): Promise<{ liveUrl: string; missingPhotos: number }> {
  const { siteId, reviewer, now } = input;
  const db = env.DB;
  const site = await db
    .prepare("SELECT s.slug, s.live_version_id, v.html_key, v.html_sha256, v.document_json FROM sites s LEFT JOIN site_versions v ON v.id = s.live_version_id WHERE s.id = ?")
    .bind(siteId)
    .first<{ slug: string | null; live_version_id: string | null; html_key: string | null; html_sha256: string | null; document_json: string | null }>();
  if (site === null) throw new PublishError("site_not_found");
  const { slug, live_version_id: versionId, html_key: key, html_sha256: sha256, document_json: documentJson } = site;
  if (slug === null || versionId === null || key === null || sha256 === null || documentJson === null) throw new PublishError("not_live");

  const bytes = await verifiedVersionBytes(env.WORK, key, sha256);
  if (bytes === null) throw new PublishError("integrity", { reason: "stored_bytes_mismatch" });
  await env.LIVE.put(liveKey(slug), bytes, { httpMetadata: { contentType: HTML_TYPE }, customMetadata: { siteId, versionId, sha256 } });

  await db.batch([
    db.prepare("UPDATE sites SET taken_down_at = NULL, takedown_reason = NULL, updated_at = ? WHERE id = ? AND taken_down_at IS NOT NULL").bind(now, siteId),
    auditIfChanged(db, { at: now, actor: `admin:${reviewer}`, action: "site.restored", siteId, detail: { versionId } }),
  ]);
  return { liveUrl: siteUrl(env.ROOT_DOMAIN, slug), missingPhotos: await missingPhotos(env.MEDIA, env.ROOT_DOMAIN, documentJson) };
}

/** How many photos of the stored document are gone from MEDIA (a takedown with purgeMedia deletes them). */
async function missingPhotos(media: R2Bucket, root: string, documentJson: string): Promise<number> {
  const { facts } = JSON.parse(documentJson) as { facts: { heroPhoto?: { url: string }; photos?: Array<{ url: string }> } };
  const prefix = `https://media.${root}/`;
  const keys = [facts.heroPhoto, ...(facts.photos ?? [])].flatMap((photo) =>
    photo !== undefined && photo.url.startsWith(prefix) ? [photo.url.slice(prefix.length)] : [],
  );
  const found = await Promise.all(keys.map((key) => media.head(key)));
  return found.filter((object) => object === null).length;
}

/** The admin's search-engine switch. D1 only: the sites Worker reads sites.indexable on every cache miss. */
export async function setIndexable(
  env: { DB: D1Database },
  input: { siteId: string; reviewer: string; indexable: boolean; now: number },
): Promise<void> {
  const { siteId, reviewer, indexable, now } = input;
  const db = env.DB;
  const value = indexable ? 1 : 0;
  const results = await db.batch([
    db.prepare("UPDATE sites SET indexable = ?, updated_at = ? WHERE id = ? AND indexable <> ?").bind(value, now, siteId, value),
    auditIfChanged(db, { at: now, actor: `admin:${reviewer}`, action: "site.indexable_changed", siteId, detail: { indexable } }),
  ]);
  if (results[0]?.meta.changes === 0 && (await db.prepare("SELECT 1 AS found FROM sites WHERE id = ?").bind(siteId).first()) === null) {
    throw new PublishError("site_not_found");
  }
}
```

`packages/publishing/src/index.ts` (full new content):

```ts
export { PublishError, type PublishErrorCode } from "./errors.ts";
export { approveVersion, rejectVersion } from "./review.ts";
export { restore, setIndexable, takeDown } from "./site-state.ts";
export { createPendingVersion, withdrawPending } from "./versions.ts";
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `pnpm vitest run packages/publishing && pnpm typecheck`
Expected: `Test Files  3 passed (3)`, `Tests  29 passed (29)`; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/publishing/src/site-state.ts packages/publishing/src/index.ts packages/publishing/test/site-state.workerd.test.ts
git commit -m "Add takedown restore"
```

---
### Task 11: The `asksite-sites` Worker: configuration, routing, fixed pages and headers

**Files:**
- Create: `apps/sites/package.json`, `apps/sites/wrangler.jsonc`, `apps/sites/.dev.vars.example`, `apps/sites/src/{env,headers,pages,apex,log,router,index}.ts`
- Test: `apps/sites/test/support/harness.ts`, `apps/sites/test/headers.test.ts`, `apps/sites/test/config.test.ts`, `apps/sites/test/source.test.ts`, `apps/sites/test/routing.workerd.test.ts`

**Interfaces:**
- Consumes: `parseHost`, `liveKey`, `mediaKey`, `newId` (Task 2); `escapeText`, `escapeAttr` (Plan 1); the tables (Task 5).
- Produces: the Worker `asksite-sites` (design §1.2, §4.6): apex `/` → placeholder page with `abuse@<root host>`; apex `/.well-known/security.txt` (RFC 9116 `Contact`, `Expires`); `www.<root>/*` → 301 to `https://<root>/`; any other host, path or method → the 404 page; every response `X-Robots-Tag: noindex` (the live page comes in Task 12). Header builders `livePageHeaders(root, indexable)`, `fixedPageHeaders(root)`, `mediaHeaders()`, `plainHeaders(extra)`, `pageCsp(root)`, `rootHostname(root)`; fixed pages `notFound`, `unavailable`, `thankYou`, `tooManyRequests`, `siteBusy`, `unreadableForm`, `formProblems`, `apexPlaceholder`; `route(request, env, ctx, now): Promise<Routed>`; `logLine(fields)`. The Worker's `Env` types `LIVE` and `MEDIA` as `Pick<R2Bucket, "get" | "head">`, so a write through them does not compile (the source scan below is the second guard). Test support: `sitesHarness(overrides)` (the real `wrangler.jsonc` plus a "tools" Worker sharing D1 and R2), `seedSite` (its LIVE object carries `customMetadata { siteId, versionId }` like an approved page, Decision 24), `putLive`, `seedUpload`, `settledLeads` (waits for the lead email that runs after the response, Decision 26), `at(slug, path)`, `ROOT`, `TEST_VARS`, `TEST_SECRETS`, `type ToolsEnv`, `type SeededSite`.
- `wrangler.jsonc` holds the production values with the placeholders `asksite.example` and database id `00000000-0000-0000-0000-000000000000` (Task 19 replaces them); `.dev.vars.example` holds the local values. The config test is design §9.1's "unsafe production configuration" test for this Worker.

- [ ] **Step 1: Add the Worker package**

`apps/sites/package.json`:

```json
{
  "name": "@asksite/sites",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@asksite/core": "workspace:*",
    "@asksite/mailer": "workspace:*",
    "@asksite/renderer": "workspace:*",
    "zod": "4.6.5"
  },
  "devDependencies": {
    "@asksite/publishing": "workspace:*",
    "@asksite/site-schema": "workspace:*",
    "wrangler": "4.138.0"
  }
}
```

`tsconfig.workers.json` already lists `apps/sites` (Task 7), and the Vitest globs already cover `apps/sites/test` (Task 5).

Run: `pnpm install`
Expected: `Done in …s using pnpm v10.33.0`.

- [ ] **Step 2: Write the test support and the failing tests**

`apps/sites/test/support/harness.ts`:

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { liveKey, mediaKey, newId } from "@asksite/core";
import { createTestHarness } from "wrangler";
import type { Env } from "../../src/env.ts";

export const ROOT = "localhost:8789";

// Every variable and secret the Worker reads is set here. Harness values beat a developer's
// .dev.vars, so a local .dev.vars (even one with a real Resend key) can never leak into tests.
export const TEST_VARS = {
  ENVIRONMENT: "development",
  ROOT_DOMAIN: ROOT,
  MAILER: "log",
  MAIL_FROM: "asksite test <test@localhost>",
  SECURITY_TXT_EXPIRES: "2027-09-24T00:00:00.000Z",
};
export const TEST_SECRETS = { IP_HASH_KEY: "test-only-ip-hash-key", RESEND_API_KEY: "" };

/** Bindings the other Workers own (WORK is never bound to asksite-sites), for seeding and pipeline tests. */
export interface ToolsEnv {
  DB: D1Database;
  WORK: R2Bucket;
  LIVE: R2Bucket;
  MEDIA: R2Bucket;
}

const REPO = resolve(import.meta.dirname, "../../../..");
// The tools Worker must name the same database id as asksite-sites to share its local D1, whatever
// id wrangler.jsonc holds (the placeholder now, the real id after the deploy task).
const SITES_CONFIG = JSON.parse(readFileSync(resolve(REPO, "apps/sites/wrangler.jsonc"), "utf8")) as { d1_databases: Array<{ database_id: string }> };
const DATABASE_ID = SITES_CONFIG.d1_databases[0]?.database_id ?? "";

/** asksite-sites from its real wrangler.jsonc, plus a "tools" Worker sharing its D1 and R2 storage. */
export function sitesHarness(overrides: { vars?: Record<string, string>; secrets?: Record<string, string> } = {}) {
  const server = createTestHarness({
    root: REPO,
    workers: [
      {
        configPath: "apps/sites/wrangler.jsonc",
        vars: { ...TEST_VARS, ...overrides.vars },
        secrets: { ...TEST_SECRETS, ...overrides.secrets },
      },
      {
        config: {
          name: "tools",
          main: "packages/core/test/support/noop-worker.ts",
          compatibility_date: "2026-09-21",
          d1_databases: [{ binding: "DB", database_name: "asksite", database_id: DATABASE_ID, migrations_dir: "packages/core/migrations" }],
          r2_buckets: [
            { binding: "WORK", bucket_name: "asksite-work" },
            { binding: "LIVE", bucket_name: "asksite-live" },
            { binding: "MEDIA", bucket_name: "asksite-media" },
          ],
        },
      },
    ],
  });
  return {
    server,
    async start(): Promise<{ sites: Env; tools: ToolsEnv }> {
      await server.listen();
      const tools = server.getWorker<ToolsEnv>("tools");
      await tools.applyD1Migrations("DB");
      return { sites: await server.getWorker<Env>("asksite-sites").getEnv(), tools: await tools.getEnv() };
    },
  };
}

export const at = (slug: string, path = "/") => `https://${slug}.${ROOT}${path}`;

let counter = 0;

export interface SeededSite { ownerId: string; ownerEmail: string; siteId: string; slug: string; html: string; versionId: string | null }

/** An owner and a site. By default the site is live (a live version id and a LIVE object) and indexable.
 *  The LIVE object carries the metadata approveVersion writes, which the Worker checks (Decision 24). */
export async function seedSite(
  env: ToolsEnv,
  options: { live?: boolean; indexable?: boolean; takenDown?: boolean; withObject?: boolean } = {},
): Promise<SeededSite> {
  const { live = true, indexable = true, takenDown = false, withObject = live } = options;
  counter += 1;
  const ownerId = newId();
  const siteId = newId();
  const versionId = live ? newId() : null;
  const slug = `shop-${counter}-${siteId.slice(0, 6)}`;
  const ownerEmail = `owner-${counter}@example.com`;
  const html = `<!DOCTYPE html><html lang="en"><head><title>${slug}</title></head><body><main><h1>${slug}</h1></main></body></html>`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO owners (id, email, created_at) VALUES (?, ?, 1)").bind(ownerId, ownerEmail),
    env.DB.prepare("INSERT INTO sites (id, owner_id, slug, live_version_id, indexable, taken_down_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1)")
      .bind(siteId, ownerId, slug, versionId, indexable ? 1 : 0, takenDown ? 5 : null),
  ]);
  const site = { ownerId, ownerEmail, siteId, slug, html, versionId };
  if (withObject) await putLive(env, site);
  return site;
}

/** Stores a site's page in LIVE the way approveVersion does: content type and { siteId, versionId } metadata. */
export async function putLive(env: ToolsEnv, site: Pick<SeededSite, "slug" | "siteId" | "versionId" | "html">): Promise<void> {
  await env.LIVE.put(liveKey(site.slug), site.html, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
    customMetadata: { siteId: site.siteId, versionId: site.versionId ?? "" },
  });
}

/** A site's leads once none is still 'pending': the lead email runs after the 303 (ctx.waitUntil, Decision 26). */
export async function settledLeads(env: ToolsEnv, siteId: string): Promise<Array<Record<string, unknown>>> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { results } = await env.DB.prepare("SELECT * FROM leads WHERE site_id = ? ORDER BY created_at").bind(siteId).all<Record<string, unknown>>();
    if (results.length > 0 && results.every((lead) => lead["email_status"] !== "pending")) return results;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`site ${siteId}: no lead, or its email never finished`);
}

/** A stored photo for a site. The R2 object's own content type is deliberately wrong: the Worker must ignore it. */
export async function seedUpload(env: ToolsEnv, siteId: string, options: { deleted?: boolean } = {}): Promise<{ uploadId: string; bytes: Uint8Array }> {
  const uploadId = newId();
  const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
  await env.DB.prepare("INSERT INTO uploads (id, site_id, width, height, bytes, created_at, deleted_at) VALUES (?, ?, 1600, 1200, ?, 1, ?)")
    .bind(uploadId, siteId, bytes.byteLength, options.deleted ? 9 : null)
    .run();
  await env.MEDIA.put(mediaKey(siteId, uploadId), bytes, { httpMetadata: { contentType: "text/html" } });
  return { uploadId, bytes };
}
```

`apps/sites/test/headers.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fixedPageHeaders, livePageHeaders, mediaHeaders, pageCsp, rootHostname } from "../src/headers.ts";

describe("headers", () => {
  it("builds the page CSP from the root, port included", () => {
    expect(pageCsp("asksite.example")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src https://media.asksite.example; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    expect(pageCsp("localhost:8789")).toContain("img-src https://media.localhost:8789;");
  });

  it("sends HSTS in production only", () => {
    expect(livePageHeaders("asksite.example", true).get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
    expect(fixedPageHeaders("asksite.example").get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
    expect(livePageHeaders("localhost:8789", true).get("strict-transport-security")).toBeNull();
    expect(fixedPageHeaders("dev.localhost:8789").get("strict-transport-security")).toBeNull();
  });

  it("adds noindex to a live page only when the site is not indexable", () => {
    expect(livePageHeaders("asksite.example", true).get("x-robots-tag")).toBeNull();
    expect(livePageHeaders("asksite.example", false).get("x-robots-tag")).toBe("noindex");
    expect(fixedPageHeaders("asksite.example").get("x-robots-tag")).toBe("noindex");
  });

  it("gives photos a day in browsers and five minutes at the edge", () => {
    expect(mediaHeaders().get("cache-control")).toBe("public, max-age=86400, s-maxage=300");
    expect(mediaHeaders().get("content-type")).toBe("image/webp");
  });

  it("strips the port from the root for email addresses", () => {
    expect(rootHostname("localhost:8789")).toBe("localhost");
    expect(rootHostname("asksite.example")).toBe("asksite.example");
  });
});
```

`apps/sites/test/config.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.ts";

// The production configuration must be safe as committed (design §9.1 "Unsafe production
// configuration"). wrangler.jsonc is kept as plain JSON so tests and `pnpm dev` can JSON.parse it.
const dir = resolve(import.meta.dirname, "..");
const config = JSON.parse(readFileSync(resolve(dir, "wrangler.jsonc"), "utf8"));
const vars: Record<string, string> = config.vars;
const SECRETS = ["RESEND_API_KEY", "IP_HASH_KEY"];

// Every key of Env, checked at compile time by Record<keyof Env, true>.
const ENV_KEYS: Record<keyof Env, true> = {
  DB: true, LIVE: true, MEDIA: true, FORM_RL: true, ENVIRONMENT: true, ROOT_DOMAIN: true, MAILER: true,
  MAIL_FROM: true, SECURITY_TXT_EXPIRES: true, RESEND_API_KEY: true, IP_HASH_KEY: true,
};

describe("apps/sites/wrangler.jsonc (production)", () => {
  it("is the production configuration", () => {
    expect(config.name).toBe("asksite-sites");
    expect(vars["ENVIRONMENT"]).toBe("production");
    expect(vars["MAILER"]).toBe("resend");
    expect(config.compatibility_date).toBe("2026-09-21");
    expect(config.compatibility_flags ?? []).toEqual([]);
  });

  it("is reachable only through its routes, and keeps invocation logs off", () => {
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.observability).toEqual({ enabled: true, logs: { invocation_logs: false } });
    const root = vars["ROOT_DOMAIN"];
    expect(config.routes.map((r: { pattern: string }) => r.pattern)).toEqual([`*.${root}/*`, `${root}/*`]);
    for (const r of config.routes) expect(r.zone_name).toBe(root);
  });

  it("has read-only access to LIVE and MEDIA and no binding to unapproved pages", () => {
    expect(config.r2_buckets).toEqual([
      { binding: "LIVE", bucket_name: "asksite-live" },
      { binding: "MEDIA", bucket_name: "asksite-media" },
    ]);
    expect(JSON.stringify(config)).not.toContain("asksite-work");
    expect(config.d1_databases).toEqual([
      { binding: "DB", database_name: "asksite", database_id: expect.any(String), migrations_dir: "../../packages/core/migrations" },
    ]);
    expect(config.ratelimits).toEqual([{ name: "FORM_RL", namespace_id: "1004", simple: { limit: 5, period: 60 } }]);
  });

  it("keeps secrets out of vars", () => {
    for (const name of Object.keys(vars)) expect(name).not.toMatch(/KEY|SECRET|TOKEN|PASSWORD/i);
    for (const secret of SECRETS) expect(vars).not.toHaveProperty(secret);
  });

  it("names exactly the bindings, variables and secrets the Env type declares", () => {
    const fromConfig = [
      ...config.d1_databases.map((d: { binding: string }) => d.binding),
      ...config.r2_buckets.map((b: { binding: string }) => b.binding),
      ...config.ratelimits.map((r: { name: string }) => r.name),
      ...Object.keys(vars),
      ...SECRETS,
    ].sort();
    expect(fromConfig).toEqual(Object.keys(ENV_KEYS).sort());
  });

  it("has a valid security.txt expiry date", () => {
    expect(Number.isNaN(Date.parse(vars["SECURITY_TXT_EXPIRES"] ?? ""))).toBe(false);
  });
});

describe("apps/sites/.dev.vars.example", () => {
  const lines = readFileSync(resolve(dir, ".dev.vars.example"), "utf8").split("\n").filter((l) => l !== "" && !l.startsWith("#"));
  const entries = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

  it("switches everything to local development", () => {
    expect(entries).toMatchObject({ ENVIRONMENT: "development", ROOT_DOMAIN: "localhost:8789", MAILER: "log" });
  });

  it("lists every secret by name and holds no real key", () => {
    for (const secret of SECRETS) expect(entries).toHaveProperty(secret);
    expect(entries["RESEND_API_KEY"]).toBe("");
  });
});
```

`apps/sites/test/source.test.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The approval rule is enforced by bindings (design §0.2): asksite-sites only reads LIVE and MEDIA
// and has no WORK binding. This scan keeps it that way in source too.
const srcDir = resolve(import.meta.dirname, "../src");
const sources = readdirSync(srcDir)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ file: f, text: readFileSync(resolve(srcDir, f), "utf8") }));

describe("asksite-sites source", () => {
  it("has files to scan", () => {
    expect(sources.length).toBeGreaterThan(5);
  });

  it("never writes to or deletes from LIVE or MEDIA", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/\b(LIVE|MEDIA)\s*\.\s*(put|delete|createMultipartUpload|resumeMultipartUpload)\b/);
    }
  });

  it("never mentions the WORK bucket", () => {
    for (const { file, text } of sources) expect(text, file).not.toMatch(/\bWORK\b|asksite-work/);
  });

  it("never logs request headers, IPs or lead fields", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/console\.(log|info|warn|error)\((?!JSON\.stringify\(\{ worker: "asksite-sites")/);
    }
  });
});
```

`apps/sites/test/routing.workerd.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { at, ROOT, sitesHarness } from "./support/harness.ts";

const harness = sitesHarness();
beforeAll(async () => {
  await harness.start();
}, 120_000);
afterAll(async () => {
  await harness.server.close();
});

// Request and response types come from the harness (Miniflare), not the Workers runtime types.
type Init = NonNullable<Parameters<typeof harness.server.fetch>[1]>;
type HarnessResponse = Awaited<ReturnType<typeof harness.server.fetch>>;
const get = (url: string, init: Init = {}): Promise<HarnessResponse> => harness.server.fetch(url, { redirect: "manual", ...init });

function expectFixedPage(response: HarnessResponse, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("x-robots-tag")).toBe("noindex");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-security-policy")).toBe(
    `default-src 'none'; style-src 'unsafe-inline'; img-src https://media.${ROOT}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  );
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}

describe("apex", () => {
  it("serves the placeholder page with the abuse contact", async () => {
    const response = await get(`https://${ROOT}/`);
    expectFixedPage(response, 200);
    const body = await response.text();
    expect(body).toContain("<h1>Websites for local trades</h1>");
    expect(body).toContain('href="mailto:abuse@localhost"');
  });

  it("never sends HSTS for a localhost root (it would force https on every local project)", async () => {
    expect((await get(`https://${ROOT}/`)).headers.get("strict-transport-security")).toBeNull();
  });

  it("serves security.txt with Contact and Expires", async () => {
    const response = await get(`https://${ROOT}/.well-known/security.txt`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(await response.text()).toBe("Contact: mailto:security@localhost\nExpires: 2027-09-24T00:00:00.000Z\nPreferred-Languages: en\n");
  });

  it("answers any other apex path or method with the 404 page", async () => {
    expectFixedPage(await get(`https://${ROOT}/admin`), 404);
    expectFixedPage(await get(`https://${ROOT}/`, { method: "POST", body: "x" }), 404);
  });

  it("answers HEAD with headers and no body", async () => {
    const response = await get(`https://${ROOT}/`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(await response.text()).toBe("");
  });
});

describe("www", () => {
  it("redirects every path to the apex home page", async () => {
    const response = await get(`https://www.${ROOT}/some/path?q=1`);
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(`https://${ROOT}/`);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
  });
});

describe("hosts we do not serve", () => {
  it.each([`app.${ROOT}`, `admin.${ROOT}`, `a.b.${ROOT}`, `jo.${ROOT}`, "joes.localhost:8790", "joes.example.com"])("%s gets the 404 page", async (host) => {
    expectFixedPage(await get(`https://${host}/`), 404);
  });

  it("a site host has only / and the form routes", async () => {
    expectFixedPage(await get(at("joes", "/wp-admin")), 404);
    expectFixedPage(await get(at("joes", "/_f/not-an-id/sent")), 404);
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `pnpm vitest run apps/sites`
Expected: FAIL: `Test Files  4 failed (4)`: `Error: ENOENT: no such file or directory, open '…/apps/sites/wrangler.jsonc'` twice (config, and routing through `test/support/harness.ts`, which reads the config for its database id), `Cannot find module '../src/headers.ts'`, and `ENOENT … scandir '…/apps/sites/src'` (source).

- [ ] **Step 4: Write the configuration and the Worker**

`apps/sites/wrangler.jsonc`:

```jsonc
{
  "$schema": "../../node_modules/wrangler/config-schema.json",
  "name": "asksite-sites",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-21",
  "workers_dev": false,
  "preview_urls": false,
  "observability": { "enabled": true, "logs": { "invocation_logs": false } },
  "routes": [
    { "pattern": "*.asksite.example/*", "zone_name": "asksite.example" },
    { "pattern": "asksite.example/*", "zone_name": "asksite.example" }
  ],
  "vars": {
    "ENVIRONMENT": "production",
    "ROOT_DOMAIN": "asksite.example",
    "MAILER": "resend",
    "MAIL_FROM": "asksite <leads@mail.asksite.example>",
    "SECURITY_TXT_EXPIRES": "2027-09-24T00:00:00.000Z"
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "asksite",
      "database_id": "00000000-0000-0000-0000-000000000000",
      "migrations_dir": "../../packages/core/migrations"
    }
  ],
  "r2_buckets": [
    { "binding": "LIVE", "bucket_name": "asksite-live" },
    { "binding": "MEDIA", "bucket_name": "asksite-media" }
  ],
  "ratelimits": [{ "name": "FORM_RL", "namespace_id": "1004", "simple": { "limit": 5, "period": 60 } }]
}
```

`apps/sites/.dev.vars.example`:

```text
# Local development values for asksite-sites. `pnpm dev` copies this file to .dev.vars (gitignored)
# when .dev.vars is missing. They override the production values in wrangler.jsonc "vars".
# Never put a real key here: this file is committed.
ENVIRONMENT=development
ROOT_DOMAIN=localhost:8789
MAILER=log
MAIL_FROM="asksite dev <dev@localhost>"
RESEND_API_KEY=
IP_HASH_KEY=local-development-only-not-a-secret
```

`apps/sites/src/env.ts`:

```ts
/**
 * Bindings and variables of the asksite-sites Worker (apps/sites/wrangler.jsonc). Written by hand:
 * `wrangler types` emits a global `Env`, which would clash with the other Workers' types, and it
 * reads secrets from the gitignored .dev.vars, so its output differs between machines.
 * test/config.test.ts proves this list matches the config.
 */
export interface Env {
  DB: D1Database;
  /** Approved pages only. Read-only by type: this Worker can never put or delete (only asksite-admin writes LIVE). */
  LIVE: Pick<R2Bucket, "get" | "head">;
  /** Re-encoded photos. Read-only by type (asksite-app writes MEDIA). */
  MEDIA: Pick<R2Bucket, "get" | "head">;
  FORM_RL: RateLimit;
  ENVIRONMENT: string;
  /** host[:port] of the product domain, e.g. "asksite.example" or "localhost:8789". */
  ROOT_DOMAIN: string;
  MAILER: "resend" | "log";
  MAIL_FROM: string;
  /** RFC 9116 Expires for /.well-known/security.txt, an ISO 8601 date set at deploy time. */
  SECURITY_TXT_EXPIRES: string;
  /** Secrets (wrangler secret put, or .dev.vars locally). Missing ones fail closed. */
  RESEND_API_KEY?: string;
  IP_HASH_KEY?: string;
}
```

`apps/sites/src/headers.ts`:

```ts
// Response headers for everything served on customer hostnames (design §7.3, §7.4).

/** The host part of ROOT_DOMAIN, without a port: "localhost" for "localhost:8789". */
export const rootHostname = (root: string): string => root.replace(/:\d+$/, "");

/** HSTS is never sent for localhost: with includeSubDomains it would force https onto every local
 *  project on this machine (browsers apply HSTS per host, ignoring the port). */
const isLocal = (root: string): boolean => {
  const host = rootHostname(root);
  return host === "localhost" || host.endsWith(".localhost");
};

export const pageCsp = (root: string): string =>
  `default-src 'none'; style-src 'unsafe-inline'; img-src https://media.${root}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;

function securityHeaders(root: string): Record<string, string> {
  return {
    "Content-Security-Policy": pageCsp(root),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    ...(isLocal(root) ? {} : { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" }),
  };
}

const HTML = "text/html; charset=utf-8";

/** An approved page. The only response without X-Robots-Tag, and only while the site is indexable. */
export function livePageHeaders(root: string, indexable: boolean): Headers {
  const headers = new Headers({ "Content-Type": HTML, "Cache-Control": "public, max-age=60", ...securityHeaders(root) });
  if (!indexable) headers.set("X-Robots-Tag", "noindex");
  return headers;
}

/** Fixed pages (404, 503, thank-you, form errors, apex): never cached, never indexed. */
export function fixedPageHeaders(root: string): Headers {
  return new Headers({ "Content-Type": HTML, "Cache-Control": "no-store", "X-Robots-Tag": "noindex", ...securityHeaders(root) });
}

/** Photos: a day in browsers, 5 minutes at the edge (s-maxage wins for Cloudflare's cache), so a
 *  takedown stops them at the edge within 5 minutes. The type is always set here, never taken from R2. */
export function mediaHeaders(): Headers {
  return new Headers({
    "Content-Type": "image/webp",
    "Cache-Control": "public, max-age=86400, s-maxage=300",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Robots-Tag": "noindex",
  });
}

/** Redirects and plain-text answers. */
export function plainHeaders(extra: Record<string, string> = {}): Headers {
  return new Headers({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "X-Content-Type-Options": "nosniff", ...extra });
}
```

`apps/sites/src/pages.ts`:

```ts
import { escapeAttr, escapeText } from "@asksite/renderer";
import { fixedPageHeaders, rootHostname } from "./headers.ts";

// Fixed pages. Every word is a constant from this file: they never contain a submitted value.
// Each has lang, a title, one h1 inside <main>, and reads well at 320 px (checked by axe in e2e).

const STYLE =
  "body{margin:0;background:#fff;color:#1f2937;font:1.125rem/1.6 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}" +
  "main{max-width:36rem;margin:0 auto;padding:3rem 1.5rem}h1{font-size:1.75rem;line-height:1.25;margin:0 0 1rem;color:#111827}" +
  "a{color:#1d4ed8;text-decoration:underline;text-underline-offset:.15em}a:focus-visible{outline:3px solid #1d4ed8;outline-offset:3px}" +
  "ul{padding-left:1.25rem}li{margin:.25rem 0}p{margin:0 0 1rem}";

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeText(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${escapeText(title)}</h1>
${body}
</main>
</body>
</html>
`;
}

function respond(root: string, status: number, html: string, extra: Record<string, string> = {}): Response {
  const headers = fixedPageHeaders(root);
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return new Response(html, { status, headers });
}

const HOME_LINK = '<p><a href="/">Go to the home page</a></p>';

// No home link: on a host with no live site, "/" is this same page.
export const notFound = (root: string) =>
  respond(root, 404, page("Page not found", "<p>There is no page at this address. Please check the address and try again.</p>"));

export const unavailable = (root: string) =>
  respond(root, 503, page("Temporarily unavailable", "<p>This page could not be loaded just now. Please try again in a minute.</p>"), { "Retry-After": "60" });

export const thankYou = (root: string) =>
  respond(root, 200, page("Thanks! Your message was sent.", '<p>The business will get back to you soon.</p>\n<p><a href="/">Back to the website</a></p>'));

export const tooManyRequests = (root: string) =>
  respond(
    root,
    429,
    page("Please wait a minute", `<p>We received several messages from you in a short time. Please try again in a minute, or call the business directly.</p>\n${HOME_LINK}`),
    { "Retry-After": "60" },
  );

export const siteBusy = (root: string) =>
  respond(
    root,
    429,
    page("Please call instead", `<p>This business has received a lot of messages today, so the form is closed until tomorrow. Their phone number is on the website.</p>\n${HOME_LINK}`),
    { "Retry-After": "3600" },
  );

export const unreadableForm = (root: string, status: 413 | 415) =>
  respond(root, status, page("We could not send that", '<p>Your message could not be read. Please go back and try again.</p>\n<p><a href="/#contact">Go back to the form</a></p>'));

/** Plain-words problems, chosen by code: the page never repeats what was typed. */
export function formProblems(root: string, problems: readonly string[]): Response {
  const items = problems.map((problem) => `<li>${escapeText(problem)}</li>`).join("\n");
  return respond(
    root,
    400,
    page(
      "Please check your details",
      `<ul>\n${items}\n</ul>\n<p>Use your browser's Back button to return to the form with what you typed, or <a href="/#contact">go back to the form</a>.</p>`,
    ),
  );
}

export function apexPlaceholder(root: string): Response {
  const abuse = `abuse@${rootHostname(root)}`;
  return respond(
    root,
    200,
    page(
      "Websites for local trades",
      `<p>We build and host websites for home-service businesses. Each business has its own address on this domain.</p>\n` +
        `<p>To report a site for phishing, spam or abuse, email <a href="mailto:${escapeAttr(abuse)}">${escapeText(abuse)}</a>.</p>`,
    ),
  );
}
```

`apps/sites/src/apex.ts`:

```ts
import type { Env } from "./env.ts";
import { plainHeaders, rootHostname } from "./headers.ts";
import { notFound } from "./pages.ts";

/** RFC 9116 security.txt. Expires comes from SECURITY_TXT_EXPIRES, set at deploy time; if it is not
 *  a valid date the file is not served at all rather than served wrong. */
export function securityTxt(env: Env): Response {
  const expires = Date.parse(env.SECURITY_TXT_EXPIRES);
  if (Number.isNaN(expires)) return notFound(env.ROOT_DOMAIN);
  const body = `Contact: mailto:security@${rootHostname(env.ROOT_DOMAIN)}\nExpires: ${new Date(expires).toISOString()}\nPreferred-Languages: en\n`;
  return new Response(body, { headers: plainHeaders({ "Content-Type": "text/plain; charset=utf-8" }) });
}
```

`apps/sites/src/log.ts`:

```ts
/** One structured line per request or cron run. IDs and codes only: never IPs, emails, tokens,
 *  lead content or keys (invocation logs are off, so this is the whole log). */
export function logLine(fields: { route: string; status?: number; ms: number; siteId?: string; code?: string; deleted?: number }): void {
  console.log(JSON.stringify({ worker: "asksite-sites", ...fields }));
}
```

`apps/sites/src/router.ts` (first version; Tasks 12 and 13 add the site routes):

```ts
import { parseHost } from "@asksite/core";
import { securityTxt } from "./apex.ts";
import type { Env } from "./env.ts";
import { plainHeaders } from "./headers.ts";
import { apexPlaceholder, notFound } from "./pages.ts";

export interface Routed {
  route: string;
  response: Response;
  siteId?: string;
  code?: string;
}

/** Routes by the Host header (design §4.6). Anything not listed is a 404 page. */
export async function route(request: Request, env: Env, _ctx: ExecutionContext, _now: number): Promise<Routed> {
  const url = new URL(request.url);
  const path = url.pathname;
  const root = env.ROOT_DOMAIN;
  const read = request.method === "GET" || request.method === "HEAD";
  const host = parseHost(url.host, root);

  switch (host.kind) {
    case "www":
      return { route: "www", response: new Response(null, { status: 301, headers: plainHeaders({ Location: `https://${root}/` }) }) };
    case "apex":
      if (read && path === "/") return { route: "apex", response: apexPlaceholder(root) };
      if (read && path === "/.well-known/security.txt") return { route: "security_txt", response: securityTxt(env) };
      break;
    case "media":
    case "site":
    case "unknown":
      break;
  }
  return { route: "not_found", response: notFound(root) };
}
```

`apps/sites/src/index.ts` (first version; Task 14 adds the cron handler):

```ts
// asksite-sites: public site pages, photos and contact forms on customer hostnames.
// A Worker's main module may export only handlers (workerd refuses other named exports).
import type { Env } from "./env.ts";
import { logLine } from "./log.ts";
import { route } from "./router.ts";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const started = Date.now();
    const { route: name, response, siteId, code } = await route(request, env, ctx, started);
    logLine({ route: name, status: response.status, ms: Date.now() - started, ...(siteId === undefined ? {} : { siteId }), ...(code === undefined ? {} : { code }) });
    return request.method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 5: Run the tests, the typecheck and a production build**

Run: `pnpm vitest run apps/sites && pnpm typecheck`
Expected: `Test Files  4 passed (4)`, `Tests  30 passed (30)`; typecheck exits 0.

Run: `pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run -c apps/sites/wrangler.jsonc && rm -rf .wrangler/dry-run`
Expected: a bindings table (`env.DB (asksite)`, `env.LIVE (asksite-live)`, `env.MEDIA (asksite-media)`, `env.FORM_RL (5 requests/60s)` and the five variables), `Total Upload: … KiB / gzip: … KiB` (planning replay: 796.42 KiB / 128.01 KiB) and `--dry-run: exiting now.`. No account is needed for a dry run [verified].

- [ ] **Step 6: Commit**

```bash
git add pnpm-lock.yaml apps/sites/package.json apps/sites/wrangler.jsonc apps/sites/.dev.vars.example apps/sites/src apps/sites/test
git commit -m "Add sites Worker"
```

---
### Task 12: Serving approved pages and photos

**Files:**
- Create: `apps/sites/src/page.ts`, `apps/sites/src/media.ts`
- Modify: `apps/sites/src/router.ts`
- Test: `apps/sites/test/serving.workerd.test.ts`

**Interfaces:**
- Consumes: `liveKey`, `siteUrl`, `isId`, `mediaKey`, `mediaUrl` (Task 2); `livePageHeaders`, `mediaHeaders`, `notFound`, `unavailable` (Task 11); the Cache API `caches.default` [verified: works in workerd locally; "the contents of the cache do not replicate outside of the originating data center" per developers.cloudflare.com/workers/runtime-apis/cache/].
- Produces: `servePage(env, ctx, slug)`, `serveMedia(env, ctx, pathname)`; the router serves `GET`/`HEAD /` on a site host and `GET`/`HEAD /<siteId>/<uploadId>.webp` on `media.<root>`.
- Behaviour (design §7.3, with Decision 24's order): cache hit → served; miss → `LIVE.get(liveKey(slug))` first, so a slug with no approved page is a 404 that never reaches D1 (one shared, single-threaded database, design §1.3); then D1 decides: `SELECT indexable, live_version_id FROM sites WHERE slug = ? AND live_version_id IS NOT NULL AND taken_down_at IS NULL`; no row → 404 (not cached); the object's `customMetadata.versionId` is not D1's `live_version_id` (an approval or restore half-way, or a late write of an older version) → 503 with `Retry-After: 60`, not cached, so stale bytes are never served; D1 or R2 error → 503 (not cached); otherwise the bytes with the §7.4 page headers (`X-Robots-Tag: noindex` only when `indexable = 0`), cached for 60 s. Photos: both ids must be UUIDs, `MEDIA.get` first (unknown ids never reach D1), then the upload must belong to that site and the site must not be taken down (soft-deleted uploads still serve), `Content-Type: image/webp` always set by the Worker, cached 300 s at the edge and a day in browsers (Decision 7).

- [ ] **Step 1: Write the failing test**

`apps/sites/test/serving.workerd.test.ts`:

```ts
import { liveKey, mediaKey, newId } from "@asksite/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { at, putLive, ROOT, seedSite, seedUpload, sitesHarness, type ToolsEnv } from "./support/harness.ts";

const harness = sitesHarness();
let tools: ToolsEnv;
beforeAll(async () => {
  ({ tools } = await harness.start());
}, 120_000);
afterAll(async () => {
  await harness.server.close();
});

// Request and response types come from the harness (Miniflare), not the Workers runtime types.
type Init = NonNullable<Parameters<typeof harness.server.fetch>[1]>;
type HarnessResponse = Awaited<ReturnType<typeof harness.server.fetch>>;
const get = (url: string, init: Init = {}): Promise<HarnessResponse> => harness.server.fetch(url, { redirect: "manual", ...init });
const CSP = `default-src 'none'; style-src 'unsafe-inline'; img-src https://media.${ROOT}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;

describe("live pages", () => {
  it("serves the approved bytes with the page headers and no noindex", async () => {
    const site = await seedSite(tools);
    const response = await get(at(site.slug));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(site.html);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=60",
      "content-security-policy": CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
    });
    expect(response.headers.get("x-robots-tag")).toBeNull();
  });

  it("ignores the query string", async () => {
    const site = await seedSite(tools);
    expect(await (await get(at(site.slug, "/?utm_source=x"))).text()).toBe(site.html);
  });

  it("adds noindex when the admin switched search engines off", async () => {
    const site = await seedSite(tools, { indexable: false });
    const response = await get(at(site.slug));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("D1 decides: a site that is not live gets 404 even when a LIVE object exists", async () => {
    const draft = await seedSite(tools, { live: false, withObject: true });
    expect((await get(at(draft.slug))).status).toBe(404);
    const takenDown = await seedSite(tools, { takenDown: true });
    const response = await get(at(takenDown.slug));
    expect(response.status).toBe(404);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("returns 404 without caching while the LIVE object is still missing", async () => {
    const site = await seedSite(tools, { withObject: false });
    expect((await get(at(site.slug))).status).toBe(404);
    await putLive(tools, site);
    expect((await get(at(site.slug))).status).toBe(200);
  });

  it("never asks D1 about a slug with no approved page: with D1's sites table gone it is still 404, not 503", async () => {
    await tools.DB.prepare("ALTER TABLE sites RENAME TO sites_offline").run();
    try {
      expect((await get(at("no-such-shop"))).status).toBe(404);
    } finally {
      await tools.DB.prepare("ALTER TABLE sites_offline RENAME TO sites").run();
    }
  });

  it("answers 503, uncached, while LIVE holds another version than the one D1 says is live", async () => {
    const site = await seedSite(tools);
    await putLive(tools, { ...site, versionId: newId(), html: "<!DOCTYPE html><p>an older version</p>" });
    const stale = await get(at(site.slug));
    expect(stale.status).toBe(503);
    expect(stale.headers.get("retry-after")).toBe("60");
    expect(stale.headers.get("x-robots-tag")).toBe("noindex");
    await putLive(tools, site);
    expect(await (await get(at(site.slug))).text()).toBe(site.html);
  });

  it("keeps a served page in this data centre's cache for its 60 s TTL", async () => {
    const site = await seedSite(tools);
    expect((await get(at(site.slug))).status).toBe(200);
    await tools.DB.prepare("UPDATE sites SET taken_down_at = 99 WHERE id = ?").bind(site.siteId).run();
    await tools.LIVE.delete(liveKey(site.slug));
    const cached = await get(at(site.slug));
    expect(cached.status).toBe(200);
    expect(await cached.text()).toBe(site.html);
  });

  it("answers HEAD with the page headers and no body", async () => {
    const site = await seedSite(tools);
    const response = await get(at(site.slug), { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(CSP);
    expect(await response.text()).toBe("");
  });

  it("answers 503 with Retry-After when D1 fails, and does not cache it", async () => {
    const site = await seedSite(tools);
    await tools.DB.prepare("ALTER TABLE sites RENAME TO sites_offline").run();
    try {
      const response = await get(at(site.slug));
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("60");
      expect(response.headers.get("x-robots-tag")).toBe("noindex");
    } finally {
      await tools.DB.prepare("ALTER TABLE sites_offline RENAME TO sites").run();
    }
    expect((await get(at(site.slug))).status).toBe(200);
  });
});

describe("photos on media.<root>", () => {
  const media = (siteId: string, uploadId: string) => `https://media.${ROOT}/${siteId}/${uploadId}.webp`;

  it("serves the stored bytes as image/webp whatever R2 metadata says", async () => {
    const site = await seedSite(tools);
    const { uploadId, bytes } = await seedUpload(tools, site.siteId);
    const response = await get(media(site.siteId, uploadId));
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "image/webp",
      "cache-control": "public, max-age=86400, s-maxage=300",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
      "cross-origin-resource-policy": "cross-origin",
      "x-robots-tag": "noindex",
    });
  });

  it("still serves a soft-deleted upload (a live version may show it)", async () => {
    const site = await seedSite(tools);
    const { uploadId } = await seedUpload(tools, site.siteId, { deleted: true });
    expect((await get(media(site.siteId, uploadId))).status).toBe(200);
  });

  it("stops serving a taken-down site's photos without deleting them", async () => {
    const site = await seedSite(tools, { takenDown: true });
    const { uploadId } = await seedUpload(tools, site.siteId);
    expect((await get(media(site.siteId, uploadId))).status).toBe(404);
    expect(await tools.MEDIA.get(mediaKey(site.siteId, uploadId))).not.toBeNull();
  });

  it("never asks D1 about a photo that is not stored: with D1's uploads table gone it is still 404, not 503", async () => {
    await tools.DB.prepare("ALTER TABLE uploads RENAME TO uploads_offline").run();
    try {
      expect((await get(media(newId(), newId()))).status).toBe(404);
    } finally {
      await tools.DB.prepare("ALTER TABLE uploads_offline RENAME TO uploads").run();
    }
  });

  it("refuses another site's id, unknown ids, bad paths and writes", async () => {
    const site = await seedSite(tools);
    const other = await seedSite(tools);
    const { uploadId } = await seedUpload(tools, site.siteId);
    expect((await get(media(other.siteId, uploadId))).status).toBe(404);
    expect((await get(media(site.siteId, "7c9e6679-7425-40de-944b-e07fc1f90ae7"))).status).toBe(404);
    expect((await get(`https://media.${ROOT}/${site.siteId}/${uploadId}.png`)).status).toBe(404);
    expect((await get(`https://media.${ROOT}/../${uploadId}.webp`)).status).toBe(404);
    expect((await get(media(site.siteId, uploadId), { method: "PUT", body: "x" })).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run apps/sites/test/serving.workerd.test.ts`
Expected: FAIL: `Tests  10 failed | 5 passed (15)`, mostly `expected 404 to be 200` (every site and media request is still a 404), and `expected 404 to be 503` for the stale version and the D1 failure. The five that pass are the 404 cases, including the two that prove an unknown slug or photo never reaches D1 (they fail on D1-first code: checked by moving the D1 read before the R2 read).

- [ ] **Step 3: Write the implementation**

`apps/sites/src/page.ts`:

```ts
import { liveKey, siteUrl } from "@asksite/core";
import type { Env } from "./env.ts";
import { livePageHeaders } from "./headers.ts";
import { notFound, unavailable } from "./pages.ts";

const LIVE_SITE = "SELECT indexable, live_version_id FROM sites WHERE slug = ? AND live_version_id IS NOT NULL AND taken_down_at IS NULL";

/**
 * GET / on a site host. R2 is read first, so a slug with no approved page never reaches D1 (one
 * shared, single-threaded database; Decision 24). D1 then decides whether to serve, and the bytes
 * must be the version D1 says is live. Served pages are kept in this data centre's cache for 60 s,
 * so approvals, takedowns and the search-engine switch spread within about a minute (plus up to
 * 60 s in a visitor's browser).
 */
export async function servePage(env: Env, ctx: ExecutionContext, slug: string): Promise<Response> {
  const root = env.ROOT_DOMAIN;
  const cacheKey = new Request(siteUrl(root, slug));
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached !== undefined) return cached;

  let body: ArrayBuffer;
  let versionId: string | undefined;
  let site: { indexable: number; live_version_id: string } | null;
  try {
    const object = await env.LIVE.get(liveKey(slug));
    // Never approved, unknown, or the seconds between an approval's D1 write and its R2 write. Not cached.
    if (object === null) return notFound(root);
    body = await object.arrayBuffer();
    versionId = object.customMetadata?.["versionId"];
    site = await env.DB.prepare(LIVE_SITE).bind(slug).first<{ indexable: number; live_version_id: string }>();
  } catch {
    return unavailable(root);
  }
  // Not live, or taken down (D1 alone decides; LIVE may still hold the bytes). Not cached.
  if (site === null) return notFound(root);
  // LIVE holds another version than D1's live one (an approval or restore half-way, or a late write
  // of an older version): never serve stale bytes. Not cached; the next request sees the fix.
  if (versionId !== site.live_version_id) return unavailable(root);

  const response = new Response(body, { headers: livePageHeaders(root, site.indexable === 1) });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
```

`apps/sites/src/media.ts`:

```ts
import { isId, mediaKey, mediaUrl } from "@asksite/core";
import type { Env } from "./env.ts";
import { mediaHeaders } from "./headers.ts";
import { notFound, unavailable } from "./pages.ts";

const MEDIA_PATH = /^\/([^/]+)\/([^/]+)\.webp$/;
const SERVABLE = "SELECT 1 AS ok FROM uploads u JOIN sites s ON s.id = u.site_id WHERE u.id = ? AND u.site_id = ? AND s.taken_down_at IS NULL";

/**
 * GET /<siteId>/<uploadId>.webp on media.<root>. R2 first, so ids with no stored photo never reach D1
 * (Decision 24); then served while the upload row exists for that site and the site is not taken down.
 * Soft-deleted uploads are still served (a live or pending version may show them). URLs are two random
 * UUIDs, so unapproved photos are unguessable, not secret.
 */
export async function serveMedia(env: Env, ctx: ExecutionContext, pathname: string): Promise<Response> {
  const root = env.ROOT_DOMAIN;
  const match = MEDIA_PATH.exec(pathname);
  const siteId = match?.[1] ?? "";
  const uploadId = match?.[2] ?? "";
  if (!isId(siteId) || !isId(uploadId)) return notFound(root);

  const cacheKey = new Request(mediaUrl(root, siteId, uploadId));
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached !== undefined) return cached;

  let body: ArrayBuffer;
  let servable: unknown;
  try {
    const object = await env.MEDIA.get(mediaKey(siteId, uploadId));
    if (object === null) return notFound(root);
    body = await object.arrayBuffer();
    servable = await env.DB.prepare(SERVABLE).bind(uploadId, siteId).first();
  } catch {
    return unavailable(root);
  }
  if (servable === null) return notFound(root);

  const response = new Response(body, { headers: mediaHeaders() });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
```

`apps/sites/src/router.ts` (full new content):

```ts
import { parseHost } from "@asksite/core";
import { securityTxt } from "./apex.ts";
import type { Env } from "./env.ts";
import { plainHeaders } from "./headers.ts";
import { serveMedia } from "./media.ts";
import { servePage } from "./page.ts";
import { apexPlaceholder, notFound } from "./pages.ts";

export interface Routed {
  route: string;
  response: Response;
  siteId?: string;
  code?: string;
}

/** Routes by the Host header (design §4.6). Anything not listed is a 404 page. */
export async function route(request: Request, env: Env, ctx: ExecutionContext, _now: number): Promise<Routed> {
  const url = new URL(request.url);
  const path = url.pathname;
  const root = env.ROOT_DOMAIN;
  const read = request.method === "GET" || request.method === "HEAD";
  const host = parseHost(url.host, root);

  switch (host.kind) {
    case "www":
      return { route: "www", response: new Response(null, { status: 301, headers: plainHeaders({ Location: `https://${root}/` }) }) };
    case "apex":
      if (read && path === "/") return { route: "apex", response: apexPlaceholder(root) };
      if (read && path === "/.well-known/security.txt") return { route: "security_txt", response: securityTxt(env) };
      break;
    case "media":
      if (read) return { route: "media", response: await serveMedia(env, ctx, path) };
      break;
    case "site":
      if (read && path === "/") return { route: "page", response: await servePage(env, ctx, host.slug) };
      break;
    case "unknown":
      break;
  }
  return { route: "not_found", response: notFound(root) };
}
```

- [ ] **Step 4: Run the sites tests and the typecheck**

Run: `pnpm vitest run apps/sites && pnpm typecheck`
Expected: `Test Files  5 passed (5)`, `Tests  45 passed (45)`; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/sites/src/page.ts apps/sites/src/media.ts apps/sites/src/router.ts apps/sites/test/serving.workerd.test.ts
git commit -m "Serve pages photos"
```

---
### Task 13: The contact form, the lead and the lead email

**Files:**
- Create: `apps/sites/src/lead.ts`, `apps/sites/src/lead-email.ts`, `apps/sites/src/form.ts`
- Modify: `apps/sites/src/router.ts`, `apps/sites/src/index.ts` (any uncaught error becomes the 503 page)
- Test: `apps/sites/test/lead.test.ts`, `apps/sites/test/lead-email.test.ts`, `apps/sites/test/form.workerd.test.ts`, `apps/sites/test/resend.workerd.test.ts`

**Interfaces:**
- Consumes: `hashIp`, `ipRateKey`, `isId`, `liveKey`, `LIMITS`, `newId`, `siteUrl`, `utcDayStart` (Tasks 2–4); `createMailer`, `MailerError`, `type OutgoingEmail` (Task 7); `escapeText`, `escapeAttr` (Plan 1); the fixed pages and `logLine` (Task 11); `settledLeads` (Task 11's test support). Plan 1 Task 13's form fields: `name`, `phone`, `email`, `service`, `message`, honeypot `website`, `action = formActionUrl(root, slug, siteId)`, `method="post"`.
- Produces: `POST /_f/<siteId>` and `GET /_f/<siteId>/sent` (design §4.6, §7.5); `readLead(fields)`, `PROBLEM_TEXT`, `looksLikeSpam(lead)`, `type Lead`, `leadEmail(input): OutgoingEmail`, `handleForm(request, env, ctx, hostSlug, siteId, now)`; the Worker's `fetch` turns any uncaught error into the 503 page with `X-Robots-Tag: noindex` (Decision 26).
- Behaviour, in the design's order: UUID and site host (else 404) → `application/x-www-form-urlencoded` (else 415) and at most 16 KB counted while reading (else 413) → `FORM_RL` keyed `<siteId>:<hashIp(ipRateKey(ip))>`, so an IPv6 visitor is limited per /64 (else 429, `Retry-After: 60`; Decision 27) → honeypot filled: 303 to the thank-you page, nothing stored → field checks with plain-words problems that never echo input (400) → the host's `LIVE` object must exist and name this `siteId` (R2 only, so a form for a site with no approved page never reaches D1; Decision 24) → D1: the site must be live, not taken down, and its slug must equal the host's (else 404) → one conditional insert keeps the 50-per-UTC-day cap exact (else 429 "Please call instead") → more than 3 `http` in the message: stored as spam, not emailed → 303 to `/_f/<siteId>/sent`; the email to the owner's login email runs after the response (`ctx.waitUntil`) and marks the lead `sent` or `failed` (the lead is always kept; a failure there can never turn into an error page; Decision 26). Without `IP_HASH_KEY` it fails closed with 503 (Decision 21). Any D1 or R2 failure gives the 503 page, never the platform's error page.

- [ ] **Step 1: Write the failing tests**

`apps/sites/test/lead.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { looksLikeSpam, readLead } from "../src/lead.ts";

const fields = (values: Record<string, string>) => new URLSearchParams(values);

describe("readLead", () => {
  it("accepts the minimum: a name and a phone number", () => {
    expect(readLead(fields({ name: "Al", phone: "5125550199" }))).toEqual({
      ok: true,
      lead: { name: "Al", phone: "5125550199", email: null, service: null, message: null },
    });
  });

  it("trims every field and turns empty optional fields into null", () => {
    const result = readLead(fields({ name: "  Al  ", phone: " +1 (512) 555-0199 ", email: " ", service: "", message: "  " }));
    expect(result).toEqual({ ok: true, lead: { name: "Al", phone: "+1 (512) 555-0199", email: null, service: null, message: null } });
  });

  it.each([
    ["name", { name: "", phone: "5125550199" }],
    ["name", { name: "x".repeat(81), phone: "5125550199" }],
    ["phone", { name: "Al", phone: "" }],
    ["phone", { name: "Al", phone: "555-01" }],
    ["phone", { name: "Al", phone: "call me maybe 5125550199" }],
    ["phone", { name: "Al", phone: "(((((((((((" }],
    ["phone", { name: "Al", phone: "5".repeat(31) }],
    ["email", { name: "Al", phone: "5125550199", email: "not-an-email" }],
    ["email", { name: "Al", phone: "5125550199", email: `${"a".repeat(250)}@b.co` }],
    ["service", { name: "Al", phone: "5125550199", service: "s".repeat(61) }],
    ["message", { name: "Al", phone: "5125550199", message: "m".repeat(2001) }],
  ])("reports %s", (problem, values) => {
    expect(readLead(fields(values))).toEqual({ ok: false, problems: [problem] });
  });

  it("reports every problem at once, in field order", () => {
    expect(readLead(fields({}))).toEqual({ ok: false, problems: ["name", "phone"] });
  });

  it("counts a CRLF line break in the message as one character, as the browser's maxlength does", () => {
    const message = `${"m".repeat(999)}\r\n${"m".repeat(1000)}`;
    const result = readLead(fields({ name: "Al", phone: "5125550199", message }));
    expect(result.ok && result.lead.message?.length).toBe(2000);
  });

  it("removes control and invisible characters, keeping emoji joiners and message newlines", () => {
    const result = readLead(fields({ name: "Ana\u200B \u{1F469}\u200D\u{1F527}\u0000", phone: "512\u202E5550199", message: "a\r\nb\u0007" }));
    expect(result).toEqual({ ok: true, lead: { name: "Ana \u{1F469}\u200D\u{1F527}", phone: "5125550199", email: null, service: null, message: "a\nb" } });
  });

  it("keeps a single-line field on one line", () => {
    const result = readLead(fields({ name: "Al\r\nBcc: x@y.example", phone: "5125550199" }));
    expect(result.ok && result.lead.name).toBe("AlBcc: x@y.example");
  });
});

describe("looksLikeSpam", () => {
  const lead = (message: string | null) => ({ name: "n", phone: "5125550199", email: null, service: null, message });
  it("flags more than three http occurrences, case-insensitively", () => {
    expect(looksLikeSpam(lead("http://a HTTP://b https://c"))).toBe(false);
    expect(looksLikeSpam(lead("http://a HTTP://b https://c Http://d"))).toBe(true);
    expect(looksLikeSpam(lead(null))).toBe(false);
  });
});
```

`apps/sites/test/lead-email.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { leadEmail } from "../src/lead-email.ts";

const base = {
  to: "owner@example.com",
  leadId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  siteUrl: "https://joes.asksite.example/",
  lead: { name: "Dana", phone: "(512) 555-0199", email: "dana@example.com", service: "Drain cleaning", message: "Line one\nLine two" },
};

describe("leadEmail", () => {
  it("builds the text and HTML parts, the reply-to and the idempotency key", () => {
    const email = leadEmail(base);
    expect(email).toMatchObject({
      to: "owner@example.com",
      subject: "New request from your website: Dana",
      replyTo: "dana@example.com",
      tag: "lead",
      idempotencyKey: "lead:7c9e6679-7425-40de-944b-e07fc1f90ae7",
    });
    expect(email.text).toBe(
      [
        "You have a new request from your website.",
        "",
        "Name: Dana",
        "Phone: (512) 555-0199",
        "Email: dana@example.com",
        "Service: Drain cleaning",
        "",
        "Message:",
        "Line one\nLine two",
        "",
        "Reply to this email to answer them.",
        "",
        "Sent from the contact form on https://joes.asksite.example/",
      ].join("\n"),
    );
    expect(email.html).toContain("<strong>Message:</strong><br>\nLine one<br>\nLine two</p>");
    expect(email.html).toContain('<a href="https://joes.asksite.example/">https://joes.asksite.example/</a>');
  });

  it("asks for a call back and sets no reply-to when there is no email", () => {
    const email = leadEmail({ ...base, lead: { ...base.lead, email: null, service: null, message: null } });
    expect(email).not.toHaveProperty("replyTo");
    expect(email.text).toContain("They did not leave an email address, so please call them back.");
    expect(email.text).not.toContain("Email:");
    expect(email.text).not.toContain("Message:");
  });

  it("puts visitor values only into escaped text, never into markup, links or attributes", () => {
    const payload = '<img src=x onerror=alert(1)><a href="https://evil.example">x</a>';
    const email = leadEmail({ ...base, lead: { name: payload, phone: "5125550199", email: null, service: payload, message: payload } });
    expect(email.html).not.toContain("<img");
    expect(email.html).not.toContain("evil.example\">");
    expect(email.html.match(/<a /g)).toHaveLength(1);
    expect(email.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("keeps the subject on one line and at most 100 characters", () => {
    const email = leadEmail({ ...base, lead: { ...base.lead, name: `Dana\r\nBcc: victim@example.com ${"x".repeat(200)}` } });
    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(Array.from(email.subject)).toHaveLength(100);
  });

  it("never splits an emoji when cutting the subject", () => {
    const email = leadEmail({ ...base, lead: { ...base.lead, name: "\u{1F527}".repeat(80) } });
    expect(email.subject.endsWith("\u{1F527}")).toBe(true);
  });
});
```

`apps/sites/test/form.workerd.test.ts`:

```ts
import { hashIp, newId } from "@asksite/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { at, seedSite, settledLeads, sitesHarness, TEST_SECRETS, type SeededSite, type ToolsEnv } from "./support/harness.ts";

const harness = sitesHarness();
let tools: ToolsEnv;
beforeAll(async () => {
  ({ tools } = await harness.start());
}, 120_000);
afterAll(async () => {
  await harness.server.close();
});

const GOOD = { name: "Dana Price", phone: "(512) 555-0199", email: "dana@example.com", service: "Drain cleaning", message: "Kitchen sink\r\nis blocked.", website: "" };
let ipCounter = 0;
/** Each call gets its own visitor IP unless one is given, so the per-IP rate limit only bites where a test wants it. */
function post(site: { slug: string; siteId: string }, fields: Record<string, string>, init: { ip?: string; headers?: Record<string, string>; body?: string } = {}) {
  ipCounter += 1;
  return harness.server.fetch(at(site.slug, `/_f/${site.siteId}`), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": init.ip ?? `198.51.100.${ipCounter}`, ...init.headers },
    body: init.body ?? new URLSearchParams(fields).toString(),
  });
}

async function leads(siteId: string) {
  const { results } = await tools.DB.prepare("SELECT * FROM leads WHERE site_id = ? ORDER BY created_at").bind(siteId).all<Record<string, unknown>>();
  return results;
}

async function outboxFor(to: string) {
  const { results } = await tools.DB.prepare("SELECT to_addr, subject, text, tag FROM dev_outbox WHERE to_addr = ? ORDER BY id").bind(to).all<Record<string, string>>();
  return results;
}

describe("POST /_f/<siteId>", () => {
  let site: SeededSite;
  beforeAll(async () => {
    site = await seedSite(tools);
  });

  it("stores the lead, emails the owner's login email and redirects to the thank-you page", async () => {
    const response = await post(site, GOOD, { ip: "203.0.113.7" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/_f/${site.siteId}/sent`);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");

    const [lead] = await settledLeads(tools, site.siteId);
    expect(lead).toMatchObject({
      name: "Dana Price", phone: "(512) 555-0199", email: "dana@example.com", service: "Drain cleaning",
      message: "Kitchen sink\nis blocked.", spam: 0, email_status: "sent", email_error: null,
      ip_hash: await hashIp(TEST_SECRETS.IP_HASH_KEY, "203.0.113.7"),
    });
    expect(JSON.stringify(lead)).not.toContain("203.0.113.7");

    const [email] = await outboxFor(site.ownerEmail);
    expect(email).toMatchObject({ to_addr: site.ownerEmail, subject: "New request from your website: Dana Price", tag: "lead" });
    expect(email?.text).toContain("Phone: (512) 555-0199");
    expect(email?.text).toContain(`Sent from the contact form on https://${site.slug}.localhost:8789/`);
  });

  it("shows the thank-you page", async () => {
    const response = await harness.server.fetch(at(site.slug, `/_f/${site.siteId}/sent`));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(await response.text()).toContain("<h1>Thanks! Your message was sent.</h1>");
  });

  it("drops a bot that filled the honeypot but still thanks it", async () => {
    const quiet = await seedSite(tools);
    const response = await post(quiet, { ...GOOD, website: "https://spam.example" });
    expect(response.status).toBe(303);
    expect(await leads(quiet.siteId)).toEqual([]);
  });

  it("lists problems in plain words without repeating what was typed", async () => {
    const fresh = await seedSite(tools);
    const response = await post(fresh, { name: "", phone: "<script>alert(1)</script>", email: "not-an-email", message: "x".repeat(2001) });
    expect(response.status).toBe(400);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    const body = await response.text();
    expect(body).toContain("<li>Please enter your name (up to 80 characters).</li>");
    expect(body).toContain("<li>Please enter a phone number we can call back, with at least 7 digits.</li>");
    expect(body).toContain("<li>Please check your email address, or leave it empty.</li>");
    expect(body).toContain("<li>Please shorten your message to 2,000 characters or fewer.</li>");
    expect(body).not.toContain("script");
    expect(body).not.toContain("not-an-email");
    expect(body).toContain('href="/#contact"');
    expect(await leads(fresh.siteId)).toEqual([]);
  });

  it("refuses other content types (415) and bodies over 16 KB (413)", async () => {
    expect((await post(site, {}, { headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(415);
    expect((await post(site, {}, { headers: { "content-type": "multipart/form-data; boundary=x" }, body: "x" })).status).toBe(415);
    expect((await post(site, {}, { body: `message=${"a".repeat(17 * 1024)}` })).status).toBe(413);
  });

  it("rate-limits one visitor to 5 posts a minute per site", async () => {
    const busy = await seedSite(tools);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await post(busy, GOOD, { ip: "192.0.2.44" })).status);
    expect(statuses).toEqual([303, 303, 303, 303, 303, 429]);
    const limited = await post(busy, GOOD, { ip: "192.0.2.44" });
    expect(limited.headers.get("retry-after")).toBe("60");
    expect((await post(busy, GOOD, { ip: "192.0.2.45" })).status).toBe(303);
    expect(await leads(busy.siteId)).toHaveLength(6);
  });

  it("rate-limits an IPv6 visitor by the /64 network, not the full address", async () => {
    const busy = await seedSite(tools);
    const statuses: number[] = [];
    for (let i = 1; i <= 6; i++) statuses.push((await post(busy, GOOD, { ip: `2001:db8:4:7::${i}` })).status);
    expect(statuses).toEqual([303, 303, 303, 303, 303, 429]);
    expect((await post(busy, GOOD, { ip: "2001:db8:4:8::1" })).status).toBe(303);
  });

  it("returns 404 for a form that is not this live site's", async () => {
    const other = await seedSite(tools);
    const draft = await seedSite(tools, { live: false });
    const down = await seedSite(tools, { takenDown: true });
    expect((await post({ slug: other.slug, siteId: site.siteId }, GOOD)).status).toBe(404);
    expect((await post(draft, GOOD)).status).toBe(404);
    expect((await post(down, GOOD)).status).toBe(404);
    expect((await post({ slug: site.slug, siteId: newId() }, GOOD)).status).toBe(404);
    expect((await post({ slug: site.slug, siteId: "../../etc" }, GOOD)).status).toBe(404);
    expect(await leads(draft.siteId)).toEqual([]);
  });

  it("never asks D1 about a form for a site with no approved page: with D1's sites table gone it is still 404", async () => {
    await tools.DB.prepare("ALTER TABLE sites RENAME TO sites_offline").run();
    try {
      expect((await post({ slug: "no-such-shop", siteId: newId() }, GOOD)).status).toBe(404);
    } finally {
      await tools.DB.prepare("ALTER TABLE sites_offline RENAME TO sites").run();
    }
  });

  it("answers our 503 page with noindex, never the platform's error page, when D1 fails while storing the lead", async () => {
    const target = await seedSite(tools);
    await tools.DB.prepare("ALTER TABLE leads RENAME TO leads_offline").run();
    try {
      const response = await post(target, GOOD);
      expect(response.status).toBe(503);
      expect(response.headers.get("x-robots-tag")).toBe("noindex");
      expect(await response.text()).toContain("<h1>Temporarily unavailable</h1>");
    } finally {
      await tools.DB.prepare("ALTER TABLE leads_offline RENAME TO leads").run();
    }
    expect(await leads(target.siteId)).toEqual([]);
  });

  it("closes the form for the day after 50 leads, exactly", async () => {
    const popular = await seedSite(tools);
    const now = Date.now();
    await tools.DB.batch(
      Array.from({ length: 50 }, () =>
        tools.DB.prepare("INSERT INTO leads (id, site_id, created_at, name, phone, email_status, ip_hash) VALUES (?, ?, ?, 'n', '5125550100', 'sent', 'h')").bind(newId(), popular.siteId, now),
      ),
    );
    const response = await post(popular, GOOD);
    expect(response.status).toBe(429);
    expect(await response.text()).toContain("<h1>Please call instead</h1>");
    expect(await leads(popular.siteId)).toHaveLength(50);
  });

  it("stores link-heavy messages as spam without emailing the owner", async () => {
    const target = await seedSite(tools);
    const response = await post(target, { ...GOOD, message: "http://a http://b https://c http://d" });
    expect(response.status).toBe(303);
    const [lead] = await leads(target.siteId);
    expect(lead).toMatchObject({ spam: 1, email_status: "skipped" });
    expect(await outboxFor(target.ownerEmail)).toEqual([]);
  });

  it("removes control and invisible characters but keeps the message's line breaks", async () => {
    const target = await seedSite(tools);
    await post(target, { ...GOOD, name: "Da\u202Ena\u0007 P", message: "Line one\r\nLine\u200B two" });
    const [lead] = await leads(target.siteId);
    expect(lead).toMatchObject({ name: "Dana P", message: "Line one\nLine two" });
  });
});

describe("when email fails", () => {
  const broken = sitesHarness({ vars: { MAILER: "resend" } });
  let brokenTools: ToolsEnv;
  beforeAll(async () => {
    ({ tools: brokenTools } = await broken.start());
  }, 120_000);
  afterAll(async () => {
    await broken.server.close();
  });

  it("still saves the lead, marks it failed and thanks the visitor", async () => {
    const site = await seedSite(brokenTools);
    const response = await broken.server.fetch(at(site.slug, `/_f/${site.siteId}`), {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "198.51.100.200" },
      body: new URLSearchParams(GOOD).toString(),
    });
    expect(response.status).toBe(303);
    const [lead] = await settledLeads(brokenTools, site.siteId);
    expect(lead).toMatchObject({ email_status: "failed", email_error: "misconfigured" });
  });
});

describe("without IP_HASH_KEY", () => {
  const keyless = sitesHarness({ secrets: { IP_HASH_KEY: "" } });
  let keylessTools: ToolsEnv;
  beforeAll(async () => {
    ({ tools: keylessTools } = await keyless.start());
  }, 120_000);
  afterAll(async () => {
    await keyless.server.close();
  });

  it("fails closed with 503 and stores nothing (it never stores a raw IP)", async () => {
    const site = await seedSite(keylessTools);
    const response = await keyless.server.fetch(at(site.slug, `/_f/${site.siteId}`), {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(GOOD).toString(),
    });
    expect(response.status).toBe(503);
    expect(await keylessTools.DB.prepare("SELECT COUNT(*) AS n FROM leads").first()).toEqual({ n: 0 });
  });
});
```

`apps/sites/test/resend.workerd.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { at, seedSite, settledLeads, sitesHarness, type ToolsEnv } from "./support/harness.ts";

// The real Resend mailer running inside workerd. The harness sends the Worker's outbound fetch
// through this Node process's global fetch, so the test answers for api.resend.com and fails on
// any other host: nothing ever leaves the machine.
const harness = sitesHarness({ vars: { MAILER: "resend", MAIL_FROM: "asksite <leads@mail.asksite.example>" }, secrets: { RESEND_API_KEY: "re_test_not_a_real_key" } });
let tools: ToolsEnv;
const realFetch = globalThis.fetch;
const outbound: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
let resendStatus = 200;

beforeAll(async () => {
  ({ tools } = await harness.start());
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).host !== "api.resend.com") throw new Error(`Unexpected outbound request to ${request.url}`);
    outbound.push({ url: request.url, headers: Object.fromEntries(request.headers), body: await request.json() });
    return Response.json(resendStatus === 200 ? { id: "email-id-1" } : { message: "limit" }, { status: resendStatus });
  }) as typeof fetch;
}, 120_000);
afterEach(() => {
  outbound.length = 0;
  resendStatus = 200;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  await harness.server.close();
});

const GOOD = { name: "Dana <b>Price</b>", phone: "512 555 0199", email: "dana@example.com", message: "Hi" };
const post = (site: { slug: string; siteId: string }) =>
  harness.server.fetch(at(site.slug, `/_f/${site.siteId}`), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "198.51.100.77" },
    body: new URLSearchParams(GOOD).toString(),
  });

describe("lead email through Resend (inside workerd)", () => {
  it("sends one documented request with an idempotency key and marks the lead sent", async () => {
    const site = await seedSite(tools);
    expect((await post(site)).status).toBe(303);
    const [lead] = await settledLeads(tools, site.siteId);
    expect(lead?.["email_status"]).toBe("sent");
    expect(outbound).toHaveLength(1);
    const [call] = outbound;
    expect(call?.url).toBe("https://api.resend.com/emails");
    expect(call?.headers).toMatchObject({ authorization: "Bearer re_test_not_a_real_key", "idempotency-key": `lead:${String(lead?.["id"])}`, "content-type": "application/json" });
    expect(call?.body).toMatchObject({
      from: "asksite <leads@mail.asksite.example>",
      to: [site.ownerEmail],
      subject: "New request from your website: Dana <b>Price</b>",
      reply_to: "dana@example.com",
    });
    const html = (call?.body as { html: string }).html;
    expect(html).toContain("<strong>Name:</strong> Dana &lt;b&gt;Price&lt;/b&gt;");
    expect(html).not.toContain("<b>Price</b>");
  });

  it("marks the lead failed with the Resend error code when Resend refuses", async () => {
    resendStatus = 429;
    const site = await seedSite(tools);
    expect((await post(site)).status).toBe(303);
    const [lead] = await settledLeads(tools, site.siteId);
    expect(lead).toMatchObject({ email_status: "failed", email_error: "rate_limited" });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run apps/sites/test/lead.test.ts apps/sites/test/lead-email.test.ts apps/sites/test/form.workerd.test.ts apps/sites/test/resend.workerd.test.ts`
Expected: FAIL: `Test Files  4 failed (4)`, `Tests  15 failed | 2 passed (17)`: `Cannot find module '../src/lead.ts'` and `'../src/lead-email.ts'`; the form and Resend tests fail because every form URL is still a 404 (there is no form route yet): mostly `expected 404 to be 303`, and `expected 404 to be` 400, 415, 429 or 503 where a test wants that page. The two that pass are "returns 404 for a form that is not this live site's" and "never asks D1 about a form for a site with no approved page" (every form URL is still a 404; the second fails on code that asks D1 first, and the D1-failure test fails without the `fetch` wrapper: both checked by mutation).

- [ ] **Step 3: Write the implementation**

`apps/sites/src/lead.ts`:

```ts
import { z } from "zod";

// The contact form's fields, exactly as Plan 1 Task 13 names them: name, phone, email, service,
// message, and the honeypot "website". Checked here in plain words; nothing typed is ever echoed.

export interface Lead {
  name: string;
  phone: string;
  email: string | null;
  service: string | null;
  message: string | null;
}

export type LeadProblem = "name" | "phone" | "email" | "service" | "message";

export const PROBLEM_TEXT: Record<LeadProblem, string> = {
  name: "Please enter your name (up to 80 characters).",
  phone: "Please enter a phone number we can call back, with at least 7 digits.",
  email: "Please check your email address, or leave it empty.",
  service: "Please choose a service from the list.",
  message: "Please shorten your message to 2,000 characters or fewer.",
};

// Control characters, and invisible formatting characters (e.g. U+202E, which can make a name
// read backwards in the owner's inbox). U+200D stays so emoji in names survive.
const HIDDEN = /\p{Cc}|(?!\u200D)\p{Cf}/gu;
const HIDDEN_EXCEPT_NEWLINE = /(?!\n)\p{Cc}|(?!\u200D)\p{Cf}/gu;
const PHONE = /^[0-9+().\- ]{7,30}$/;
const Email = z.email().max(254);

/** Removes hidden characters and trims. Messages keep line breaks (CRLF from the browser becomes LF). */
function clean(value: string | null, keepNewlines: boolean): string {
  const text = (value ?? "").replace(/\r\n?/g, "\n");
  return text.replace(keepNewlines ? HIDDEN_EXCEPT_NEWLINE : HIDDEN, "").trim();
}

export function readLead(fields: URLSearchParams): { ok: true; lead: Lead } | { ok: false; problems: LeadProblem[] } {
  const name = clean(fields.get("name"), false);
  const phone = clean(fields.get("phone"), false);
  const email = clean(fields.get("email"), false);
  const service = clean(fields.get("service"), false);
  const message = clean(fields.get("message"), true);

  const problems: LeadProblem[] = [];
  if (name.length < 1 || name.length > 80) problems.push("name");
  if (!PHONE.test(phone) || (phone.match(/\d/g) ?? []).length < 7) problems.push("phone");
  if (email !== "" && !Email.safeParse(email).success) problems.push("email");
  if (service.length > 60) problems.push("service");
  if (message.length > 2000) problems.push("message");
  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    lead: { name, phone, email: email || null, service: service || null, message: message || null },
  };
}

/** More than 3 "http" in the message: stored as spam, not emailed. */
export const looksLikeSpam = (lead: Lead): boolean => ((lead.message ?? "").match(/http/gi) ?? []).length > 3;
```

`apps/sites/src/lead-email.ts`:

```ts
import type { OutgoingEmail } from "@asksite/mailer";
import { escapeAttr, escapeText } from "@asksite/renderer";
import type { Lead } from "./lead.ts";

// The lead email (design §7.5). Visitor values only ever become text: escaped text nodes in the
// HTML part, plain lines in the text part. The only link is the site's own address, built from
// its slug. No tracking pixels. Replying goes to the visitor through Reply-To.

const SUBJECT_MAX = 100;

function subjectFor(name: string): string {
  const subject = `New request from your website: ${name}`.replace(/\p{Cc}/gu, "");
  return Array.from(subject).slice(0, SUBJECT_MAX).join("");
}

export function leadEmail(input: { to: string; leadId: string; lead: Lead; siteUrl: string }): OutgoingEmail {
  const { lead, siteUrl } = input;
  const rows: Array<[string, string | null]> = [
    ["Name", lead.name],
    ["Phone", lead.phone],
    ["Email", lead.email],
    ["Service", lead.service],
  ];
  const shown = rows.filter((row): row is [string, string] => row[1] !== null);
  const next = lead.email === null ? "They did not leave an email address, so please call them back." : "Reply to this email to answer them.";

  const text = [
    "You have a new request from your website.",
    "",
    ...shown.map(([label, value]) => `${label}: ${value}`),
    ...(lead.message === null ? [] : ["", "Message:", lead.message]),
    "",
    next,
    "",
    `Sent from the contact form on ${siteUrl}`,
  ].join("\n");

  const html = [
    "<!DOCTYPE html>",
    '<html lang="en"><body style="font-family:system-ui,sans-serif;font-size:16px;line-height:1.5;color:#1f2937">',
    "<p>You have a new request from your website.</p>",
    "<p>",
    shown.map(([label, value]) => `<strong>${label}:</strong> ${escapeText(value)}`).join("<br>\n"),
    "</p>",
    lead.message === null ? "" : `<p><strong>Message:</strong><br>\n${escapeText(lead.message).replaceAll("\n", "<br>\n")}</p>`,
    `<p>${next}</p>`,
    `<p style="color:#4b5563">Sent from the contact form on <a href="${escapeAttr(siteUrl)}">${escapeText(siteUrl)}</a></p>`,
    "</body></html>",
  ].join("\n");

  return {
    to: input.to,
    subject: subjectFor(lead.name),
    text,
    html,
    ...(lead.email === null ? {} : { replyTo: lead.email }),
    tag: "lead",
    idempotencyKey: `lead:${input.leadId}`,
  };
}
```

`apps/sites/src/form.ts`:

```ts
import { hashIp, ipRateKey, isId, LIMITS, liveKey, newId, siteUrl, utcDayStart } from "@asksite/core";
import { createMailer, MailerError } from "@asksite/mailer";
import type { Env } from "./env.ts";
import { plainHeaders } from "./headers.ts";
import { leadEmail } from "./lead-email.ts";
import { looksLikeSpam, PROBLEM_TEXT, readLead, type Lead } from "./lead.ts";
import { logLine } from "./log.ts";
import { formProblems, notFound, siteBusy, tooManyRequests, unavailable, unreadableForm } from "./pages.ts";

const MAX_BODY_BYTES = 16 * 1024;

/** Reads at most `max` bytes, counting as it reads, so a missing or false Content-Length cannot get past it. */
async function readLimited(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > max) return null;
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

const seeOther = (location: string) => new Response(null, { status: 303, headers: plainHeaders({ Location: location }) });

interface SiteForForm { slug: string | null; live_version_id: string | null; taken_down_at: number | null; email: string }

/** POST /_f/<siteId> on a site host (design §7.5). */
export async function handleForm(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  hostSlug: string,
  siteId: string,
  now: number,
): Promise<{ response: Response; code?: string }> {
  const root = env.ROOT_DOMAIN;
  if (!isId(siteId)) return { response: notFound(root) };

  const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return { response: unreadableForm(root, 415), code: "unsupported_media_type" };
  const body = await readLimited(request, MAX_BODY_BYTES);
  if (body === null) return { response: unreadableForm(root, 413), code: "payload_too_large" };

  const key = env.IP_HASH_KEY ?? "";
  if (key === "") return { response: unavailable(root), code: "misconfigured" };
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const ipHash = await hashIp(key, ip); // stored with the lead
  // Keyed on the IPv6 /64 (an IPv4 address whole), so a visitor cannot dodge the limit by changing
  // the low bits of their address (Decision 27).
  const { success } = await env.FORM_RL.limit({ key: `${siteId}:${await hashIp(key, ipRateKey(ip))}` });
  if (!success) return { response: tooManyRequests(root), code: "rate_limited" };

  const fields = new URLSearchParams(body);
  const sent = `/_f/${siteId}/sent`;
  if ((fields.get("website") ?? "") !== "") return { response: seeOther(sent), code: "honeypot" };

  const read = readLead(fields);
  if (!read.ok) return { response: formProblems(root, read.problems.map((p) => PROBLEM_TEXT[p])), code: "validation_failed" };

  // R2 first: a form for a site with no approved page never reaches D1 (Decision 24).
  const page = await env.LIVE.head(liveKey(hostSlug));
  if (page === null || page.customMetadata?.["siteId"] !== siteId) return { response: notFound(root) };

  const site = await env.DB.prepare(
    "SELECT s.slug, s.live_version_id, s.taken_down_at, o.email FROM sites s JOIN owners o ON o.id = s.owner_id WHERE s.id = ?",
  ).bind(siteId).first<SiteForForm>();
  if (site === null || site.slug !== hostSlug || site.live_version_id === null || site.taken_down_at !== null) {
    return { response: notFound(root) };
  }

  const leadId = newId();
  const spam = looksLikeSpam(read.lead);
  const stored = await insertLead(env.DB, { leadId, siteId, now, lead: read.lead, spam, ipHash });
  if (!stored) return { response: siteBusy(root), code: "site_daily_cap" };
  if (spam) return { response: seeOther(sent), code: "spam" };

  // The lead is saved: thank the visitor now and email the owner after the response (Decision 26).
  ctx.waitUntil(emailOwner(env, { leadId, siteId, to: site.email, lead: read.lead, siteUrl: siteUrl(root, site.slug) }));
  return { response: seeOther(sent) };
}

/** Inserts the lead unless the site already has LIMITS.leadsPerSitePerDay today: one statement, so the cap is exact. */
async function insertLead(db: D1Database, input: { leadId: string; siteId: string; now: number; lead: Lead; spam: boolean; ipHash: string }): Promise<boolean> {
  const { leadId, siteId, now, lead, spam, ipHash } = input;
  const result = await db
    .prepare(
      `INSERT INTO leads (id, site_id, created_at, name, phone, email, service, message, spam, email_status, ip_hash)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM leads WHERE site_id = ? AND created_at >= ?) < ?`,
    )
    .bind(leadId, siteId, now, lead.name, lead.phone, lead.email, lead.service, lead.message, spam ? 1 : 0, spam ? "skipped" : "pending", ipHash,
      siteId, utcDayStart(now), LIMITS.leadsPerSitePerDay)
    .run();
  return result.meta.changes === 1;
}

/**
 * Runs after the 303 (ctx.waitUntil): sends the lead email to the owner's verified login email and
 * records the outcome. The lead is already saved; nothing here can reject, so nothing here can change
 * what the visitor saw. Logs one line with the outcome (codes only).
 */
async function emailOwner(env: Env, input: { leadId: string; siteId: string; to: string; lead: Lead; siteUrl: string }): Promise<void> {
  const started = Date.now();
  let error: string | null = null;
  try {
    await createMailer(env).send(leadEmail(input));
  } catch (e) {
    error = e instanceof MailerError ? e.code : "internal";
  }
  let code = error === null ? undefined : `email_${error}`;
  try {
    await env.DB.prepare("UPDATE leads SET email_status = ?, email_error = ? WHERE id = ?").bind(error === null ? "sent" : "failed", error, input.leadId).run();
  } catch {
    code = "email_status_not_saved"; // the lead stays 'pending'; the owner still sees it in the app
  }
  logLine({ route: "form_email", ms: Date.now() - started, siteId: input.siteId, ...(code === undefined ? {} : { code }) });
}
```

`apps/sites/src/router.ts` (full new content, final):

```ts
import { isId, parseHost } from "@asksite/core";
import { securityTxt } from "./apex.ts";
import type { Env } from "./env.ts";
import { handleForm } from "./form.ts";
import { plainHeaders } from "./headers.ts";
import { serveMedia } from "./media.ts";
import { servePage } from "./page.ts";
import { apexPlaceholder, notFound, thankYou } from "./pages.ts";

export interface Routed {
  route: string;
  response: Response;
  siteId?: string;
  code?: string;
}

const FORM = /^\/_f\/([^/]+)$/;
const SENT = /^\/_f\/([^/]+)\/sent$/;

/** Routes by the Host header (design §4.6). Anything not listed is a 404 page. */
export async function route(request: Request, env: Env, ctx: ExecutionContext, now: number): Promise<Routed> {
  const url = new URL(request.url);
  const path = url.pathname;
  const root = env.ROOT_DOMAIN;
  const read = request.method === "GET" || request.method === "HEAD";
  const host = parseHost(url.host, root);

  switch (host.kind) {
    case "www":
      return { route: "www", response: new Response(null, { status: 301, headers: plainHeaders({ Location: `https://${root}/` }) }) };
    case "apex":
      if (read && path === "/") return { route: "apex", response: apexPlaceholder(root) };
      if (read && path === "/.well-known/security.txt") return { route: "security_txt", response: securityTxt(env) };
      break;
    case "media":
      if (read) return { route: "media", response: await serveMedia(env, ctx, path) };
      break;
    case "site": {
      if (read && path === "/") return { route: "page", response: await servePage(env, ctx, host.slug) };
      const form = FORM.exec(path);
      if (form !== null && request.method === "POST") {
        const siteId = form[1] ?? "";
        const { response, code } = await handleForm(request, env, ctx, host.slug, siteId, now);
        return { route: "form", response, ...(isId(siteId) ? { siteId } : {}), ...(code === undefined ? {} : { code }) };
      }
      const sent = SENT.exec(path);
      if (sent !== null && read && isId(sent[1] ?? "")) return { route: "form_sent", response: thankYou(root) };
      break;
    }
    case "unknown":
      break;
  }
  return { route: "not_found", response: notFound(root) };
}
```

`apps/sites/src/index.ts` (full new content; Task 14 adds the cron handler):

```ts
// asksite-sites: public site pages, photos and contact forms on customer hostnames.
// A Worker's main module may export only handlers (workerd refuses other named exports).
import type { Env } from "./env.ts";
import { logLine } from "./log.ts";
import { unavailable } from "./pages.ts";
import { route, type Routed } from "./router.ts";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const started = Date.now();
    let routed: Routed;
    try {
      routed = await route(request, env, ctx, started);
    } catch {
      // Anything unexpected (D1 or R2 failing outside a guarded read, a broken request body) gets our
      // 503 page with noindex and Retry-After, never the platform's error page (design §7.4; Decision 26).
      routed = { route: "error", response: unavailable(env.ROOT_DOMAIN), code: "internal" };
    }
    const { route: name, response, siteId, code } = routed;
    logLine({ route: name, status: response.status, ms: Date.now() - started, ...(siteId === undefined ? {} : { siteId }), ...(code === undefined ? {} : { code }) });
    return request.method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 4: Run the sites tests and the typecheck**

Run: `pnpm vitest run apps/sites && pnpm typecheck`
Expected: `Test Files  9 passed (9)`, `Tests  85 passed (85)`; typecheck exits 0. `resend.workerd.test.ts` proves the real Resend mailer runs inside workerd: exactly one request to `api.resend.com` with the key, the idempotency key `lead:<leadId>`, the owner as `to`, the visitor as `reply_to`, and the visitor's name escaped in the HTML; any other outbound host would throw.

- [ ] **Step 5: Commit**

```bash
git add apps/sites/src/lead.ts apps/sites/src/lead-email.ts apps/sites/src/form.ts apps/sites/src/router.ts apps/sites/src/index.ts apps/sites/test/lead.test.ts apps/sites/test/lead-email.test.ts apps/sites/test/form.workerd.test.ts apps/sites/test/resend.workerd.test.ts
git commit -m "Add contact form"
```

---
### Task 14: Lead retention cron, and the whole pipeline end to end

**Files:**
- Create: `apps/sites/src/cron.ts`
- Modify: `apps/sites/src/index.ts` (+ `scheduled`), `apps/sites/wrangler.jsonc` (+ `triggers`), `apps/sites/test/config.test.ts` (+ the cron assertion)
- Test: `apps/sites/test/pipeline.workerd.test.ts`

**Interfaces:**
- Consumes: `LIMITS.leadRetentionDays` (Task 4); `createPendingVersion`, `approveVersion`, `takeDown`, `restore` (Tasks 8–10); the harness's `getWorker(name).scheduled({ cron, scheduledTime })` [verified: returns `{ outcome: "ok" }`].
- Produces: `deleteOldLeads(db, now): Promise<number>`; the Worker's `scheduled` handler on `"0 7 * * *"` deletes leads older than 180 days (design §7.3 item 5) and logs one line with the count.
- The pipeline test publishes a Plan 1 fixture as the app Worker will, approves it as the admin Worker will, fetches it from `asksite-sites` (the exact WORK bytes), submits the page's own form action, and shows a takedown stops a page no data centre has cached and a restore brings it back.

- [ ] **Step 1: Write the failing tests**

`apps/sites/test/pipeline.workerd.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EMPTY_EDITS, versionKey } from "@asksite/core";
import { approveVersion, createPendingVersion, restore, takeDown } from "@asksite/publishing";
import { SiteDocument } from "@asksite/site-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { at, ROOT, seedSite, settledLeads, sitesHarness, type ToolsEnv } from "./support/harness.ts";

// Plan 2 end to end: publish (as the app Worker will), approve (as the admin Worker will), then the
// public Worker serves those exact bytes and accepts the page's own contact form.
const harness = sitesHarness();
let tools: ToolsEnv;
beforeAll(async () => {
  ({ tools } = await harness.start());
}, 120_000);
afterAll(async () => {
  await harness.server.close();
});

const fixture = (name: string) =>
  SiteDocument.parse(JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../fixtures", `${name}.json`), "utf8")));

async function publishAndApprove(fixtureName: string) {
  const site = await seedSite(tools, { live: false });
  const env = { ...tools, ROOT_DOMAIN: ROOT };
  const version = await createPendingVersion(env, { siteId: site.siteId, ownerId: site.ownerId, slug: site.slug, document: fixture(fixtureName), edits: EMPTY_EDITS, generationId: null, now: Date.now() });
  const sha = await tools.DB.prepare("SELECT html_sha256 FROM site_versions WHERE id = ?").bind(version.id).first<{ html_sha256: string }>();
  await approveVersion(env, { versionId: version.id, htmlSha256: String(sha?.html_sha256), reviewer: "admin@example.com", note: null, indexable: true, now: Date.now() });
  return { ...site, versionId: version.id };
}

describe("publish, approve, serve, contact", () => {
  it("serves exactly the approved bytes and accepts the page's own form", async () => {
    const site = await publishAndApprove("plumber-austin");
    const page = await harness.server.fetch(at(site.slug));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toBe(await (await tools.WORK.get(versionKey(site.siteId, site.versionId)))?.text());

    const action = /<form action="([^"]+)" method="post">/.exec(html)?.[1];
    expect(action).toBe(`https://${site.slug}.${ROOT}/_f/${site.siteId}`);
    const response = await harness.server.fetch(String(action), {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "198.51.100.99" },
      body: new URLSearchParams({ name: "Pat", phone: "512-555-0123", email: "", service: "Drain cleaning", message: "", website: "" }).toString(),
    });
    expect(response.status).toBe(303);
    const [lead] = await settledLeads(tools, site.siteId);
    expect(lead).toMatchObject({ name: "Pat", service: "Drain cleaning", email_status: "sent" });
  });

  it("a takedown stops a page that no data centre has cached; restore brings it back", async () => {
    const site = await publishAndApprove("cleaning-minimal");
    await takeDown(tools, { siteId: site.siteId, reviewer: "admin@example.com", reason: "Test", purgeMedia: false, now: Date.now() });
    expect((await harness.server.fetch(at(site.slug))).status).toBe(404);
    await restore({ ...tools, ROOT_DOMAIN: ROOT }, { siteId: site.siteId, reviewer: "admin@example.com", now: Date.now() });
    expect((await harness.server.fetch(at(site.slug))).status).toBe(200);
  });
});

describe("daily cron", () => {
  it("deletes leads older than 180 days and keeps newer ones", async () => {
    const site = await seedSite(tools);
    const now = Date.parse("2026-09-24T07:00:00.000Z");
    const day = 86_400_000;
    const insert = (id: string, createdAt: number) =>
      tools.DB.prepare("INSERT INTO leads (id, site_id, created_at, name, phone, email_status, ip_hash) VALUES (?, ?, ?, 'n', 'p', 'sent', 'h')").bind(id, site.siteId, createdAt);
    await tools.DB.batch([
      insert("aaaaaaaa-0000-4000-8000-000000000001", now - 181 * day),
      insert("aaaaaaaa-0000-4000-8000-000000000002", now - 180 * day),
      insert("aaaaaaaa-0000-4000-8000-000000000003", now - 1 * day),
    ]);
    const result = await harness.server.getWorker("asksite-sites").scheduled({ cron: "0 7 * * *", scheduledTime: new Date(now) });
    expect(result.outcome).toBe("ok");
    const { results } = await tools.DB.prepare("SELECT id FROM leads WHERE site_id = ? ORDER BY created_at").bind(site.siteId).all<{ id: string }>();
    expect(results.map((r) => r.id)).toEqual(["aaaaaaaa-0000-4000-8000-000000000002", "aaaaaaaa-0000-4000-8000-000000000003"]);
  });
});
```

`apps/sites/test/config.test.ts` (full new content; adds the `triggers` assertion):

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.ts";

// The production configuration must be safe as committed (design §9.1 "Unsafe production
// configuration"). wrangler.jsonc is kept as plain JSON so tests and `pnpm dev` can JSON.parse it.
const dir = resolve(import.meta.dirname, "..");
const config = JSON.parse(readFileSync(resolve(dir, "wrangler.jsonc"), "utf8"));
const vars: Record<string, string> = config.vars;
const SECRETS = ["RESEND_API_KEY", "IP_HASH_KEY"];

// Every key of Env, checked at compile time by Record<keyof Env, true>.
const ENV_KEYS: Record<keyof Env, true> = {
  DB: true, LIVE: true, MEDIA: true, FORM_RL: true, ENVIRONMENT: true, ROOT_DOMAIN: true, MAILER: true,
  MAIL_FROM: true, SECURITY_TXT_EXPIRES: true, RESEND_API_KEY: true, IP_HASH_KEY: true,
};

describe("apps/sites/wrangler.jsonc (production)", () => {
  it("is the production configuration", () => {
    expect(config.name).toBe("asksite-sites");
    expect(vars["ENVIRONMENT"]).toBe("production");
    expect(vars["MAILER"]).toBe("resend");
    expect(config.compatibility_date).toBe("2026-09-21");
    expect(config.compatibility_flags ?? []).toEqual([]);
  });

  it("is reachable only through its routes, and keeps invocation logs off", () => {
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.observability).toEqual({ enabled: true, logs: { invocation_logs: false } });
    const root = vars["ROOT_DOMAIN"];
    expect(config.routes.map((r: { pattern: string }) => r.pattern)).toEqual([`*.${root}/*`, `${root}/*`]);
    for (const r of config.routes) expect(r.zone_name).toBe(root);
  });

  it("has read-only access to LIVE and MEDIA and no binding to unapproved pages", () => {
    expect(config.r2_buckets).toEqual([
      { binding: "LIVE", bucket_name: "asksite-live" },
      { binding: "MEDIA", bucket_name: "asksite-media" },
    ]);
    expect(JSON.stringify(config)).not.toContain("asksite-work");
    expect(config.d1_databases).toEqual([
      { binding: "DB", database_name: "asksite", database_id: expect.any(String), migrations_dir: "../../packages/core/migrations" },
    ]);
    expect(config.ratelimits).toEqual([{ name: "FORM_RL", namespace_id: "1004", simple: { limit: 5, period: 60 } }]);
    expect(config.triggers).toEqual({ crons: ["0 7 * * *"] });
  });

  it("keeps secrets out of vars", () => {
    for (const name of Object.keys(vars)) expect(name).not.toMatch(/KEY|SECRET|TOKEN|PASSWORD/i);
    for (const secret of SECRETS) expect(vars).not.toHaveProperty(secret);
  });

  it("names exactly the bindings, variables and secrets the Env type declares", () => {
    const fromConfig = [
      ...config.d1_databases.map((d: { binding: string }) => d.binding),
      ...config.r2_buckets.map((b: { binding: string }) => b.binding),
      ...config.ratelimits.map((r: { name: string }) => r.name),
      ...Object.keys(vars),
      ...SECRETS,
    ].sort();
    expect(fromConfig).toEqual(Object.keys(ENV_KEYS).sort());
  });

  it("has a valid security.txt expiry date", () => {
    expect(Number.isNaN(Date.parse(vars["SECURITY_TXT_EXPIRES"] ?? ""))).toBe(false);
  });
});

describe("apps/sites/.dev.vars.example", () => {
  const lines = readFileSync(resolve(dir, ".dev.vars.example"), "utf8").split("\n").filter((l) => l !== "" && !l.startsWith("#"));
  const entries = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

  it("switches everything to local development", () => {
    expect(entries).toMatchObject({ ENVIRONMENT: "development", ROOT_DOMAIN: "localhost:8789", MAILER: "log" });
  });

  it("lists every secret by name and holds no real key", () => {
    for (const secret of SECRETS) expect(entries).toHaveProperty(secret);
    expect(entries["RESEND_API_KEY"]).toBe("");
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run apps/sites/test/pipeline.workerd.test.ts apps/sites/test/config.test.ts`
Expected: FAIL: `Tests  2 failed | 9 passed (11)`: `expected undefined to deeply equal { crons: [ '0 7 * * *' ] }` and `expected 'exception' to be 'ok'` (no scheduled handler). The pipeline's publish-to-serve tests already pass: Tasks 8–13 fit together.

- [ ] **Step 3: Write the implementation**

`apps/sites/src/cron.ts`:

```ts
import { LIMITS } from "@asksite/core";

/** Daily cleanup: deletes leads older than LIMITS.leadRetentionDays. Returns how many were deleted. */
export async function deleteOldLeads(db: D1Database, now: number): Promise<number> {
  const cutoff = now - LIMITS.leadRetentionDays * 86_400_000;
  const result = await db.prepare("DELETE FROM leads WHERE created_at < ?").bind(cutoff).run();
  return result.meta.changes;
}
```

`apps/sites/src/index.ts` (full new content, final):

```ts
// asksite-sites: public site pages, photos and contact forms on customer hostnames.
// A Worker's main module may export only handlers (workerd refuses other named exports).
import { deleteOldLeads } from "./cron.ts";
import type { Env } from "./env.ts";
import { logLine } from "./log.ts";
import { unavailable } from "./pages.ts";
import { route, type Routed } from "./router.ts";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const started = Date.now();
    let routed: Routed;
    try {
      routed = await route(request, env, ctx, started);
    } catch {
      // Anything unexpected (D1 or R2 failing outside a guarded read, a broken request body) gets our
      // 503 page with noindex and Retry-After, never the platform's error page (design §7.4; Decision 26).
      routed = { route: "error", response: unavailable(env.ROOT_DOMAIN), code: "internal" };
    }
    const { route: name, response, siteId, code } = routed;
    logLine({ route: name, status: response.status, ms: Date.now() - started, ...(siteId === undefined ? {} : { siteId }), ...(code === undefined ? {} : { code }) });
    return request.method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
  },

  async scheduled(controller, env): Promise<void> {
    const started = Date.now();
    const deleted = await deleteOldLeads(env.DB, controller.scheduledTime);
    logLine({ route: "cron_lead_retention", ms: Date.now() - started, deleted });
  },
} satisfies ExportedHandler<Env>;
```

`apps/sites/wrangler.jsonc` (full new content, final):

```jsonc
{
  "$schema": "../../node_modules/wrangler/config-schema.json",
  "name": "asksite-sites",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-21",
  "workers_dev": false,
  "preview_urls": false,
  "observability": { "enabled": true, "logs": { "invocation_logs": false } },
  "routes": [
    { "pattern": "*.asksite.example/*", "zone_name": "asksite.example" },
    { "pattern": "asksite.example/*", "zone_name": "asksite.example" }
  ],
  "vars": {
    "ENVIRONMENT": "production",
    "ROOT_DOMAIN": "asksite.example",
    "MAILER": "resend",
    "MAIL_FROM": "asksite <leads@mail.asksite.example>",
    "SECURITY_TXT_EXPIRES": "2027-09-24T00:00:00.000Z"
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "asksite",
      "database_id": "00000000-0000-0000-0000-000000000000",
      "migrations_dir": "../../packages/core/migrations"
    }
  ],
  "r2_buckets": [
    { "binding": "LIVE", "bucket_name": "asksite-live" },
    { "binding": "MEDIA", "bucket_name": "asksite-media" }
  ],
  "ratelimits": [{ "name": "FORM_RL", "namespace_id": "1004", "simple": { "limit": 5, "period": 60 } }],
  "triggers": { "crons": ["0 7 * * *"] }
}
```

- [ ] **Step 4: Run the sites tests, the typecheck and the whole suite**

Run: `pnpm vitest run apps/sites && pnpm typecheck && pnpm test`
Expected: `Test Files  10 passed (10)`, `Tests  88 passed (88)`; typecheck exits 0; the full suite: the `unit` run `Test Files  P+14 passed`, `Tests  T+169 passed`, then the `workerd` run `Test Files  11 passed (11)`, `Tests  96 passed (96)` (planning replay: 37 / 724, then 11 / 96). Then the leftover check (Global Constraints) prints `nothing left running`.

- [ ] **Step 5: Commit**

```bash
git add apps/sites/src/cron.ts apps/sites/src/index.ts apps/sites/wrangler.jsonc apps/sites/test/pipeline.workerd.test.ts apps/sites/test/config.test.ts
git commit -m "Add lead retention"
```

---
### Task 15: `pnpm dev` and `pnpm dev:seed`

**Files:**
- Create: `scripts/dev.ts`, `apps/sites/dev/seed.ts`
- Modify: `package.json` (scripts `dev`, `dev:seed`, by `npm pkg set`), `.gitignore` (+ generated `apps/*/wrangler.*.jsonc`, appended)
- Test: `scripts/dev.test.ts`, `apps/sites/test/seed.test.ts`

**Interfaces:**
- Consumes: every `apps/<name>/wrangler.jsonc` and `.dev.vars.example` (Task 11 for sites; Plans 3 and 4 add theirs); `createPendingVersion`, `approveVersion` (Tasks 8–9); `getPlatformProxy` from `wrangler` with `persist: { path: "<persist-to>/v3" }` [verified: shares state with `wrangler dev --persist-to <persist-to>`], or with every binding marked `"remote": true` for `--remote` [verified: the binding field and `getPlatformProxy`'s `remoteBindings` option (default `true`) in wrangler 4.138.0's type definitions; D1 and R2 support remote mode per developers.cloudflare.com/workers/development-testing/; a real remote run is unverified until Task 19].
- Produces: `pnpm dev [--only <names>] [--persist-to <dir>]` (design §10.1, conventions under "Interfaces this plan provides"); exported helpers `DEV_WORKERS`, `devConfig`, `devArgs`, `ensureDevVars`, `writeDevConfig`, `parseOptions`. `pnpm dev:seed [--slug demo] [--fixture plumber-austin] [--persist-to .wrangler/state] [--root localhost:8789] [--owner-email <email>] [--hero-photo] [--noindex] [--remote]` publishes and approves a Plan 1 fixture through the real publishing functions, with its photos stored in `MEDIA` (a 16x9 grey WebP each) and served from `https://media.<root>`; `--hero-photo` adds one photo to a fixture that has none, `--noindex` approves with search engines off, and `--remote` writes to the production D1 and R2 (Task 19's smoke test, Decision 32). Exports `seedDemoSite`, `parseSeedOptions`, `toolsConfig`, `DEMO_WEBP`, `type SeedOptions`, `type ToolsEnv`. The e2e tests (Task 16) use both.
- Every `wrangler dev` child shares `dev.ts`'s process group, so Ctrl+C, a SIGTERM to `dev.ts`, or Playwright's group signal stops `wrangler` and `workerd` too (Decision 20).

- [ ] **Step 1: Write the failing tests**

`scripts/dev.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEV_WORKERS, devArgs, devConfig, ensureDevVars, parseOptions, writeDevConfig } from "./dev.ts";

const made: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "asksite-dev-"));
  made.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe("pnpm dev helpers", () => {
  it("uses the design's local ports, https for all but the generator, and distinct inspector ports", () => {
    expect(DEV_WORKERS.map((w) => [w.name, w.port, w.https])).toEqual([
      ["sites", 8789, true], ["app", 8787, true], ["admin", 8788, true], ["generator", 8790, false],
    ]);
    expect(new Set(DEV_WORKERS.map((w) => w.inspectorPort)).size).toBe(4);
  });

  it("drops only the routes from the production config", () => {
    const config = { name: "asksite-sites", routes: [{ pattern: "*.asksite.example/*" }], vars: { A: "1" }, workers_dev: false };
    expect(devConfig(config)).toEqual({ name: "asksite-sites", vars: { A: "1" }, workers_dev: false });
  });

  it("writes wrangler.dev.jsonc next to the real config", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "wrangler.jsonc"), JSON.stringify({ name: "w", main: "src/index.ts", routes: [{ pattern: "x/*" }] }));
    const file = writeDevConfig(dir);
    expect(file).toBe(join(dir, "wrangler.dev.jsonc"));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ name: "w", main: "src/index.ts" });
  });

  it("builds the wrangler dev arguments", () => {
    const [sites, , , generator] = DEV_WORKERS;
    expect(devArgs(sites!, "apps/sites/wrangler.dev.jsonc", ".wrangler/state")).toEqual([
      "dev", "--config", "apps/sites/wrangler.dev.jsonc", "--port", "8789", "--inspector-port", "9239",
      "--persist-to", ".wrangler/state", "--show-interactive-dev-session=false", "--local-protocol", "https",
    ]);
    expect(devArgs(generator!, "g.jsonc", "s")).not.toContain("--local-protocol");
  });

  it("creates .dev.vars from the example only when it is missing", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".dev.vars.example"), "MAILER=log\n");
    expect(ensureDevVars(dir)).toBe(true);
    expect(readFileSync(join(dir, ".dev.vars"), "utf8")).toBe("MAILER=log\n");
    writeFileSync(join(dir, ".dev.vars"), "MAILER=resend\n");
    expect(ensureDevVars(dir)).toBe(false);
    expect(readFileSync(join(dir, ".dev.vars"), "utf8")).toBe("MAILER=resend\n");
  });

  it("parses --only and --persist-to and rejects anything else", () => {
    expect(parseOptions([])).toEqual({ only: null, persistTo: ".wrangler/state" });
    expect(parseOptions(["--only", "sites,app", "--persist-to", "x"])).toEqual({ only: ["sites", "app"], persistTo: "x" });
    expect(() => parseOptions(["--fast"])).toThrow("Unknown option --fast");
  });
});
```

`apps/sites/test/seed.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseSeedOptions, toolsConfig } from "../dev/seed.ts";

describe("pnpm dev:seed options", () => {
  it("defaults to the local demo site", () => {
    expect(parseSeedOptions([])).toEqual({
      slug: "demo", fixture: "plumber-austin", persistTo: ".wrangler/state", root: "localhost:8789",
      ownerEmail: null, heroPhoto: false, indexable: true, remote: false,
    });
  });

  it("reads the deploy smoke test's options", () => {
    const argv = ["--remote", "--root", "example.com", "--slug", "smoke-test", "--fixture", "cleaning-minimal", "--hero-photo", "--noindex", "--owner-email", "me@example.com"];
    expect(parseSeedOptions(argv)).toEqual({
      slug: "smoke-test", fixture: "cleaning-minimal", persistTo: ".wrangler/state", root: "example.com",
      ownerEmail: "me@example.com", heroPhoto: true, indexable: false, remote: true,
    });
  });

  it("rejects unknown options, missing values and odd fixture names", () => {
    expect(() => parseSeedOptions(["--fast"])).toThrow("Unknown option --fast");
    expect(() => parseSeedOptions(["--slug"])).toThrow("--slug needs a value");
    expect(() => parseSeedOptions(["--fixture", "../etc"])).toThrow("Unknown fixture ../etc");
  });
});

describe("toolsConfig", () => {
  const sites = {
    compatibility_date: "2026-09-21",
    d1_databases: [{ binding: "DB", database_name: "asksite", database_id: "x" }],
    r2_buckets: [{ binding: "LIVE", bucket_name: "asksite-live" }],
  };

  it("adds WORK next to the sites Worker's own bindings", () => {
    expect(toolsConfig(sites, false)).toEqual({
      name: "asksite-dev-tools",
      compatibility_date: "2026-09-21",
      d1_databases: sites.d1_databases,
      r2_buckets: [...sites.r2_buckets, { binding: "WORK", bucket_name: "asksite-work" }],
    });
  });

  it("marks every binding remote for the production smoke test, and only then", () => {
    const remote = toolsConfig(sites, true) as { d1_databases: Array<{ remote?: boolean }>; r2_buckets: Array<{ remote?: boolean }> };
    expect([...remote.d1_databases, ...remote.r2_buckets].map((b) => b.remote)).toEqual([true, true, true]);
    expect(JSON.stringify(toolsConfig(sites, false))).not.toContain("remote");
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run scripts/dev.test.ts apps/sites/test/seed.test.ts`
Expected: FAIL: `Test Files  2 failed (2)` with `Error: Cannot find module './dev.ts'` and `Error: Cannot find module '../dev/seed.ts'`.

- [ ] **Step 3: Write the implementation**

`scripts/dev.ts`:

```ts
// pnpm dev: builds the shared stylesheet, applies D1 migrations to the local state and starts every
// Worker that exists under apps/ with `wrangler dev` over https (design §10.1). All Workers share one
// local state folder, so D1, R2 and the queue are shared exactly as in production.
//
// Usage: pnpm dev                       (every Worker present)
//        pnpm dev --only sites          (a subset, by folder name)
//        pnpm dev --persist-to <dir>    (another local state folder; default .wrangler/state)
//
// Conventions for every Worker folder apps/<name>/:
// - wrangler.jsonc is plain JSON (no comments) and holds the PRODUCTION values;
// - .dev.vars.example holds the development values; it is copied to .dev.vars when that is missing;
// - a "build" script in its package.json, if any, runs first (e.g. a Vite client build);
// - `wrangler dev` rewrites every request's Host to the first route's zone when routes are present,
//   which breaks Host routing locally (verified with wrangler 4.138.0), so it runs a generated
//   apps/<name>/wrangler.dev.jsonc (gitignored): the same config without "routes".
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface DevWorker {
  name: string;
  port: number;
  inspectorPort: number;
  https: boolean;
}

export const DEV_WORKERS: readonly DevWorker[] = [
  { name: "sites", port: 8789, inspectorPort: 9239, https: true },
  { name: "app", port: 8787, inspectorPort: 9237, https: true },
  { name: "admin", port: 8788, inspectorPort: 9238, https: true },
  { name: "generator", port: 8790, inspectorPort: 9240, https: false },
];

const REPO = resolve(import.meta.dirname, "..");
const WRANGLER = join(REPO, "node_modules", ".bin", "wrangler");

/** The production config without "routes": the only difference between production and `pnpm dev`. */
export function devConfig(config: Record<string, unknown>): Record<string, unknown> {
  const { routes: _routes, ...rest } = config;
  return rest;
}

export function devArgs(worker: DevWorker, configFile: string, persistTo: string): string[] {
  return [
    "dev",
    "--config", configFile,
    "--port", String(worker.port),
    "--inspector-port", String(worker.inspectorPort),
    "--persist-to", persistTo,
    "--show-interactive-dev-session=false",
    ...(worker.https ? ["--local-protocol", "https"] : []),
  ];
}

/** Copies .dev.vars.example to .dev.vars when .dev.vars is missing. Returns true when it copied. */
export function ensureDevVars(dir: string): boolean {
  const target = join(dir, ".dev.vars");
  if (existsSync(target)) return false;
  copyFileSync(join(dir, ".dev.vars.example"), target);
  return true;
}

/** Writes apps/<name>/wrangler.dev.jsonc next to the real config (so relative paths stay valid). */
export function writeDevConfig(dir: string): string {
  const config = JSON.parse(readFileSync(join(dir, "wrangler.jsonc"), "utf8")) as Record<string, unknown>;
  const file = join(dir, "wrangler.dev.jsonc");
  writeFileSync(file, `${JSON.stringify(devConfig(config), null, 2)}\n`);
  return file;
}

// stdin is closed so wrangler never waits for an answer: with no terminal to read from it prints its
// "About to apply … continue?" question and answers it itself. With stdin inherited from a real
// terminal it waits for Y/n, and `pnpm dev` stops (verified in a pseudo-terminal, wrangler 4.138.0).
function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: REPO, stdio: ["ignore", "inherit", "inherit"] });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
}

export function parseOptions(argv: readonly string[]): { only: string[] | null; persistTo: string } {
  let only: string[] | null = null;
  let persistTo = ".wrangler/state";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--only") only = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (argv[i] === "--persist-to") persistTo = argv[++i] ?? persistTo;
    else throw new Error(`Unknown option ${argv[i]}. Use --only <names> or --persist-to <dir>.`);
  }
  return { only, persistTo };
}

function main(): void {
  const { only, persistTo } = parseOptions(process.argv.slice(2));
  const workers = DEV_WORKERS.filter((w) => existsSync(join(REPO, "apps", w.name, "wrangler.jsonc")) && (only === null || only.includes(w.name)));
  if (workers.length === 0) throw new Error("No Worker to start: check --only and the apps/ folder");

  run("pnpm", ["build:css"]);
  const configs = new Map<string, string>();
  for (const worker of workers) {
    const dir = join(REPO, "apps", worker.name);
    if (ensureDevVars(dir)) console.log(`created apps/${worker.name}/.dev.vars from .dev.vars.example`);
    configs.set(worker.name, writeDevConfig(dir));
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string; scripts?: Record<string, string> };
    if (pkg.scripts?.["build"] !== undefined) run("pnpm", ["--filter", pkg.name, "run", "build"]);
  }
  // Every Worker binds the same D1 database, so one migration run covers them all.
  run(WRANGLER, ["d1", "migrations", "apply", "asksite", "--local", "--persist-to", persistTo, "--config", configs.get(workers[0]?.name ?? "") ?? ""]);

  const children: ChildProcess[] = [];
  let stopping = false;
  const stop = (code: number) => {
    if (stopping) return;
    stopping = true;
    // The wranglers share this process group, so a signal to the whole group (Ctrl+C, or Playwright
    // stopping its web server) reaches them and their workerd directly; this covers a signal sent
    // to this process alone. wrangler stops its own workerd on SIGTERM.
    for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
    let waiting = children.filter((c) => c.exitCode === null).length;
    if (waiting === 0) process.exit(code);
    for (const child of children) child.once("exit", () => --waiting === 0 && process.exit(code));
    setTimeout(() => process.exit(code), 10_000).unref();
  };
  process.on("SIGINT", () => stop(0));
  process.on("SIGTERM", () => stop(0));

  for (const worker of workers) {
    const child = spawn(WRANGLER, devArgs(worker, configs.get(worker.name) ?? "", persistTo), { cwd: REPO, stdio: "inherit" });
    child.once("exit", (code) => {
      if (!stopping) {
        console.error(`apps/${worker.name} stopped (exit ${code}); stopping the others`);
        stop(1);
      }
    });
    children.push(child);
    console.log(`apps/${worker.name}: ${worker.https ? "https" : "http"}://localhost:${worker.port}`);
  }
  console.log("Sites: https://<slug>.localhost:8789/  Photos: https://media.localhost:8789/  Stop with Ctrl+C.");
}

if (import.meta.main) main();
```

`apps/sites/dev/seed.ts`:

```ts
// pnpm dev:seed: puts an approved demo site into the LOCAL state used by `pnpm dev`, through the
// real publishing functions, so https://demo.localhost:8789/ shows a real page with photos.
// It binds D1 and R2 through wrangler's getPlatformProxy: the local state by default; with --remote,
// the production resources (the deploy smoke test only, Task 19; needs `wrangler login`).
//
// Usage: pnpm dev:seed [--slug demo] [--fixture plumber-austin] [--persist-to .wrangler/state]
//          [--root localhost:8789] [--owner-email <email>] [--hero-photo] [--noindex] [--remote]
// Prints one JSON line: {"siteId":"…","url":"https://demo.localhost:8789/","created":true}
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EMPTY_EDITS, mediaKey, mediaUrl, newId, siteUrl, slugIssue } from "@asksite/core";
import { approveVersion, createPendingVersion } from "@asksite/publishing";
import { SiteDocument, type SiteDocumentInput } from "@asksite/site-schema";

export interface ToolsEnv {
  DB: D1Database;
  WORK: R2Bucket;
  LIVE: R2Bucket;
  MEDIA: R2Bucket;
}

/** A 16x9 grey lossless WebP (38 bytes): every demo photo, shown at 1600x900. */
export const DEMO_WEBP = Uint8Array.from(atob("UklGRh4AAABXRUJQVlA4TBEAAAAvDwACAAfQ0XL2tf+BiOh/AAA="), (c) => c.charCodeAt(0));

const REPO = resolve(import.meta.dirname, "../../..");
const SITES_DIR = join(REPO, "apps/sites");
const TOOLS_CONFIG = join(SITES_DIR, "wrangler.tools.jsonc"); // generated, gitignored

export interface SeedOptions {
  slug: string;
  fixture: string;
  persistTo: string;
  root: string;
  ownerEmail: string | null; // null: "<slug>-owner@example.com"
  heroPhoto: boolean; // add one photo to a fixture that has none (the deploy smoke test)
  indexable: boolean;
  remote: boolean; // the production D1 and R2 instead of the local state
}

export function parseSeedOptions(argv: readonly string[]): SeedOptions {
  const options: SeedOptions = {
    slug: "demo", fixture: "plumber-austin", persistTo: ".wrangler/state", root: "localhost:8789",
    ownerEmail: null, heroPhoto: false, indexable: true, remote: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i] ?? "";
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) throw new Error(`${name} needs a value`);
      return next;
    };
    if (name === "--slug") options.slug = value();
    else if (name === "--fixture") options.fixture = value();
    else if (name === "--persist-to") options.persistTo = value();
    else if (name === "--root") options.root = value();
    else if (name === "--owner-email") options.ownerEmail = value();
    else if (name === "--hero-photo") options.heroPhoto = true;
    else if (name === "--noindex") options.indexable = false;
    else if (name === "--remote") options.remote = true;
    else throw new Error(`Unknown option ${name}`);
  }
  if (!/^[a-z-]+$/.test(options.fixture)) throw new Error(`Unknown fixture ${options.fixture}`);
  return options;
}

/** The sites Worker's D1 and R2 bindings plus WORK (which asksite-sites itself never binds), so the seed
 *  reaches the same storage as `pnpm dev` whatever database id wrangler.jsonc holds. With remote, every
 *  binding is the production resource ("remote": true). */
export function toolsConfig(sites: { compatibility_date: string; d1_databases: object[]; r2_buckets: object[] }, remote: boolean): Record<string, unknown> {
  const mark = (binding: object): object => (remote ? { ...binding, remote: true } : binding);
  return {
    name: "asksite-dev-tools",
    compatibility_date: sites.compatibility_date,
    d1_databases: sites.d1_databases.map(mark),
    r2_buckets: [...sites.r2_buckets, { binding: "WORK", bucket_name: "asksite-work" }].map(mark),
  };
}

type PhotoInput = NonNullable<SiteDocumentInput["facts"]["heroPhoto"]>;

/** The photo --hero-photo adds; its URL is replaced by the upload's. */
const SAMPLE_HERO: PhotoInput = { url: "https://media.invalid/sample.webp", alt: "Sample photo of the business at work", width: 1600, height: 900 };

/** Creates the owner, site, photos and an approved version for `slug`. Does nothing if the slug exists. */
export async function seedDemoSite(
  env: ToolsEnv & { ROOT_DOMAIN: string },
  input: { slug: string; document: SiteDocumentInput; now: number; ownerEmail: string; indexable: boolean },
): Promise<{ siteId: string; url: string; created: boolean }> {
  const { slug, document, now } = input;
  if (slugIssue(slug) !== null) throw new Error(`"${slug}" is not a usable slug`);
  const existing = await env.DB.prepare("SELECT id FROM sites WHERE slug = ?").bind(slug).first<{ id: string }>();
  if (existing !== null) return { siteId: existing.id, url: siteUrl(env.ROOT_DOMAIN, slug), created: false };

  const ownerId = newId();
  const siteId = newId();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO owners (id, email, created_at) VALUES (?, ?, ?)").bind(ownerId, input.ownerEmail, now),
    env.DB.prepare("INSERT INTO sites (id, owner_id, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(siteId, ownerId, slug, now, now),
  ]);

  const upload = async (photo: PhotoInput): Promise<PhotoInput> => {
    const uploadId = newId();
    await env.MEDIA.put(mediaKey(siteId, uploadId), DEMO_WEBP);
    await env.DB.prepare("INSERT INTO uploads (id, site_id, width, height, bytes, created_at) VALUES (?, ?, 1600, 900, ?, ?)")
      .bind(uploadId, siteId, DEMO_WEBP.byteLength, now)
      .run();
    return { ...photo, url: mediaUrl(env.ROOT_DOMAIN, siteId, uploadId), width: 1600, height: 900 };
  };
  const facts = document.facts;
  const heroPhoto = facts.heroPhoto === undefined ? undefined : await upload(facts.heroPhoto);
  const photos = await Promise.all((facts.photos ?? []).map(upload));
  const parsed = SiteDocument.parse({ ...document, facts: { ...facts, photos, ...(heroPhoto === undefined ? {} : { heroPhoto }) } });
  await env.DB.prepare("UPDATE sites SET facts_json = ? WHERE id = ?").bind(JSON.stringify(parsed.facts), siteId).run();

  const version = await createPendingVersion(env, { siteId, ownerId, slug, document: parsed, edits: EMPTY_EDITS, generationId: null, now });
  const row = await env.DB.prepare("SELECT html_sha256 FROM site_versions WHERE id = ?").bind(version.id).first<{ html_sha256: string }>();
  await approveVersion(env, { versionId: version.id, htmlSha256: row?.html_sha256 ?? "", reviewer: "dev-seed@localhost", note: "Seeded demo", indexable: input.indexable, now });
  return { siteId, url: siteUrl(env.ROOT_DOMAIN, slug), created: true };
}

async function main(): Promise<void> {
  const options = parseSeedOptions(process.argv.slice(2));
  const fixture = JSON.parse(readFileSync(join(REPO, "fixtures", `${options.fixture}.json`), "utf8")) as SiteDocumentInput;
  const document = options.heroPhoto ? { ...fixture, facts: { ...fixture.facts, heroPhoto: SAMPLE_HERO } } : fixture;

  const sites = JSON.parse(readFileSync(join(SITES_DIR, "wrangler.jsonc"), "utf8")) as Parameters<typeof toolsConfig>[0];
  writeFileSync(TOOLS_CONFIG, `${JSON.stringify(toolsConfig(sites, options.remote), null, 2)}\n`);
  if (!options.remote) {
    // Production migrations are applied by the deploy runbook (Task 19 Step 5), never from here.
    const migrate = spawnSync(join(REPO, "node_modules/.bin/wrangler"), ["d1", "migrations", "apply", "asksite", "--local", "--persist-to", options.persistTo, "--config", TOOLS_CONFIG], {
      cwd: REPO,
      stdio: ["ignore", "ignore", "inherit"],
    });
    if (migrate.status !== 0) throw new Error("Applying local migrations failed");
  }

  // Loaded here, not at the top, so the unit test of the helpers above does not load wrangler.
  const { getPlatformProxy } = await import("wrangler");
  const proxy = await getPlatformProxy<ToolsEnv>({
    configPath: TOOLS_CONFIG,
    ...(options.remote ? {} : { persist: { path: join(REPO, options.persistTo, "v3") } }),
  });
  try {
    const ownerEmail = options.ownerEmail ?? `${options.slug}-owner@example.com`;
    const result = await seedDemoSite({ ...proxy.env, ROOT_DOMAIN: options.root }, { slug: options.slug, document, now: Date.now(), ownerEmail, indexable: options.indexable });
    console.log(JSON.stringify(result));
  } finally {
    await proxy.dispose();
  }
}

if (import.meta.main) await main();
```

Then the root files, by targeted edits: two new scripts and one appended `.gitignore` block (`tsconfig.workers.json` already lists `apps/sites/dev`, Task 7).

```bash
npm pkg get scripts.dev scripts.dev:seed
npm pkg set scripts.dev="node scripts/dev.ts" scripts.dev:seed="pnpm build:css && node apps/sites/dev/seed.ts"
cat >> .gitignore <<'EOF'

# Generated by pnpm dev and pnpm dev:seed: wrangler.dev.jsonc (the production config without
# routes) and wrangler.tools.jsonc (seeding bindings). Only wrangler.jsonc is committed.
apps/*/wrangler.*.jsonc
EOF
git diff --stat -- package.json .gitignore
```

Expected: first `{}` (neither script exists yet; if one does, another plan defined it: stop and ask the moderator, because Plan 2 owns `pnpm dev`, design §10.1); then `.gitignore | 4 ++++` and `package.json | 4 +++-`.

- [ ] **Step 4: Run the tests and the typecheck**

Run: `pnpm vitest run scripts/dev.test.ts apps/sites/test/seed.test.ts && pnpm typecheck`
Expected: `Test Files  2 passed (2)`, `Tests  11 passed (11)`; typecheck exits 0.

- [ ] **Step 5: Run it for real, then stop it and prove nothing is left running**

First make sure no other session holds the ports: `lsof -nP -iTCP:8789 -iTCP:9239 -sTCP:LISTEN` must print nothing (if it lists a process, another session's `pnpm dev` is running: wait for it, never stop it). Then:

```bash
cd /Users/ashir/Documents/workk2/web_maker
mkdir -p .wrangler
node scripts/dev.ts --only sites > .wrangler/dev.log 2>&1 &
echo $! > .wrangler/dev.pid
for i in $(seq 1 120); do grep -q "Ready on" .wrangler/dev.log && break; sleep 1; done
grep -E "created|apps/sites:|Ready on" .wrangler/dev.log || { tail -20 .wrangler/dev.log; kill -TERM "$(cat .wrangler/dev.pid)"; }
pnpm dev:seed | tail -1
curl -sk -o /dev/null -w "page %{http_code}\n" https://demo.localhost:8789/
curl -sk -o /dev/null -w "apex %{http_code}\n" https://localhost:8789/
curl -sk -o /dev/null -w "unknown %{http_code}\n" https://nobody.localhost:8789/
PHOTO=$(curl -sk https://demo.localhost:8789/ | grep -o 'https://media.localhost:8789/[^"]*\.webp' | head -1)
curl -sk -o /dev/null -w "photo %{http_code} %{content_type}\n" "$PHOTO"
FORM=$(curl -sk https://demo.localhost:8789/ | grep -o '/_f/[0-9a-f-]*' | head -1)
curl -sk -o /dev/null -w "form %{http_code} %{redirect_url}\n" -X POST -H 'content-type: application/x-www-form-urlencoded' --data 'name=Pat&phone=5125550123&email=&service=&message=Hello&website=' "https://demo.localhost:8789$FORM"
sleep 3
pnpm exec wrangler d1 execute asksite --local --persist-to .wrangler/state -c apps/sites/wrangler.dev.jsonc --command "SELECT to_addr, subject FROM dev_outbox" | grep -E "to_addr|subject"
kill -TERM "$(cat .wrangler/dev.pid)"; sleep 5
```

`dev.ts` is started with `node` directly (not `pnpm dev`), so `$!` is its PID and the SIGTERM reaches it; the loop gives up after 120 s and stops it. Then run the leftover check (Global Constraints) and `git status --short -- . ':(exclude)docs'`.

Expected, in order: `created apps/sites/.dev.vars from .dev.vars.example` (first run only), `apps/sites: https://localhost:8789`, `[wrangler:info] Ready on https://localhost:8789` (on a first run wrangler prints its "About to apply 1 migration(s) … continue?" question and answers it itself, because `dev.ts` gives it no terminal to read from; the same holds when `pnpm dev` runs in a real terminal); the stylesheet build's own lines, then `{"siteId":"…","url":"https://demo.localhost:8789/","created":true}`; `page 200`, `apex 200`, `unknown 404`, `photo 200 image/webp`, `form 303 https://demo.localhost:8789/_f/<siteId>/sent`; the outbox row `"to_addr": "demo-owner@example.com"` and `"subject": "New request from your website: Pat"` (the email runs just after the 303, hence the pause); `nothing left running`; and `git status` shows only this task's uncommitted files (`.dev.vars`, `wrangler.dev.jsonc`, `wrangler.tools.jsonc` and `.wrangler/` are ignored). Open `https://demo.localhost:8789/` in a browser (accept the self-signed certificate once) and look at the page: it is Plan 1's plumber page with grey photos.

- [ ] **Step 6: Commit**

```bash
git add scripts/dev.ts scripts/dev.test.ts apps/sites/dev apps/sites/test/seed.test.ts package.json .gitignore
git commit -m "Add local dev"
```

---
### Task 16: Browser tests for the public Worker (CSP, photos, form, axe)

**Files:**
- Modify: `package.json` (scripts `test:e2e:sites`, `check`, and `typecheck` adds `apps/sites/e2e`, by `npm pkg set`)
- Create: `apps/sites/e2e/playwright.config.ts`, `apps/sites/e2e/global-setup.ts`, `apps/sites/e2e/csp.ts`, `apps/sites/e2e/sites.spec.ts`, `apps/sites/e2e/smoke.config.ts`, `apps/sites/e2e/smoke.spec.ts`, `apps/sites/e2e/tsconfig.json`

**Interfaces:**
- Consumes: `pnpm dev --only sites --persist-to .wrangler/e2e-state` and `apps/sites/dev/seed.ts` (Task 15); the fixed-page builders (Task 11); Plan 1's five fixtures; Playwright 1.63.0 `webServer` (started before `globalSetup` [verified: Playwright's `createGlobalSetupTasks` runs plugin setup first], `gracefulShutdown` [verified in 1.63's `types/test.d.ts`]).
- Produces: `pnpm test:e2e:sites`, 54 tests over projects `chromium-390`, `chromium-1280`, `webkit-390`: every Plan 1 fixture published through the real pipeline, served over https by the Worker, with every photo loaded from `media.localhost:8789` and **zero CSP violations** (design §7.4's inferred claim, now tested); the contact form submitted in a real browser lands on the thank-you page (proves `form-action 'self'` plus the 303); a bad phone number gives the plain-words page without the typed text; every fixed page passes axe and reflows at 320 px (design §7.5); two RED proofs show the CSP watcher and the axe gate can fail. Also the one-test **smoke check** for a deployed page (`apps/sites/e2e/smoke.config.ts`, URL from `ASKSITE_SMOKE_URL`): its photos load, zero CSP violations, nothing requested from `/cdn-cgi/` (Task 19 Step 11; rehearsed locally in Step 4 below).

- [ ] **Step 1: Write the browser tests and their configuration**

`apps/sites/e2e/playwright.config.ts`:

```ts
import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Browser tests for the public Worker exactly as `pnpm dev` runs it: wrangler dev over https on
// port 8789, with its own local state (.wrangler/e2e-state, wiped at start). Playwright starts the
// web server before globalSetup, so global-setup.ts seeds the sites into the running server's state.
const REPO = resolve(import.meta.dirname, "../../..");

export default defineConfig({
  testDir: ".",
  testIgnore: "smoke.spec.ts", // the deployed-page check has its own config (smoke.config.ts)
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  reporter: "list",
  globalSetup: "./global-setup.ts",
  use: { ignoreHTTPSErrors: true },
  webServer: {
    command: "rm -rf .wrangler/e2e-state && node scripts/dev.ts --only sites --persist-to .wrangler/e2e-state",
    cwd: REPO,
    url: "https://localhost:8789/",
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 120_000,
    // Without this Playwright SIGKILLs the process group, which gives dev.ts no chance to stop wrangler.
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    stdout: "ignore",
    stderr: "pipe",
  },
  projects: [
    { name: "chromium-390", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } } },
    { name: "chromium-1280", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } },
    { name: "webkit-390", use: { ...devices["Desktop Safari"], viewport: { width: 390, height: 844 } } },
  ],
});
```

`apps/sites/e2e/global-setup.ts`:

```ts
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

// Publishes and approves every Plan 1 fixture into the running server's local state through the real
// publishing functions (apps/sites/dev/seed.ts), with photos served from media.localhost:8789.
export const E2E_FIXTURES = ["plumber-austin", "hvac-phoenix", "roofing-extreme", "cleaning-minimal", "electrical-xss"] as const;
const REPO = resolve(import.meta.dirname, "../../..");

export default function globalSetup(): void {
  const seeded: Record<string, { siteId: string; url: string }> = {};
  for (const fixture of E2E_FIXTURES) {
    const out = execFileSync("node", ["apps/sites/dev/seed.ts", "--slug", `e2e-${fixture}`, "--fixture", fixture, "--persist-to", ".wrangler/e2e-state"], {
      cwd: REPO,
      encoding: "utf8",
    });
    const line = out.trim().split("\n").at(-1) ?? "";
    seeded[fixture] = JSON.parse(line) as { siteId: string; url: string };
  }
  process.env["ASKSITE_E2E_SITES"] = JSON.stringify(seeded);
}
```

`apps/sites/e2e/sites.spec.ts`:

```ts
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { apexPlaceholder, formProblems, notFound, siteBusy, thankYou, tooManyRequests, unavailable, unreadableForm } from "../src/pages.ts";
import { watchCsp } from "./csp.ts";
import { E2E_FIXTURES } from "./global-setup.ts";

const ROOT = "localhost:8789";
const sites = (): Record<string, { siteId: string; url: string }> => JSON.parse(process.env["ASKSITE_E2E_SITES"] ?? "{}");

// The same gates as Plan 1's e2e: serious/critical WCAG 2.2 AA violations plus every structure rule.
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const STRUCTURE_RULES = ["region", "heading-order", "landmark-one-main", "landmark-unique", "page-has-heading-one"];

async function axeProblems(page: Page): Promise<string[]> {
  const wcag = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const structure = await new AxeBuilder({ page }).withRules(STRUCTURE_RULES).analyze();
  return [...wcag.violations.filter((v) => v.impact === "serious" || v.impact === "critical"), ...structure.violations].map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`,
  );
}

const sidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

for (const fixture of E2E_FIXTURES) {
  test.describe(`published ${fixture}`, () => {
    test("is served by the Worker with its photos and zero CSP violations", async ({ page }) => {
      const violations = await watchCsp(page);
      const badPhotos: string[] = [];
      page.on("response", (r) => {
        if (r.url().startsWith(`https://media.${ROOT}/`) && r.status() !== 200) badPhotos.push(`${r.status()} ${r.url()}`);
      });
      page.on("requestfailed", (r) => badPhotos.push(`failed ${r.url()}`));
      const response = await page.goto(sites()[fixture]?.url ?? "");
      expect(response?.status()).toBe(200);
      expect(response?.headers()["content-security-policy"]).toContain(`img-src https://media.${ROOT};`);
      await page.waitForLoadState("load");
      // Gallery photos are lazy-loaded: scroll each into view, then wait for it to decode.
      for (const img of await page.locator("img").all()) {
        await img.scrollIntoViewIfNeeded();
        await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), { timeout: 15_000 }).toBe(true);
      }
      expect(badPhotos).toEqual([]);
      expect(await violations()).toEqual([]);
    });
  });
}

test.describe("contact form in a real browser", () => {
  test("submits to the Worker and lands on the thank-you page", async ({ page }) => {
    const site = sites()["plumber-austin"];
    const violations = await watchCsp(page);
    await page.goto(site?.url ?? "");
    await page.getByLabel("Name").fill("Pat Browser");
    await page.getByLabel("Phone").fill("(512) 555-0123");
    await page.getByLabel("How can we help? (optional)").fill("Leaking tap");
    await page.getByRole("button", { name: "Send request" }).click();
    await expect(page).toHaveURL(`${site?.url}_f/${site?.siteId}/sent`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Thanks! Your message was sent.");
    expect(await violations()).toEqual([]);
    expect(await axeProblems(page)).toEqual([]);
  });

  test("shows plain-words problems for a bad phone number, without the typed text", async ({ page }) => {
    const site = sites()["cleaning-minimal"];
    await page.goto(site?.url ?? "");
    await page.getByLabel("Name").fill("Pat");
    await page.getByLabel("Phone").fill("call me");
    await page.getByRole("button", { name: "Send request" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Please check your details");
    await expect(page.getByRole("listitem")).toHaveText(["Please enter a phone number we can call back, with at least 7 digits."]);
    expect(await page.content()).not.toContain("call me");
    expect(await axeProblems(page)).toEqual([]);
  });
});

test.describe("fixed pages", () => {
  const PAGES: Array<[string, () => Response]> = [
    ["apex placeholder", () => apexPlaceholder(ROOT)],
    ["404", () => notFound(ROOT)],
    ["503", () => unavailable(ROOT)],
    ["thank-you", () => thankYou(ROOT)],
    ["rate limited", () => tooManyRequests(ROOT)],
    ["site busy", () => siteBusy(ROOT)],
    ["unreadable form", () => unreadableForm(ROOT, 415)],
    ["form problems", () => formProblems(ROOT, ["Please enter your name (up to 80 characters).", "Please check your email address, or leave it empty."])],
  ];

  for (const [name, build] of PAGES) {
    test(`${name} passes axe and reflows at 320 px`, async ({ page }) => {
      await page.setContent(await build().text());
      expect(await axeProblems(page)).toEqual([]);
      await page.setViewportSize({ width: 320, height: 640 });
      expect(await sidewaysScroll(page)).toBe(0);
    });
  }

  test("the live 404 and apex pages come from the Worker with noindex", async ({ page }) => {
    const missing = await page.goto(`https://${ROOT}/nope`);
    expect(missing?.status()).toBe(404);
    expect(missing?.headers()["x-robots-tag"]).toBe("noindex");
    const apex = await page.goto(`https://${ROOT}/`);
    expect(apex?.status()).toBe(200);
    expect(await axeProblems(page)).toEqual([]);
  });
});

test.describe("the gates can fail (RED proof)", () => {
  test("the CSP watcher sees a blocked image", async ({ page }) => {
    const violations = await watchCsp(page);
    await page.goto(sites()["cleaning-minimal"]?.url ?? "");
    await page.evaluate(() => {
      const img = document.createElement("img");
      img.src = "https://images.example.com/x.png";
      img.alt = "x";
      document.body.append(img);
    });
    await expect.poll(violations).toEqual(["img-src https://images.example.com/x.png"]);
  });

  test("axe sees a fixed page without its main landmark", async ({ page }) => {
    await page.setContent((await notFound(ROOT).text()).replace("<main>", "<div>").replace("</main>", "</div>"));
    expect((await axeProblems(page)).map((line) => line.split(":")[0])).toContain("region");
  });
});
```

`apps/sites/e2e/csp.ts`:

```ts
import type { Page } from "@playwright/test";

/** Records CSP violations the page reports, from before its first byte runs. */
export async function watchCsp(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __csp: string[] }).__csp = seen;
    document.addEventListener("securitypolicyviolation", (e) => seen.push(`${e.effectiveDirective} ${e.blockedURI}`));
  });
  return () => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
}
```

`apps/sites/e2e/smoke.config.ts`:

```ts
import { defineConfig, devices } from "@playwright/test";

// One real-browser check of a deployed page (Task 19 Step 11): no web server, one Chromium project.
// Usage: ASKSITE_SMOKE_URL=https://smoke-test.<domain>/ pnpm exec playwright test -c apps/sites/e2e/smoke.config.ts
// Certificate errors are ignored only for a local *.localhost rehearsal; a real domain must have valid TLS.
const url = process.env["ASKSITE_SMOKE_URL"] ?? "";

export default defineConfig({
  testDir: ".",
  testMatch: "smoke.spec.ts",
  reporter: "list",
  use: { ignoreHTTPSErrors: url !== "" && new URL(url).hostname.endsWith(".localhost") },
  projects: [{ name: "chromium-390", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } } }],
});
```

`apps/sites/e2e/smoke.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { watchCsp } from "./csp.ts";

// The deployed smoke-test page (Task 19 Step 11) in a real browser: every photo loads from the real
// media host under the real CSP, the page reports zero CSP violations, and nothing is fetched from
// /cdn-cgi/ (no Cloudflare feature may inject scripts into approved pages; Task 19 Step 6).
const URL_UNDER_TEST = process.env["ASKSITE_SMOKE_URL"] ?? "";

test("the deployed page loads its photos, reports zero CSP violations and loads nothing injected", async ({ page }) => {
  expect(URL_UNDER_TEST, "set ASKSITE_SMOKE_URL to the page's https address").toMatch(/^https:\/\//);
  const violations = await watchCsp(page);
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  const response = await page.goto(URL_UNDER_TEST);
  expect(response?.status()).toBe(200);
  const images = await page.locator("img").all();
  expect(images.length).toBeGreaterThan(0);
  for (const img of images) {
    await img.scrollIntoViewIfNeeded();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), { timeout: 15_000 }).toBe(true);
  }
  expect(requested.filter((url) => url.includes("/cdn-cgi/"))).toEqual([]);
  expect(await violations()).toEqual([]);
});
```

`apps/sites/e2e/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.json",
  "compilerOptions": { "lib": ["es2023", "dom", "dom.iterable"] },
  "include": ["."],
  "exclude": []
}
```

Then the root `package.json`, by targeted edits: the new script, and `typecheck` and `check` include it.

```bash
npm pkg get scripts.typecheck scripts.check scripts.test:e2e:sites
npm pkg set scripts.test:e2e:sites="pnpm build:css && playwright test -c apps/sites/e2e/playwright.config.ts" scripts.typecheck="pnpm build:css && tsc -p . && tsc -p e2e && tsc -p tsconfig.workers.json && tsc -p apps/sites/e2e" scripts.check="pnpm typecheck && pnpm test && pnpm test:e2e && pnpm test:e2e:sites"
git diff --stat -- package.json
```

Expected: first

```text
{
  "scripts.typecheck": "pnpm build:css && tsc -p . && tsc -p e2e && tsc -p tsconfig.workers.json",
  "scripts.check": "pnpm typecheck && pnpm test && pnpm test:e2e"
}
```

(if either differs, another plan changed it: append ` && tsc -p apps/sites/e2e` and ` && pnpm test:e2e:sites` by hand instead); then `package.json | 7 ++++---`.

- [ ] **Step 2: Prove the gate fails when the photos are blocked (RED)**

The Worker already exists, so the red run breaks it on purpose. The response header keeps its exact `img-src https://media.localhost:8789;` part (so the header check still passes) and gains a second policy after a comma, `img-src 'none'`: browsers enforce every policy in the header, so every photo is blocked and only the photo and CSP-violation checks can catch it.

```bash
sed -i '' "s|frame-ancestors 'none'\`;|frame-ancestors 'none', img-src 'none'\`;|" apps/sites/src/headers.ts
git diff --stat -- apps/sites/src/headers.ts
pnpm test:e2e:sites --project chromium-390 --grep "zero CSP violations"
git checkout -- apps/sites/src/headers.ts
git status --short -- apps/sites/src
```

Expected: the diff shows `apps/sites/src/headers.ts | 2 +-`; the run FAILS with `4 failed` and `1 passed`: the four fixtures with photos fail on a photo that never loads (`expect.poll` of `naturalWidth`), the fifth (`cleaning-minimal`) has no photo to block; after `git checkout` the last command prints nothing. The CSP watcher itself is also proven by the in-suite test "the CSP watcher sees a blocked image".

- [ ] **Step 3: Run the whole browser suite**

Run: `pnpm test:e2e:sites`
Expected: `54 passed` in about 1–3 minutes (planning replays: 1.2–1.5 minutes; 2.3 minutes on a heavily loaded machine). Then the leftover check (Global Constraints) prints `nothing left running`: Playwright stopped the web server with SIGTERM and `dev.ts` stopped `wrangler`. If an image check ever times out, the test lists any photo response that was not 200 and any failed request, so a real serving fault shows up by name.

- [ ] **Step 4: Rehearse the deployed-page smoke check locally**

Task 19 runs `smoke.spec.ts` against the real domain; this proves it works first. Check the ports are free (`lsof -nP -iTCP:8789 -iTCP:9239 -sTCP:LISTEN` prints nothing), then:

```bash
cd /Users/ashir/Documents/workk2/web_maker
mkdir -p .wrangler
node scripts/dev.ts --only sites > .wrangler/dev.log 2>&1 &
echo $! > .wrangler/dev.pid
for i in $(seq 1 120); do grep -q "Ready on" .wrangler/dev.log && break; sleep 1; done
node apps/sites/dev/seed.ts --slug smoke-test --fixture cleaning-minimal --hero-photo --noindex | tail -1
ASKSITE_SMOKE_URL=https://smoke-test.localhost:8789/ pnpm exec playwright test -c apps/sites/e2e/smoke.config.ts
kill -TERM "$(cat .wrangler/dev.pid)"; sleep 5
```

Expected: `{"siteId":"…","url":"https://smoke-test.localhost:8789/","created":true}`, then `1 passed`; then the leftover check (Global Constraints) prints `nothing left running`.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: exits 0 (four programs: root, Plan 1's e2e, Workers, sites e2e).

- [ ] **Step 6: Commit**

```bash
git add apps/sites/e2e package.json
git commit -m "Add sites e2e"
```

---
### Task 17: CI workflow, deploy-readiness check and the DNS record list

**Files:**
- Create: `.github/workflows/ci.yml`, `scripts/deploy-check.ts`, `deploy/dns-records.json`
- Modify: `package.json` (script `deploy:check`, by `npm pkg set`)
- Test: `scripts/deploy-check.test.ts`, `apps/sites/test/dns-records.test.ts`

**Interfaces:**
- Consumes: `RESERVED_SLUGS` (Task 2); every `apps/*/wrangler.jsonc`.
- Produces: `pnpm deploy:check` (exit 1 while any Worker config still has the placeholder domain or database id, a development value, an unsafe switch of any of the four Workers (`MAILER` other than `resend`, `ADMIN_AUTH_MODE` other than `access`, `MODEL_PROVIDER=fake`, a secret-like name in `vars`; design §9.1), or a security.txt expiry outside 30–366 days); `deployProblems(text, now): string[]`; `deploy/dns-records.json` (every record of the product zone; design §1.1 requires a test that each first-level label is `@`, `*`, an underscore label or a reserved slug, because a label with its own record escapes the `*` wildcard); the CI workflow (design §11.3): install, typecheck, unit + integration, Plan 1's browser tests without its macOS-only screenshots (`--ignore-snapshots` [verified: an option of `playwright test` 1.63.0]), and the sites browser tests.
- Actions are pinned to commit SHAs [verified with `git ls-remote` on 2026-09-24]: `actions/checkout` v7.0.1 `3d3c42e5aac5ba805825da76410c181273ba90b1` and `actions/setup-node` v7.0.0 `820762786026740c76f36085b0efc47a31fe5020` (lightweight tags: the tag is the commit), and `pnpm/action-setup` v6.1.0 `ea17c68df8912ef543352723c149a84f56e3d413` (an annotated tag: `d9184bf…` is the tag object, `refs/tags/v6.1.0^{}` is this commit) (inputs `node-version-file` and `cache: pnpm` [verified: its `action.yml`]). The workflow has never run on GitHub [unverified]; its first run is the moderator's first push after this task.

- [ ] **Step 1: Write the failing tests**

`scripts/deploy-check.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deployProblems } from "./deploy-check.ts";

const NOW = Date.parse("2026-09-24T00:00:00.000Z");

// A config shaped like apps/sites/wrangler.jsonc as committed before the deploy task (it holds the
// local placeholders). Inline, so this test keeps passing after the real values are committed.
const PLACEHOLDERS = JSON.stringify({
  name: "asksite-sites",
  workers_dev: false,
  preview_urls: false,
  observability: { enabled: true, logs: { invocation_logs: false } },
  routes: [{ pattern: "*.asksite.example/*", zone_name: "asksite.example" }],
  vars: {
    ENVIRONMENT: "production",
    ROOT_DOMAIN: "asksite.example",
    MAILER: "resend",
    MAIL_FROM: "asksite <leads@mail.asksite.example>",
    SECURITY_TXT_EXPIRES: "2027-09-01T00:00:00.000Z",
  },
  d1_databases: [{ binding: "DB", database_name: "asksite", database_id: "00000000-0000-0000-0000-000000000000" }],
});

const ready = (): string =>
  PLACEHOLDERS.replaceAll("asksite.example", "tradesites.test").replace("00000000-0000-0000-0000-000000000000", "3f0f5a4e-7c1b-4d8e-9a2b-1c2d3e4f5a6b");

describe("deployProblems", () => {
  it("blocks a config that still holds the local placeholders", () => {
    expect(deployProblems(PLACEHOLDERS, NOW)).toEqual([
      "still uses the placeholder domain asksite.example",
      "D1 database_id is still the local placeholder",
    ]);
  });

  it("passes a config with the real domain, database id and a fresh security.txt date", () => {
    expect(deployProblems(ready(), NOW)).toEqual([]);
  });

  it("catches development values and unsafe switches", () => {
    const unsafe = ready()
      .replace('"ENVIRONMENT":"production"', '"ENVIRONMENT":"development"')
      .replace('"MAILER":"resend"', '"MAILER":"log"')
      .replace('"workers_dev":false', '"workers_dev":true')
      .replace('"invocation_logs":false', '"invocation_logs":true');
    expect(deployProblems(unsafe, NOW)).toEqual([
      "vars.ENVIRONMENT must be production",
      "vars.MAILER must be resend",
      "workers_dev and preview_urls must be false",
      "observability.logs.invocation_logs must be false",
    ]);
  });

  it("catches the other Workers' unsafe switches and a secret put in vars (design §9.1)", () => {
    const config = JSON.parse(ready()) as { vars: Record<string, string> };
    config.vars = { ...config.vars, ADMIN_AUTH_MODE: "dev", MODEL_PROVIDER: "fake", RESEND_API_KEY: "re_not_a_real_key" };
    expect(deployProblems(JSON.stringify(config), NOW)).toEqual([
      "vars.ADMIN_AUTH_MODE must be access",
      "vars.MODEL_PROVIDER must not be fake",
      "vars.RESEND_API_KEY looks like a secret: use wrangler secret put",
    ]);
  });

  it("catches a local root domain", () => {
    const local = ready().replace('"ROOT_DOMAIN":"tradesites.test"', '"ROOT_DOMAIN":"localhost:8789"');
    expect(deployProblems(local, NOW)).toContain("vars.ROOT_DOMAIN must be the real domain without a port");
  });

  it("wants security.txt to expire 30 to 366 days ahead", () => {
    const soon = ready().replace("2027-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z");
    const far = ready().replace("2027-09-01T00:00:00.000Z", "2028-09-01T00:00:00.000Z");
    expect(deployProblems(soon, NOW)).toEqual(["vars.SECURITY_TXT_EXPIRES must be 30 to 366 days from today"]);
    expect(deployProblems(far, NOW)).toEqual(["vars.SECURITY_TXT_EXPIRES must be 30 to 366 days from today"]);
  });
});
```

`apps/sites/test/dns-records.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RESERVED_SLUGS } from "@asksite/core";
import { describe, expect, it } from "vitest";

const { records } = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../deploy/dns-records.json"), "utf8")) as {
  records: Array<{ type: string; name: string; proxied: boolean }>;
};

describe("deploy/dns-records.json", () => {
  it("gives no DNS label to a name that could be a site", () => {
    for (const { name } of records) {
      const firstLevel = name.split(".").at(-1) ?? "";
      const safe = firstLevel === "@" || firstLevel === "*" || firstLevel.startsWith("_") || RESERVED_SLUGS.has(firstLevel);
      expect(safe, `${name} uses the label "${firstLevel}"`).toBe(true);
    }
  });

  it("proxies the two Worker records through Cloudflare", () => {
    expect(records.filter((r) => r.type === "AAAA")).toEqual([
      expect.objectContaining({ name: "@", proxied: true }),
      expect.objectContaining({ name: "*", proxied: true }),
    ]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run scripts/deploy-check.test.ts apps/sites/test/dns-records.test.ts`
Expected: FAIL: `Test Files  2 failed (2)`: `Cannot find module './deploy-check.ts'` and `ENOENT … deploy/dns-records.json`.

- [ ] **Step 3: Write the implementation**

`scripts/deploy-check.ts`:

```ts
// pnpm deploy:check: refuses to let a Worker config go to production while it still holds a local
// placeholder. Run by the deploy runbook (Plan 2, final task) before every `wrangler deploy`.
// Usage: pnpm deploy:check            (every apps/*/wrangler.jsonc)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const PLACEHOLDER_DOMAIN = "asksite.example";
export const PLACEHOLDER_DATABASE_ID = "00000000-0000-0000-0000-000000000000";
const DAY = 86_400_000;
const SECRET_LIKE = /KEY|SECRET|TOKEN|PASSWORD/i;

interface WorkerConfig {
  workers_dev?: boolean;
  preview_urls?: boolean;
  observability?: { logs?: { invocation_logs?: boolean } };
  vars?: Record<string, string>;
  d1_databases?: Array<{ database_id?: string }>;
}

/** Everything that would make this config unsafe or broken in production. Empty means ready. */
export function deployProblems(text: string, now: number): string[] {
  const config = JSON.parse(text) as WorkerConfig;
  const vars = config.vars ?? {};
  const problems: string[] = [];
  if (text.includes(PLACEHOLDER_DOMAIN)) problems.push(`still uses the placeholder domain ${PLACEHOLDER_DOMAIN}`);
  if ((config.d1_databases ?? []).some((d) => d.database_id === PLACEHOLDER_DATABASE_ID)) problems.push("D1 database_id is still the local placeholder");
  if (vars["ENVIRONMENT"] !== "production") problems.push("vars.ENVIRONMENT must be production");
  // Each switch is checked only where a Worker has it (design §10.3); a present value must be the safe one.
  if (vars["MAILER"] !== undefined && vars["MAILER"] !== "resend") problems.push("vars.MAILER must be resend");
  if (vars["ADMIN_AUTH_MODE"] !== undefined && vars["ADMIN_AUTH_MODE"] !== "access") problems.push("vars.ADMIN_AUTH_MODE must be access");
  if (vars["MODEL_PROVIDER"] === "fake") problems.push("vars.MODEL_PROVIDER must not be fake");
  for (const name of Object.keys(vars)) if (SECRET_LIKE.test(name)) problems.push(`vars.${name} looks like a secret: use wrangler secret put`);
  if (/localhost|:\d+$/.test(vars["ROOT_DOMAIN"] ?? "")) problems.push("vars.ROOT_DOMAIN must be the real domain without a port");
  if (config.workers_dev !== false || config.preview_urls !== false) problems.push("workers_dev and preview_urls must be false");
  if (config.observability?.logs?.invocation_logs !== false) problems.push("observability.logs.invocation_logs must be false");
  const expires = vars["SECURITY_TXT_EXPIRES"];
  if (expires !== undefined) {
    const days = (Date.parse(expires) - now) / DAY;
    if (!(days >= 30 && days <= 366)) problems.push("vars.SECURITY_TXT_EXPIRES must be 30 to 366 days from today");
  }
  return problems;
}

function main(): void {
  const apps = resolve(import.meta.dirname, "../apps");
  let failed = false;
  for (const name of readdirSync(apps)) {
    const file = join(apps, name, "wrangler.jsonc");
    if (!existsSync(file)) continue;
    const problems = deployProblems(readFileSync(file, "utf8"), Date.now());
    console.log(problems.length === 0 ? `apps/${name}: ready` : `apps/${name}:\n  - ${problems.join("\n  - ")}`);
    failed ||= problems.length > 0;
  }
  if (failed) process.exit(1);
}

if (import.meta.main) main();
```

`deploy/dns-records.json`:

```json
{
  "note": "Every DNS record in the product zone. Names are relative to the root domain. Values marked 'from ...' are copied from that dashboard at deploy time. A test (apps/sites/test/dns-records.test.ts) checks that every first-level label is @, *, an underscore label or a RESERVED_SLUGS entry, because a label with its own record escapes the * wildcard and a site with that slug would have no address.",
  "records": [
    { "type": "AAAA", "name": "@", "content": "100::", "proxied": true, "purpose": "apex placeholder page and security.txt (asksite-sites)" },
    { "type": "AAAA", "name": "*", "content": "100::", "proxied": true, "purpose": "every <slug>, www, media, app and admin (Workers Routes pick the Worker)" },
    { "type": "MX", "name": "send.mail", "content": "from Resend (Domains > mail.<root>)", "proxied": false, "purpose": "Resend sending (bounce feedback)" },
    { "type": "TXT", "name": "send.mail", "content": "from Resend (SPF)", "proxied": false, "purpose": "Resend sending (SPF)" },
    { "type": "TXT", "name": "resend._domainkey.mail", "content": "from Resend (DKIM)", "proxied": false, "purpose": "Resend sending (DKIM)" },
    { "type": "TXT", "name": "_dmarc", "content": "v=DMARC1; p=reject; sp=reject;", "proxied": false, "purpose": "DMARC: only mail.<root> sends (Resend, DKIM-signed); mail claiming any other name of the zone is rejected. Added once Resend shows Verified (Task 19 Step 8)" },
    { "type": "MX", "name": "@", "content": "added by Cloudflare Email Routing", "proxied": false, "purpose": "abuse@ and security@ forwarding" },
    { "type": "TXT", "name": "@", "content": "added by Cloudflare Email Routing (SPF)", "proxied": false, "purpose": "abuse@ and security@ forwarding" }
  ]
}
```

`.github/workflows/ci.yml`:

```yaml
# Every push and pull request: typecheck, unit + integration tests (workerd through wrangler's test
# harness, no Cloudflare account), Plan 1's browser tests without its macOS-only screenshots, and
# the sites Worker's browser tests over https. Third-party actions are pinned to commit SHAs.
name: ci

on:
  push:
    branches: [main, "plan*"]
  pull_request:

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  check:
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0 (reads packageManager from package.json)
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm exec playwright install --with-deps --only-shell chromium webkit
      # Customer hostnames are <slug>.localhost; make sure every engine resolves the e2e ones on Linux.
      - run: echo "127.0.0.1 media.localhost www.localhost e2e-plumber-austin.localhost e2e-hvac-phoenix.localhost e2e-roofing-extreme.localhost e2e-cleaning-minimal.localhost e2e-electrical-xss.localhost" | sudo tee -a /etc/hosts
      # Plan 1's screenshot baselines are named *-darwin.png, so Linux ignores them; every other check runs.
      - run: pnpm test:e2e --ignore-snapshots
      - run: pnpm test:e2e:sites
```

Then the root `package.json`: one new script.

```bash
npm pkg get scripts.deploy:check
npm pkg set scripts.deploy:check="node scripts/deploy-check.ts"
git diff --stat -- package.json
```

Expected: first `{}` (the script does not exist yet), then `package.json | 3 ++-`.

- [ ] **Step 4: Run the tests, the check, the typecheck and the whole suite**

Run: `pnpm vitest run scripts/deploy-check.test.ts apps/sites/test/dns-records.test.ts`
Expected: `Tests  8 passed (8)`.

Run: `pnpm deploy:check; echo "exit $?"`
Expected: the output includes these lines (pnpm also prints its own `> asksite@ deploy:check` banner and `ELIFECYCLE  Command failed with exit code 1.`), which is correct before Task 19:

```text
apps/sites:
  - still uses the placeholder domain asksite.example
  - D1 database_id is still the local placeholder
exit 1
```

Run: `python3 -c 'import yaml; d = yaml.safe_load(open(".github/workflows/ci.yml")); print(len(d["jobs"]["check"]["steps"]))'`
Expected: `10` (the workflow is valid YAML; PyYAML is present on this Mac [verified]).

Run: `pnpm typecheck && pnpm test`
Expected: typecheck exits 0; the `unit` run `Test Files  P+18 passed`, `Tests  T+188 passed`, then the `workerd` run `Test Files  11 passed (11)`, `Tests  96 passed (96)` (planning replay: 41 / 743, then 11 / 96).

- [ ] **Step 5: Commit**

```bash
git add scripts/deploy-check.ts scripts/deploy-check.test.ts deploy/dns-records.json apps/sites/test/dns-records.test.ts .github/workflows/ci.yml package.json
git commit -m "Add CI checks"
```

---
### Task 18: Full verification and adversarial checks (no account)

**Files:**
- None. Nothing is committed in this task unless a check fails and is fixed (then report it to the moderator first).

**Interfaces:**
- Consumes: everything above.
- Produces: the evidence the moderator needs to merge: all four suites green, nine deliberate breakages each caught by a named test (or by the typecheck), no other plan's line lost from a shared root file, no stray process, clean commits.

- [ ] **Step 1: Run every check from clean**

Run: `pnpm check`
Expected: typecheck exits 0; the `unit` run `Test Files  P+18 passed`, `Tests  T+188 passed` and the `workerd` run `Tests  96 passed (96)`; Plan 1's browser tests with their own totals and `0 failed` (Plan 1's plan: `124 passed`, `24 skipped`; a failure whose only error is Playwright's 30 s test timeout follows Task 6 Step 6's rule); `54 passed` for the sites browser tests; exit code 0. (Check the ports first: `lsof -nP -iTCP:8789 -iTCP:9239 -sTCP:LISTEN` prints nothing.)

- [ ] **Step 2: Adversarial checks: break nine guarantees and watch a named test catch each**

Run each block on its own. Each ends with `git checkout` and a `git status` that must print nothing.

```bash
# M1: serve LIVE bytes even when D1 says the site is not live
sed -i '' 's/  if (site === null) return notFound(root);/  if (site === null) return new Response(body, { headers: livePageHeaders(root, true) });/' apps/sites/src/page.ts
git diff --stat -- apps/sites/src
pnpm vitest run apps/sites/test/serving.workerd.test.ts
git checkout -- apps/sites/src/page.ts && git status --short -- . ':(exclude)docs'
```
Expected: `apps/sites/src/page.ts | 2 +-`; FAIL `Tests  1 failed | 14 passed (15)` on "D1 decides: a site that is not live gets 404 even when a LIVE object exists"; then nothing.

```bash
# M2: approve without comparing the hash the admin was shown
sed -i '' 's/  if (input.htmlSha256 !== row.html_sha256) throw new PublishError("integrity", { reason: "reviewed_hash_mismatch" });//' packages/publishing/src/review.ts
git diff --stat -- packages/publishing/src
pnpm vitest run packages/publishing/test/review.workerd.test.ts
git checkout -- packages/publishing/src/review.ts && git status --short -- . ':(exclude)docs'
```
Expected: `packages/publishing/src/review.ts | 2 +-`; FAIL `Tests  1 failed | 8 passed (9)` on "refuses when the admin saw different bytes, and changes nothing"; then nothing.

```bash
# M3: let the public Worker write to LIVE (through a hand-written type, so only the source scan can see it)
printf '\nexport const leak = (env: { LIVE: R2Bucket }) => env.LIVE.put("x", "y");\n' >> apps/sites/src/log.ts
pnpm vitest run apps/sites/test/source.test.ts
git checkout -- apps/sites/src/log.ts && git status --short -- . ':(exclude)docs'
```
Expected: FAIL `Tests  1 failed | 3 passed (4)` on "never writes to or deletes from LIVE or MEDIA"; then nothing.

```bash
# M4: ship the log mailer to production
sed -i '' 's/"MAILER": "resend"/"MAILER": "log"/' apps/sites/wrangler.jsonc
pnpm vitest run apps/sites/test/config.test.ts
git checkout -- apps/sites/wrangler.jsonc && git status --short -- . ':(exclude)docs'
```
Expected: FAIL `Tests  1 failed | 7 passed (8)` on "is the production configuration"; then nothing.

```bash
# M5: stop escaping visitor values in the lead email
sed -i '' 's/`<strong>${label}:<\/strong> ${escapeText(value)}`/`<strong>${label}:<\/strong> ${value}`/' apps/sites/src/lead-email.ts
git diff --stat -- apps/sites/src
pnpm vitest run apps/sites/test/lead-email.test.ts apps/sites/test/resend.workerd.test.ts
git checkout -- apps/sites/src/lead-email.ts && git status --short -- . ':(exclude)docs'
```
Expected: `apps/sites/src/lead-email.ts | 2 +-`; FAIL `Tests  2 failed | 5 passed (7)` ("puts visitor values only into escaped text…" and the Resend request test); then nothing.

```bash
# M6: drop the honeypot
sed -i '' 's/  if ((fields.get("website") ?? "") !== "") return { response: seeOther(sent), code: "honeypot" };//' apps/sites/src/form.ts
git diff --stat -- apps/sites/src
pnpm vitest run apps/sites/test/form.workerd.test.ts
git checkout -- apps/sites/src/form.ts && git status --short -- . ':(exclude)docs'
```
Expected: `apps/sites/src/form.ts | 2 +-`; FAIL `Tests  1 failed | 14 passed (15)` on "drops a bot that filled the honeypot but still thanks it"; then nothing.

```bash
# M7: write to LIVE through the Worker's own Env: the type has no put, so it does not compile
printf '\nexport const leak = (env: Env) => env.LIVE.put("x", "y");\n' >> apps/sites/src/page.ts
pnpm exec tsc -p tsconfig.workers.json; echo "tsc exit $?"
git checkout -- apps/sites/src/page.ts && git status --short -- . ':(exclude)docs'
```
Expected: `apps/sites/src/page.ts(…): error TS2339: Property 'put' does not exist on type 'Pick<R2Bucket, "get" | "head">'.` and `tsc exit 1`; then nothing.

```bash
# M8: serve whatever bytes LIVE holds, even another version than D1's live one
sed -i '' 's/  if (versionId !== site.live_version_id) return unavailable(root);//' apps/sites/src/page.ts
git diff --stat -- apps/sites/src
pnpm vitest run apps/sites/test/serving.workerd.test.ts
git checkout -- apps/sites/src/page.ts && git status --short -- . ':(exclude)docs'
```
Expected: `apps/sites/src/page.ts | 2 +-`; FAIL `Tests  1 failed | 14 passed (15)` on "answers 503, uncached, while LIVE holds another version than the one D1 says is live"; then nothing.

```bash
# M9: drop the publish cap's early check (the request over the cap renders and stores a page)
sed -i '' 's/  if ((await requestsSince(db, siteId, dayStart)) >= LIMITS.publishRequestsPerSitePerDay) throw capReached();//' packages/publishing/src/versions.ts
git diff --stat -- packages/publishing/src
pnpm vitest run packages/publishing/test/versions.workerd.test.ts
git checkout -- packages/publishing/src/versions.ts && git status --short -- . ':(exclude)docs'
```
Expected: `packages/publishing/src/versions.ts | 2 +-`; FAIL `Tests  1 failed | 9 passed (10)` on "allows LIMITS.publishRequestsPerSitePerDay requests a UTC day, then refuses without storing anything"; then nothing. (The in-batch check is proven by the race test: with the batch condition disabled, "stays exact when requests race" fails.)

- [ ] **Step 3: Confirm no other plan's line was lost from a shared root file**

Run: `git diff main -- package.json tsconfig.json vitest.config.ts .gitignore pnpm-workspace.yaml | grep -E '^-[^-]'`
Expected: exactly these eight lines, each one Plan 2 changed on purpose (a script it extended, a line that gained a comma, and Plan 1's two-line Vitest setup that Task 5 replaced):

```text
-    "build:css": "pnpm --filter @asksite/renderer run build:css",
-    "typecheck": "tsc -p . && tsc -p e2e",
-    "test": "pnpm build:css && vitest run",
-    "check": "pnpm typecheck && pnpm test && pnpm test:e2e"
-    "vitest": "5.0.1"
-  "include": ["packages/*/src", "packages/*/test", "fixtures", "scripts", "vitest.config.ts"]
-import { defineConfig } from "vitest/config";
-    include: ["packages/*/test/**/*.test.ts", "scripts/**/*.test.ts"],
```

If `main` already holds another plan's work, its lines differ (for example a longer `include`): any removed line that is not one of these changes is an entry Plan 2 dropped. Put it back and tell the moderator.

- [ ] **Step 4: Confirm the tree is green and nothing is running**

Run: `pnpm test`, then the leftover check (Global Constraints).
Expected: `Tests  T+188 passed` and `Tests  96 passed (96)`, then `nothing left running`.

- [ ] **Step 5: Check commit identity and messages**

```bash
git log --oneline main..plan2-hosting | wc -l
git log --format='%an <%ae>|%cn <%ce>' main..plan2-hosting | grep -v '^sydashir <meetashirr@gmail.com>|sydashir <meetashirr@gmail.com>$' && echo "WRONG IDENTITY" || echo "identity ok"
git log --format=%B main..plan2-hosting | grep -iE 'co-authored|generated with|claude|anthropic' && echo "AI ATTRIBUTION FOUND" || echo "no attribution"
git log --format=%s main..plan2-hosting | awk 'NF>3' | grep . && echo "MESSAGE OVER 3 WORDS" || echo "messages ok"
git log --name-only --format= main..plan2-hosting | grep -E '(^|/)\.dev\.vars$|\.env|\.pem$|\.key$' && echo "SECRET FILE COMMITTED" || echo "no secret files"
```
Expected: `17`, then `identity ok`, `no attribution`, `messages ok`, `no secret files`. Any offending line is printed above its warning; stop and report it instead of rewriting history (that is the moderator's decision).

- [ ] **Step 6: Hand back**

Tell the moderating session: the branch name `plan2-hosting`, the 17 commits, the totals from Step 1, Steps 2–5's results, and the decisions it must accept or change (the "Decisions made while writing this plan" list, items 2–6, 9, 10, 13, 15 and 24–33). It pushes and merges; Task 19 waits for the user.

---
### Task 19: Deploy to the user's Cloudflare account (NEEDS THE USER)

Everything above ran with no account. This task needs the user, in this order: the domain, a Cloudflare account (the user logs in; no token is ever pasted into chat), a Resend account, and later Workers Paid. Run it only after the moderator has merged Plans 2, 3 and 4 or explicitly decided to deploy `asksite-sites` alone first (it is safe alone: with no approved site every customer hostname is a 404). Steps 2–4 create resources for every Worker (design §10.4); Steps 6–12 deploy and smoke-test `asksite-sites`. Plans 3 and 4 deploy their own Workers with their own secrets.

**Files:**
- Modify: `apps/sites/wrangler.jsonc` (the real domain, database id, sender and security.txt date)

**Interfaces:**
- Consumes: `pnpm deploy:check` (Task 17), `deploy/dns-records.json` (Task 17), the migration (Task 5), `apps/sites/dev/seed.ts --remote` (Task 15), `apps/sites/e2e/smoke.config.ts` (Task 16).
- Produces: `asksite-sites` live on `*.<domain>/*` and `<domain>/*`, and a smoke test proving on the real edge: TLS on first-level subdomains, HSTS, the D1 gate, that visitors get exactly the approved bytes (no Cloudflare feature rewrites or injects anything), the publishing functions and their audit rows on the production D1, lead email through Resend with DMARC passing, and photos stopping within 5 minutes of a takedown (Decision 7).

- [ ] **Step 1: The user's calls (design §12)**

The user chooses the domain (§12.1) and the sender brand for `MAIL_FROM` (§12.9), adds the domain to Cloudflare ("Add a site", then the registrar's nameservers), and starts the Public Suffix List request at https://github.com/publicsuffix/list (PRIVATE section; review takes weeks to months, so start at once). In the shell used for this task:

```bash
cd /Users/ashir/Documents/workk2/web_maker
DOMAIN=example.com        # replace with the chosen domain, lower case, no "https://", no trailing dot
BRAND="Example Sites"     # replace with the sender name shown in inboxes (no "/", "&" or "<")
```

- [ ] **Step 2: Log in as the user (the user does this, in a browser)**

Run: `pnpm exec wrangler login` then `pnpm exec wrangler whoami`
Expected: the user approves in the browser; `whoami` prints the user's email and account. Never paste an API token into chat or a file.

- [ ] **Step 3: Create the resources (all Workers)**

```bash
pnpm exec wrangler d1 create asksite --location=enam
pnpm exec wrangler r2 bucket create asksite-live --location=enam
pnpm exec wrangler r2 bucket create asksite-work --location=enam
pnpm exec wrangler r2 bucket create asksite-media --location=enam
pnpm exec wrangler queues create asksite-generation
pnpm exec wrangler queues create asksite-generation-dlq
```

Expected: each succeeds; `d1 create` prints the new `database_id`. Copy it: `DB_ID=<the printed id>`. (D1's location option is a hint that "is not guaranteed" [verified, design §1.3]; `enam` is Eastern North America for a US market.)

- [ ] **Step 4: Put the real values into the config and check them**

```bash
sed -i '' "s/asksite\.example/$DOMAIN/g; s/00000000-0000-0000-0000-000000000000/$DB_ID/" apps/*/wrangler.jsonc
sed -i '' "s/\"MAIL_FROM\": \"asksite </\"MAIL_FROM\": \"$BRAND </" apps/sites/wrangler.jsonc
EXPIRES=$(node -e 'console.log(new Date(Date.now() + 365 * 86400000).toISOString())')
sed -i '' "s/\"SECURITY_TXT_EXPIRES\": \"[^\"]*\"/\"SECURITY_TXT_EXPIRES\": \"$EXPIRES\"/" apps/sites/wrangler.jsonc
git diff -- apps
pnpm deploy:check
pnpm test
```

Expected: the diff shows only the domain, the database id, the sender name and the date; `pnpm deploy:check` prints `apps/<name>: ready` for every Worker; `pnpm test` still passes (the tests read the database id from the config, Decision 16).

- [ ] **Step 5: Apply the schema to the real database**

Run: `pnpm exec wrangler d1 migrations apply asksite --remote -c apps/sites/wrangler.jsonc`
Expected: `0001_init.sql` listed with ✅.

- [ ] **Step 6: DNS records (Cloudflare dashboard → DNS)**

Add exactly the records in `deploy/dns-records.json`: `AAAA @ 100::` and `AAAA * 100::`, both **Proxied** (Cloudflare documents `100::` for Workers without an origin; proxied wildcards are available on all plans [verified, design §1.1]). The mail records come in Steps 8 and 9. Add no other record without first adding its label to `RESERVED_SLUGS` and `deploy/dns-records.json` (the test in Task 17 enforces it).

Zone settings: SSL/TLS "Always Use HTTPS" on; Minimum TLS 1.2; Caching "Browser Cache TTL" = "Respect Existing Headers" (otherwise Cloudflare may raise our `max-age` values: "Cloudflare respects whichever value is higher: the Browser Cache TTL in Cloudflare or the max-age header" [verified: developers.cloudflare.com/cache/concepts/cache-control/]). Do not turn on the dashboard HSTS setting or HSTS preload (design §12.11): the Worker sends its own header.

The admin approves exact bytes, and customer pages carry no JavaScript (design §0.2); Cloudflare features that rewrite HTML or inject scripts would break both, and our CSP would block what they inject. Turn **off** (find each by name in the dashboard; menu paths change):
- **Email Address Obfuscation**. It is on by default ("Cloudflare enables email address obfuscation automatically when you sign up"); it replaces addresses with `[email protected]` links and injects `email-decode.min.js`, so the owner's email would show as `[email protected]` on every customer page. Its page exempts HTML "specifically added by a Worker"; whether bytes a Worker serves from R2 count is not stated [verified quote and [unverified] exemption: developers.cloudflare.com/waf/tools/scrape-shield/email-address-obfuscation/; the path given there is Security → Settings → Email Address Obfuscation].
- **Rocket Loader**, **Automatic HTTPS Rewrites**, **Web Analytics** automatic setup (Real User Measurements), **Zaraz** and **Cloudflare Fonts**: each rewrites HTML or injects a script [inferred from their names and purpose; Step 11 proves the result].
- Keep **Bot Fight Mode** off: "For Bot Fight Mode customers, JavaScript Detections is automatically enabled and cannot be disabled", and it injects scripts from `/cdn-cgi/challenge-platform/` into HTML pages [verified: developers.cloudflare.com/cloudflare-challenges/challenge-types/javascript-detections/].

`Cache-Control: no-transform` is not used instead: with it Cloudflare "does not transform body" and skips JavaScript Detections, but "Compression is disabled when the `no-transform` directive is present", which would send every page uncompressed; the page does not say it stops Email Address Obfuscation or Rocket Loader [verified: developers.cloudflare.com/cache/concepts/cache-control/]. Step 11 checks the outcome directly: the served page must hash to exactly the approved bytes and load nothing from `/cdn-cgi/`.

- [ ] **Step 7: Deploy, then set the secrets**

```bash
pnpm build:css
pnpm exec wrangler deploy -c apps/sites/wrangler.jsonc
openssl rand -base64 32 | pnpm exec wrangler secret put IP_HASH_KEY -c apps/sites/wrangler.jsonc
```

Expected: the deploy prints the bindings, `*.$DOMAIN/*` and `$DOMAIN/*` under routes, and the cron `0 7 * * *`; the secret command prints that `IP_HASH_KEY` was uploaded (the value is generated and piped, never shown; piping is documented [verified: developers.cloudflare.com/workers/wrangler/commands/workers/ "The put command can also receive piped input"]). The secrets are set after the first deploy because the Worker must exist first; until then the form answers 503 and there are no sites, so nothing is exposed.

- [ ] **Step 8: Resend (the user, in the Resend dashboard)**

Add the domain `mail.$DOMAIN`, then add the records it shows in Cloudflare DNS as **DNS only**: `MX send.mail`, `TXT send.mail` (SPF) and `TXT resend._domainkey.mail` (DKIM) [verified: resend.com/docs/knowledge-base/cloudflare; for a subdomain the names become `send.<subdomain>`]. Wait for "Verified", then add `TXT _dmarc` = `v=DMARC1; p=reject; sp=reject;` (DNS only): only `mail.$DOMAIN` sends mail, signed by Resend's DKIM key for that same name, so our mail passes DMARC and anyone else sending as `billing@$DOMAIN` or `support@<slug>.$DOMAIN` is rejected [inferred: DKIM `d=mail.$DOMAIN` aligns with the From address `@mail.$DOMAIN`; Step 11 checks `dmarc=pass` on a real email]. Create an API key with "Sending access" for this domain only, then:

Run: `pnpm exec wrangler secret put RESEND_API_KEY -c apps/sites/wrangler.jsonc`
The user pastes the key at the hidden prompt. It never goes into chat, a file or `vars`.

- [ ] **Step 9: Abuse and security mail (Cloudflare Email Routing, free)**

Enable Email Routing for the zone (it adds its own apex `MX` and `TXT` records, listed in `deploy/dns-records.json`), verify the user's inbox as a destination, and add the routes `abuse@$DOMAIN` and `security@$DOMAIN` to it.

- [ ] **Step 10: Checklist for Plan 4's admin Worker (Cloudflare Zero Trust → Access)**

Recorded here because the design puts the runbook in Plan 2; Plan 4 deploys the admin Worker. Create a self-hosted Access application for `admin.$DOMAIN` path `*`; policy "Allow" for the admin email list only; identity provider Google or GitHub with MFA (§12.5); copy the application's AUD tag into `ACCESS_AUD` and `https://<team>.cloudflareaccess.com` into `ACCESS_TEAM_DOMAIN` of `apps/admin/wrangler.jsonc`; keep `ADMIN_AUTH_MODE` = `access` (Plan 4's config test forbids `dev`).

- [ ] **Step 11: Smoke test on the real edge**

```bash
curl -sI "https://$DOMAIN/" | grep -iE '^HTTP|strict-transport|x-robots-tag|content-security-policy'
curl -s "https://$DOMAIN/.well-known/security.txt"
curl -sI "https://www.$DOMAIN/anything" | grep -iE '^HTTP|^location'
curl -sI "https://nobody-here.$DOMAIN/" | grep -iE '^HTTP|x-robots-tag'
```

Expected: `HTTP/2 200`, `strict-transport-security: max-age=31536000; includeSubDomains`, `x-robots-tag: noindex` and the page CSP; the security.txt with `Contact: mailto:security@$DOMAIN` and the Step 4 date; `HTTP/2 301` with `location: https://$DOMAIN/`; `HTTP/2 404` with `x-robots-tag: noindex`. No certificate error: Universal SSL covers the apex and first-level subdomains [verified, design §1.1].

Then a temporary test site, published and approved through the real publishing functions against the production D1 and R2, with one photo, search engines off, and the lead going to the user's own inbox. It uses `cleaning-minimal` (no made-up licence or reviews) plus a sample photo:

```bash
MY_EMAIL=you@example.com   # the user's own inbox
pnpm build:css
node apps/sites/dev/seed.ts --remote --root "$DOMAIN" --slug smoke-test --fixture cleaning-minimal --hero-photo --noindex --owner-email "$MY_EMAIL" | tail -1
```

Expected: `{"siteId":"…","url":"https://smoke-test.$DOMAIN/","created":true}`. Copy the id: `SITE=<the printed siteId>`. The seed reaches the production D1 and R2 through wrangler's remote bindings (Decision 32) [unverified until this runs; rehearsed locally without `--remote` in Task 16 Step 4]. If it fails, stop and report its output. Do not insert rows or upload objects by hand instead: the Worker serves a page only when the object's metadata names D1's live version (Decision 24), and `wrangler r2 object put` cannot set that metadata [verified: `wrangler r2 object put --help` 4.138.0].

```bash
pnpm exec wrangler d1 execute asksite --remote -c apps/sites/wrangler.jsonc --command "SELECT action FROM audit_log WHERE site_id = '$SITE' ORDER BY id"
curl -sI "https://smoke-test.$DOMAIN/" | grep -iE '^HTTP|x-robots-tag|cache-control'
PHOTO=$(curl -s --compressed "https://smoke-test.$DOMAIN/" | grep -o "https://media\.$DOMAIN/[0-9a-f-]*/[0-9a-f-]*\.webp" | head -1); echo "$PHOTO"
curl -sI "$PHOTO" | grep -iE '^HTTP|content-type|cache-control'
```

Expected: the audit rows `version.requested` and `version.approved`, one each (production D1 writes the `INSERT … WHERE changes() = 1` audit rows as local D1 does, Decision 11); the page `HTTP/2 200`, `x-robots-tag: noindex` (approved with `--noindex`), `cache-control: public, max-age=60`; the photo's `https://media.$DOMAIN/…webp` address; the photo `HTTP/2 200`, `content-type: image/webp`, `cache-control: public, max-age=86400, s-maxage=300`.

Visitors must get exactly the approved bytes, with nothing injected (Step 6):

```bash
pnpm exec wrangler d1 execute asksite --remote -c apps/sites/wrangler.jsonc --command "SELECT v.html_sha256 FROM sites s JOIN site_versions v ON v.id = s.live_version_id WHERE s.id = '$SITE'"
curl -s --compressed "https://smoke-test.$DOMAIN/" | shasum -a 256
curl -s --compressed "https://smoke-test.$DOMAIN/" | grep -c '/cdn-cgi/'
ASKSITE_SMOKE_URL="https://smoke-test.$DOMAIN/" pnpm exec playwright test -c apps/sites/e2e/smoke.config.ts
```

Expected: the same 64-character hash from D1 and from `shasum` (the edge served exactly the bytes the admin approved); `0`; `1 passed` (in a real browser with real TLS the photo loads under the production CSP, zero CSP violations, nothing requested from `/cdn-cgi/`). If the hashes differ or `/cdn-cgi/` appears, a zone feature is rewriting pages: find it in Step 6's list, turn it off and repeat. Never invite an owner while pages are rewritten.

The contact form and the lead email:

```bash
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" -X POST -H 'content-type: application/x-www-form-urlencoded' --data 'name=Smoke+Test&phone=5125550100&email=&service=&message=Deploy+smoke+test&website=' "https://smoke-test.$DOMAIN/_f/$SITE"
sleep 10
pnpm exec wrangler d1 execute asksite --remote -c apps/sites/wrangler.jsonc --command "SELECT email_status, email_error FROM leads WHERE site_id = '$SITE'"
```

Expected: `303 https://smoke-test.$DOMAIN/_f/$SITE/sent`; the lead row `email_status: sent` (the email is sent just after the 303, hence the pause); the email "New request from your website: Smoke Test" arrives in `$MY_EMAIL`, and its original headers (for example Gmail's "Show original") show `dkim=pass` and `dmarc=pass` for `mail.$DOMAIN` (Step 8's `p=reject` is then safe; if not, set `_dmarc` back to `v=DMARC1; p=none;` and report).

Now the takedown timing on the real edge (Decision 7; design §7.3 asks for proof within 5 minutes):

```bash
pnpm exec wrangler d1 execute asksite --remote -c apps/sites/wrangler.jsonc --command "UPDATE sites SET taken_down_at = 1 WHERE id = '$SITE'"
for i in $(seq 1 12); do printf '%s ' "$(date +%T)"; curl -s -o /dev/null -w "page %{http_code} " "https://smoke-test.$DOMAIN/"; curl -s -o /dev/null -w "photo %{http_code}\n" "$PHOTO"; sleep 30; done
```

Expected: `page 404` within about 60 s and `photo 404` within 300 s of the update (edge TTLs 60 s and 300 s, per data centre). Record the times in the moderator's journal. If the photo is still 200 after 330 s, stop: the edge is not honouring `s-maxage` and the media cache rule must change before any real site goes live.

Clean up (removes every trace of the test site: its R2 objects, then its rows):

```bash
pnpm exec wrangler d1 execute asksite --remote -c apps/sites/wrangler.jsonc --json --command "SELECT 'asksite-live/' || slug || '.html' AS object FROM sites WHERE id = '$SITE' UNION ALL SELECT 'asksite-work/' || html_key FROM site_versions WHERE site_id = '$SITE' UNION ALL SELECT 'asksite-media/' || site_id || '/' || id || '.webp' FROM uploads WHERE site_id = '$SITE'" > .wrangler/smoke-objects.json
for object in $(node -e 'for (const row of JSON.parse(require("node:fs").readFileSync(".wrangler/smoke-objects.json", "utf8"))[0].results) console.log(row.object)'); do pnpm exec wrangler r2 object delete "$object" --remote -c apps/sites/wrangler.jsonc; done
pnpm exec wrangler d1 execute asksite --remote -c apps/sites/wrangler.jsonc --command "DELETE FROM audit_log WHERE site_id = '$SITE'; DELETE FROM leads WHERE site_id = '$SITE'; DELETE FROM site_versions WHERE site_id = '$SITE'; DELETE FROM uploads WHERE site_id = '$SITE'; DELETE FROM sites WHERE id = '$SITE'; DELETE FROM owners WHERE email = '$MY_EMAIL' AND id NOT IN (SELECT owner_id FROM sites);"
rm .wrangler/smoke-objects.json
```

Expected: `Deleting object "…" from bucket "…".` and `Delete complete.` for each of the three objects (the page in `asksite-live`, its stored version in `asksite-work`, the photo in `asksite-media`), then `🚣 6 commands executed successfully.`; afterwards `https://smoke-test.$DOMAIN/` answers 404. (This step was rehearsed against `pnpm dev` while revising this plan, with `--local --persist-to .wrangler/state` instead of `--remote`, `localhost:8789` as the domain and `curl -k`: the seed, the two audit rows, the page and photo headers, the equal hashes, `0`, `1 passed`, the 303 and `sent`, and the cleanup all behaved as written. HTTP/2, real TLS, the edge cache timing, Resend delivery and DMARC can only be seen on the real edge.)

If any smoke check fails: `pnpm exec wrangler rollback -c apps/sites/wrangler.jsonc` returns to the previous version (none on the first deploy: then remove the routes in the dashboard), and report to the moderator with the failing command and output.

- [ ] **Step 12: Before the first real owner is invited**

Upgrade to Workers Paid ($5 per month; design §1.4: Free allows 100,000 requests a day for the whole account and 10 ms CPU). Whether the Rate Limiting binding works on Free is not documented [unverified, design §1.3]: after the upgrade, submit the form six times in a minute from one address to the smoke-test site (recreate it as in Step 11, and clean it up again) and expect `429` on the sixth. Move Resend to Pro before about 20 live sites (§7.6). Plan 4's first production approval is the moment to check the other half of Decision 11 on the real D1: approving the same version twice (the retry path) must leave exactly one `version.approved` audit row.

- [ ] **Step 13: Commit the production config**

```bash
git add apps/*/wrangler.jsonc
git commit -m "Set production config"
```

This commits every Worker config Step 4 changed (the domain and database id are not secrets). The moderator pushes.

security.txt stops being valid at `$EXPIRES` (Step 4, one year ahead), and nothing renews it by itself. Put a reminder in the user's calendar 30 days before that date: rerun Step 4's `EXPIRES` lines, `pnpm deploy:check`, Step 7's deploy, and commit (the moderator records the date in `docs/context.md`).

---
## Verification record (how this plan was checked before handing it over)

- **Drafting (2026-09-24):** every file was written and run in a scratch clone (`…/scratchpad/plan2-draft`), then replayed task by task into a fresh clone (`…/scratchpad/plan2-replay`) on Plan 1 Tasks 1–14 at `24441ed` plus Tasks 15–17 from Plan 1's own replay. An execution checker then ran all 18 local tasks as written (every red run failed and every green run passed with the stated counts, also on Node 24.21.0), and a security/spec reviewer read the plan against the design; their findings produced Decisions 24–33 and the fixes listed with them.
- **Final replay (2026-09-25, this version):** a fresh `git clone` of the repo at `plan1-renderer` `77f01b6` (Plan 1 Tasks 1–17 as committed, with Plan 1's own screenshot baselines), `main` pointed at it, A6 simulated in the clone's `.superpowers/sdd/plan-decisions.md`. A script took every file, "replace … with …", append and command of Tasks 1–18 straight from the plan's markdown and ran them in order; commits were staged instead (this session may not commit), and browsers came from a scratch folder instead of `pnpm e2e:install`. Node 25.6.1, pnpm 10.33.0, wrangler 4.138.0, at load averages of 60–330 (other sessions). Before you start: every check as written, except `A6_RECORDED` (A6 is not yet recorded in the real repo, so the step correctly stops). P = 23, T = 555.
  - Every red run failed for the stated reason and every green run matched the stated counts: 25 / 569 after Task 1; 31 / 670 then 2 / 14 after Task 6; 37 / 724 then 11 / 96 after Task 14; 41 / 743 then 11 / 96 after Task 17; typecheck exit 0 each time; golden files unchanged; the leftover check printed `nothing left running` after every task and nothing unstaged was left.
  - Plan 1's browser tests with every Plan 2 change and Plan 1's real screenshot baselines: Task 6 Step 6 got `123 passed`, `24 skipped`, `1 failed` (roofing-extreme's two-pass axe test on `chromium-390` hit Playwright's 30 s timeout at 31.7 s under load); the same test alone, by Task 6 Step 6's rerun command, passed in 5.8 s; Task 18's `pnpm check` then got `124 passed`, `24 skipped`.
  - Sites browser tests: `54 passed` twice (Task 16 Step 3 and Task 18 Step 1), and once more on Node 24.21.0 (the CI version), where typecheck and `pnpm test` (41 / 743, 11 / 96) also passed. Task 16 Step 2's deliberate break: `4 failed`, `1 passed`, each failure at the photo check. Task 16 Step 4 smoke rehearsal: `1 passed`.
  - Task 15 Step 5: `created …`, `Ready on`, the seed line, `page 200`, `apex 200`, `unknown 404`, `photo 200 image/webp`, `form 303 …/sent`, the outbox row. In a pseudo-terminal with a fresh state, `dev.ts` as written applied the pending migration and reached `Ready on`; with stdin inherited instead, it stopped at the question with `failed with exit code 1`.
  - Task 18: all nine breakages failed exactly the named test (M7 with `error TS2339: Property 'put' does not exist on type 'Pick<R2Bucket, "get" | "head">'` and `tsc exit 1`), each checkout restored the file; Step 3 printed exactly the eight lines; Step 5 printed `identity ok`, `no attribution`, `messages ok`, `no secret files`.
  - The prose claims that certain tests catch certain faults were re-proved by breaking the code: D1 read before R2 in the page, photo and form routes (each fails its "never asks D1" test), no catch-all in `fetch` (fails "answers our 503 page … when D1 fails while storing the lead"), and no cap check inside the publish batch (fails "stays exact when requests race").
  - Task 19 Step 11 rehearsed against `pnpm dev` (`--local --persist-to .wrangler/state` for `--remote`, `localhost:8789` for the domain, `curl -k`): apex 200 with CSP and noindex, security.txt, www 301, unknown 404, the seed, the two audit rows, page and photo headers, equal hashes from D1 and `shasum`, `0` `/cdn-cgi/` matches, the browser smoke check `1 passed`, the 303 and `email_status: sent`, the page 404 about 60 s after the takedown, and the cleanup (three objects deleted, `6 commands executed successfully`, then 404). HTTP/2, real TLS, the edge cache timing, Resend delivery, DMARC and remote bindings can only be seen on the real edge.
- Facts checked on 2026-09-24 and 2026-09-25: `npm view` for every pinned version; the wrangler 4.138.0 type definitions for `createTestHarness` (`root`, `workers[].configPath|config`, `vars`, `secrets`, `getWorker().getEnv()`, `applyD1Migrations`, `scheduled`) and `getPlatformProxy` (`persist.path`, remote bindings); `wrangler dev --help` and `wrangler r2 object put --help`; Resend's send-email and Cloudflare DNS pages; Cloudflare's Cache API, Cache-Control (`no-transform`: "Does not transform body", "Compression is disabled when the `no-transform` directive is present"), D1 limits ("processes queries one at a time", "approximately 1,000 queries per second", "overloaded", 10 GB), Email Address Obfuscation and JavaScript Detections pages (quotes in Decision 24 and Task 19 Step 6, re-read 2026-09-25); Playwright 1.63's `gracefulShutdown` and task order; the three GitHub Actions' tags (`git ls-remote`, including `pnpm/action-setup`'s annotated tag) and `action.yml` inputs; licences: wrangler "MIT OR Apache-2.0" (the workers-sdk repo's LICENSE-MIT and LICENSE-APACHE read), @cloudflare/workers-types "MIT OR Apache-2.0" (its npm package ships no LICENSE file; the workerd repo's LICENSE is Apache-2.0). Both are development tools only; nothing from them ships inside a customer page.
- Measured: the `asksite-sites` bundle is 796.42 KiB raw / 128.01 KiB gzip (Workers limits: 3 MB compressed on Free, 10 MB on Paid [verified, design Appendix A]); most of it is zod, which `@asksite/core` imports.

## Known limits and open items (for the moderator)

- **Design deviations to accept or change:** Decisions 2 (explicit error fields; Plan 3's `ProviderError` needs the same), 3 (`restore` takes `ROOT_DOMAIN`), 4 (hand-written `Env`), 5 (`tsconfig.workers.json`; Plan 3 adds `packages/generation` to both tsconfig lists), 6 (`pnpm dev` strips routes), 9 (`SECURITY_TXT_EXPIRES`), 10 (`createPendingVersion` guards), 13 (the form also strips invisible formatting characters), 15 (no app link in the lead email), 24 (R2 before D1: design §7.3's order reversed), 25 (daily publish cap: a new `LIMITS` key and error code), 26 (catch-all 503; lead email after the response), 27 (`ipRateKey`), 28 (`site_not_found`), 29 (`restore` takes `MEDIA`, returns `missingPhotos`), 30 (LogMailer only in development), 31 (generic Vitest globs), 32 (`dev:seed --remote` for the smoke test), 33 (30 s unit-test timeout). Folding 24, 25, 28 and 29 into the design (§4.5, §7.2, §7.3, LIMITS) is the moderator's call.
- **For the moderator, outside this file** (this plan may not change other plans or Plan 1's code):
  - Plan 3 Step 3 (current draft): drop its `vitest.config.ts` half. Stage 0's globs already cover `apps/generator/test` and `packages/generation/test`; its shown file lacks the unit project's `testTimeout: 30_000` (Decision 33), and its `grep` for `apps/generator/test/**` globs would push an implementer to edit the file anyway. Its `tsconfig.json` half stays (a targeted `include` edit). It also names Stage 0's Vitest task as "Task 1"; it is Task 5.
  - Plan 4: map `publish_cap_reached` to `429 rate_limited` with `Retry-After`, `site_not_found` to `404 not_found`, show `restore`'s `missingPhotos` to the admin, and key `AUTH_RL` on `ipRateKey` (Decisions 25, 28, 29, 27).
  - Plan 1 (proposals; each changes Plan 1's files, so each is the moderator's decision): give the phone input `pattern="[0-9+().\- ]{7,30}"` so the browser catches what the server's 400 page would (the security review's minor 9; it changes the golden files); write the U+200D inside the regex at `packages/site-schema/src/facts.ts:24` as `\u200D` so a copy cannot silently lose it (minor 4); an explicit timeout on the slow property test (Decision 33); a longer Playwright timeout (or fewer parallel workers) for the two-pass axe test, which took 31.7 s on `roofing-extreme` at `chromium-390` under heavy load (Task 6 Step 6).
  - Record amendment A6 in `.superpowers/sdd/plan-decisions.md` before Task 1 (Before you start, Step 1 stops without it).
- **Not verified until Task 19:** anything about the real edge: the Cache API honouring `s-maxage` and 60 s/300 s spreads, TLS on subdomains, HSTS, the rate-limit binding on the chosen plan, Resend delivery and DMARC alignment, the seed's remote bindings (Decision 32), and whether any zone feature rewrites pages (Step 6's list; Step 11 compares the served bytes' hash with the approved one). Task 19 Step 11 measures each.
- **CI** has never run on GitHub [unverified]. Plan 1's browser tests have only run on macOS; on Linux they run with `--ignore-snapshots`. The workflow adds the e2e hostnames to `/etc/hosts` so WebKit resolves `*.localhost` on Linux [inferred: Chromium resolves `.localhost` itself; glibc may not]. `pnpm/action-setup` is pinned to the commit its annotated v6.1.0 tag points at [verified with `git ls-remote`]; that GitHub runs it is [unverified] until the first push.
- **P and T** (Plan 1's final totals) were 23 and 555 at `77f01b6`; Plan 1's Task 18 may still change them, so every full-suite expectation stays relative to them.
- **Fixed ports:** `pnpm dev`, the sites browser tests and the smoke rehearsals use ports 8789 and 9239, so two sessions cannot run them at the same time (each step that starts one checks the ports first).
- **The contact form's 50-a-day cap** can be used up by someone with many addresses (accepted in design §7.5 for the pilot). Spam-flagged leads count toward it although the owner's Leads page lists only `spam = 0` (design §4.4): kept on purpose, because not counting them would let one sender store unlimited rows a day (the class of problem Decision 25 fixes); Plan 4 could show a count of hidden spam. Honeypot effectiveness against real bots is untested.
- **No zone rate-limiting rule.** The review suggested one as optional. With Decision 24, requests for unknown hostnames and photos cost R2 reads, not D1 capacity; requests for a real live page are cached per data centre; a flood of real-site form posts from many addresses still reaches D1 (one read and one conditional insert each, `FORM_RL` per address). A Cloudflare rate-limiting rule on `/_f/*` is a later hardening step [unverified: the rule limits of the chosen Cloudflare plan].
- **Unapproved photos** are reachable by their two-UUID address (design §7.3, accepted).
- **Owner-facing emails** other than the lead email (invite, magic link, review result, site notice, admin alert) are Plan 4's; publishing sends none.
- **The user's open question** ("can we use a Hugging Face or other open-source model instead of Anthropic; would we have to deploy it?") is answered in design §6.6 and belongs to Plan 3; this plan does not touch generation.
