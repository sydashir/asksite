# asksite system design: everything after the renderer

Date: 2026-09-24. Written for the writers of Plans 2, 3 and 4. They write in parallel, so every name, type, endpoint, key and error code here is the contract. If a plan needs to change one, the moderator decides and this file is updated. Plans do not make their own changes to it.

Inputs read: `CLAUDE.md`, `docs/context.md`, `docs/session.md`, Plan 1 (`docs/superpowers/plans/2026-09-23-renderer-core.md`: Global Constraints, Decisions 1–21, Task 10/13/14 interfaces), `.superpowers/sdd/plan-decisions.md` (A1–A5, binding), and the code on branch `plan1-renderer` at `66fea1d` (`packages/site-schema`, `packages/renderer`).

What the labels mean:
- **[verified]**: checked on 2026-09-24 against the official page named in Appendix A, or by running it.
- **[inferred]**: reasoned from verified facts; not measured.
- **[unverified]**: not confirmed. Each one is assigned to a plan task that must check it.

Design decisions carry no label. They are decisions, not factual claims.

---

## 0. Decisions on one screen

1. **Four Cloudflare Workers:**
   - `asksite-sites`: public site pages, photos and contact forms.
   - `asksite-app`: the owner app (React single-page app on Workers Static Assets) plus the owner API.
   - `asksite-admin`: the admin single-page app plus the admin API, behind Cloudflare Access.
   - `asksite-generator`: a queue consumer that calls the model.

   They share one D1 database (`asksite`), three R2 buckets (`asksite-live`, `asksite-work` and `asksite-media`) and one queue (`asksite-generation`). There is no KV.
2. **The human approval rule is enforced by infrastructure.** Only `asksite-admin` writes to the `asksite-live` bucket. `asksite-sites` is bound only to `asksite-live` (pages) and `asksite-media` (photos); it has no binding to `asksite-work`, where unapproved page versions live. Nothing unapproved can reach a customer hostname, so "noindex until approved" holds automatically. **D1 decides what is served; R2 only holds bytes:** on a cache miss the sites Worker serves a page only when D1 says the site is live and not taken down (§7.3), so a takedown or a search-engine switch takes effect from one D1 write, whatever order the R2 writes happen in. As an extra safety, everything except an approved, indexable page is sent with `X-Robots-Tag: noindex`.
3. **Three layers kept apart:** owner facts (`Facts`), AI output (`AiDraft` = copy + layout + theme) and owner edits (`OwnerEdits`, a patch). The page document is always rebuilt with `composeDocument()` and validated by Plan 1's `SiteDocument`.
4. **Owner edits follow every Plan 1 copy rule** (caps, no digits, currency, `@` or links, Latin script only, no hidden characters, NFKC, claim checker). They are escaped exactly like AI copy, because they are copy.
5. **Owner-hidden sections** need one additive Plan 1 amendment (A6, §2.3): `SiteDocument.hidden`. It is set only by the owner and never appears in AI output. The AI layout must still list every section that shows owner facts (Decision #16 is unchanged).
6. **The owner always gets a valid first draft.** If the model is disabled, over the daily model limit, failing, producing invalid output or its job crashed, the first generation falls back to a deterministic template draft, clearly labelled. A regeneration never falls back; it fails and leaves the current draft alone.
7. **Model provider is pluggable** (`anthropic` | `openai-compatible` | `fake`). `openai-compatible` reaches Cloudflare Workers AI, Groq, Together, OpenRouter and the Hugging Face router. None of these needs us to deploy a model server (§6.6). The default is chosen by Plan 3's measured evaluation. That is the user's call (§12).
8. **Auth:** random single-use tokens, stored only as hashes, and delivered in the URL fragment for both invites and magic links. Both are **always emailed** and never shown to an admin, so using one proves control of the owner's email (the address leads are sent to). Using a token always takes a click (a POST), never a page load. No passwords. Owner sessions use a `__Host-` cookie backed by D1. Admins go through Cloudflare Access, and the Worker also verifies the Access JWT.
9. **Email: Resend** behind a `Mailer` interface. Cloudflare Email Service sending is still labelled Beta.
10. **Images:** the Cloudflare Images binding re-encodes every upload to a still WebP (1600 px maximum, animation dropped). WebP output drops all metadata, including GPS. Only the re-encoded file is stored, in its own bucket.
11. **Owner app frontend:** React 19.3.0, Vite 8.3.1, `@cloudflare/vite-plugin` 1.59.0, react-hook-form 7.88.0 and zod 4.6.5. The live preview runs Plan 1's pure `render()` in the browser inside a sandboxed `srcdoc` iframe. The API uses Hono 4.13.9.
12. **Build order:** Stage 0 (shared contracts, one small step) → Plans 2, 3 and 4 in parallel → integration end-to-end tests, security review and a deploy to the user's account.

---

## 1. Components and where each runs

### 1.1 Hostnames and routing

`<root>` is the product domain. The user has not chosen it yet (§12). The Worker variable `ROOT_DOMAIN` holds `host[:port]`: `asksite.example` in production and `localhost:8789` locally.

| Hostname | Served by | Purpose |
|---|---|---|
| `<slug>.<root>` | `asksite-sites` | the approved page at `/`, plus the form endpoint `/_f/<siteId>` |
| `media.<root>` | `asksite-sites` | processed photos: `/<siteId>/<uploadId>.webp` |
| `<root>` (apex) | `asksite-sites` | fixed placeholder page with the abuse contact, and `/.well-known/security.txt` |
| `www.<root>` | `asksite-sites` | 301 redirect to the apex |
| `app.<root>` | `asksite-app` | owner single-page app and `/api/*` |
| `admin.<root>` | `asksite-admin` | admin single-page app and `/api/admin/*`, behind Cloudflare Access |

- **Routing uses Workers Routes only.** Routes are `*.<root>/*` and `<root>/*` for `asksite-sites`, `app.<root>/*` for app and `admin.<root>/*` for admin. Custom Domains are not used. Reasons:
  - Custom Domains do not support wildcards. [verified]
  - The docs say routes "take precedence if configured on the same hostname" as a Custom Domain, so a wildcard route could shadow one. [verified: quote; exact wildcard-vs-custom-domain behaviour is not documented]
  - "When more than one route pattern could match a request URL, the most specific route pattern wins" (`www.example.com/*` beats `*.example.com/*`). [verified]
- **DNS records** (all proxied): `*` AAAA `100::` and the apex AAAA `100::`. Cloudflare documents `100::` as the placeholder for Workers without an origin. [verified] Proxied wildcard records are available on all plans. [verified]
- **TLS:** Universal SSL covers the apex and first-level subdomains, not deeper ones. [verified] That is why sites are `<slug>.<root>` and there is no `staging.<root>` tier (§10.4).
- **Every Worker sets `"workers_dev": false` and `"preview_urls": false`.** Both keys exist in wrangler 4.138.0. [verified: wrangler config types] Otherwise the admin Worker would be reachable on `*.workers.dev`, outside Access.
- **Reserved slugs** can never be site names: `www`, `app`, `admin`, `media`, `api`, `mail`, and the rest of the list in §2.8.
- **Every DNS label that gets its own record must be a reserved slug first.** A name with any explicit record (even only MX or TXT) is no longer covered by the `*` wildcard, so a site with that slug would have no address. Resend's domain setup adds MX and TXT records at `send` and an optional MX at `inbound`, plus TXT at `resend._domainkey` [verified: Resend "Cloudflare" guide]; `send` and `inbound` are therefore reserved. Send mail from a subdomain (`MAIL_FROM` on `mail.<root>`, which Resend recommends to isolate sending reputation [verified: Resend domains docs]); its records then sit under `mail`, which is reserved. The deploy runbook (Plan 2) lists every DNS record and a test checks each label against `RESERVED_SLUGS`.

### 1.2 Workers

| Worker (directory) | Plan | Handlers | Bindings |
|---|---|---|---|
| `asksite-sites` (`apps/sites`) | 2 | `fetch`, `scheduled` (daily cleanup) | `DB`, `LIVE` and `MEDIA` (reads only; a test fails if `apps/sites` source calls `put` or `delete` on either), `FORM_RL`; **no `WORK` binding**; secrets `RESEND_API_KEY`, `IP_HASH_KEY` |
| `asksite-app` (`apps/app`) | 4 | `fetch` (Static Assets + `/api/*`), `scheduled` (session and token cleanup) | `DB`, `WORK` (version HTML), `MEDIA` (writes uploads), `GEN_QUEUE` (producer), `IMAGES`, `AUTH_RL`, `API_RL`, `UPLOAD_RL`; secrets `RESEND_API_KEY`, `IP_HASH_KEY` |
| `asksite-admin` (`apps/admin`) | 4 | `fetch` (Static Assets + `/api/admin/*`) | `DB`, `WORK` (reads versions), `LIVE` (the only writer), `MEDIA` (deletes on a takedown with purge), `ADMIN_RL`; secret `RESEND_API_KEY` |
| `asksite-generator` (`apps/generator`) | 3 | `queue` (consumes `asksite-generation`), `scheduled` (sweeps stuck jobs) | `DB`; **no `AI` binding** (Workers AI is called over HTTPS through the `openai-compatible` provider, §6.2; the binding has no local simulation and errors in `wrangler dev` unless marked remote [verified: "Development & testing" docs]); secrets `ANTHROPIC_API_KEY` or `OPENAI_COMPAT_API_KEY` (only the chosen provider's) |

Non-secret variables per Worker are listed in §10.3.

Why four Workers and not one:
- **Least privilege.** The model key lives only in the generator. The live bucket is written only by admin. The public sites Worker has no upload, auth or model code.
- **Blast radius.** A bug in the owner API cannot publish a page.
- **Ownership.** Each plan owns its own Worker, so the parallel plans do not edit the same files.

Four Workers is well under the 100 (Free) and 500 (Paid) per-account limits. [verified]

Settings shared by every Worker:
- `"compatibility_date": "2026-09-21"`. This matches the workerd `1.20260921.1` that wrangler 4.138.0 ships. [verified: `npm view`]
- No `nodejs_compat`: the renderer and schemas use web APIs only. There are no `node:` imports in `packages/*/src`. [verified: grep]
- `"observability": { "enabled": true, "logs": { "invocation_logs": false } }`. The key exists in wrangler 4.138.0. [verified: config types] Invocation logs record "the Request, Response, and related metadata"; Cloudflare documents header redaction (`cookie`, names containing `auth`, `jwt`, `token`…) only for Tail Workers, not for invocation logs. [verified: Workers Logs and Tail Handler docs] So they could hold the session cookie, the Access JWT or a visitor's raw IP, and are turned off. Instead each Worker writes one structured log line per request (route id, status, duration, IDs, error code). Logs may contain IDs and error codes only. They must never contain tokens, emails, IPs, lead content or keys.

### 1.3 Storage choices, with verified limits and prices

**D1 (`asksite`) holds every record.**
- It is relational and consistent at the primary. `batch()` runs its statements as a transaction ("aborts or rolls back the entire sequence"). [verified]
- Conditional `UPDATE … WHERE` statements give us exact single-use tokens and exact cost caps.

| D1 | Free | Workers Paid |
|---|---|---|
| Reads (rows) | 5M per day | 25B per month included, then $0.001 per million |
| Writes (rows) | 100k per day | 50M per month included, then $1.00 per million |
| Storage included | 5 GB | (not checked) |
| Maximum database size | 500 MB | 10 GB |
| Queries per Worker invocation | 50 | 1,000 |
| Maximum row, string or BLOB size | 2 MB | 2 MB |

All figures [verified]. Location hint: create the database with `--location=enam`. Hints "are not guaranteed". [verified]

**R2 holds rendered HTML and photos.**
- Prices: storage $0.015 per GB-month; Class A (Put, List) $4.50 per million; Class B (Get, Head) $0.36 per million.
- Free each month: 10 GB-month, 1M Class A, 10M Class B.
- Egress and deletes are free.
- All figures [verified].
- Three buckets so the approval rule is enforced by bindings (§0.2):
  - `asksite-live`: only approved pages. Written only by admin.
  - `asksite-work`: every page version (pending, approved, old). Never bound to the public sites Worker.
  - `asksite-media`: processed photos. Written by app, read by sites, deleted by admin.

**KV is not used.**
- Changes "may take up to 60 seconds or more to be visible" elsewhere, and KV "is not ideal … where you need support for atomic operations". [verified]
- The free tier allows only 1,000 writes per day. [verified]
- Our routing needs no lookup table, because the R2 key is derived from the Host header.

**Queues carry generation jobs.**
- Available on Workers Free: 10,000 operations per day, messages kept 24 hours.
- Paid: 1M operations per month, then $0.40 per million, messages kept 4 days by default.
- One operation per 64 KB written, read or deleted.
- All figures [verified].

Why a queue:
- `ctx.waitUntil()` extends a request by only "up to 30 seconds" [verified], and a model call with retries can take longer.
- A queue survives the owner closing the tab.

**Workers Static Assets serve both single-page apps.** "Requests to static assets are free and unlimited." [verified] Limits: 20,000 files (Free) or 100,000 (Paid) per version, and 25 MiB per file. [verified]

**Workers Rate Limiting binding** (`ratelimits`) provides abuse throttles. `period` must be 10 or 60 seconds. Counts are "local to the Cloudflare location" and "permissive, eventually consistent". [verified] It is therefore never used for money or security guarantees; those are exact D1 counts. Whether it is available on the Free plan is not stated in the docs. [unverified] We use Paid anyway (§1.4).

### 1.4 Plan: Workers Paid ($5 per month) before the first real owner is invited

Workers Free is enough for local development and for the first deploy smoke test. Production needs Paid, for these reasons:

| Limit | Free | Paid |
|---|---|---|
| Requests | 100,000 per day for the whole account [verified]. A single traffic spike would take every customer site offline. | no daily limit |
| CPU per invocation | 10 ms [verified]. Parsing `SiteDocument` plus `render()` has not been measured inside a Worker. [unverified] | 30 s by default, up to 5 min [verified] |
| Subrequests | 50 per request | 10,000 per request [verified] |
| D1 queries per invocation | 50 | 1,000 [verified] |

Paid includes 10M requests and 30M CPU-ms per month, then $0.30 per million requests and $0.02 per million CPU-ms. [verified]

### 1.5 Running cost at pilot scale [inferred]

Assume 50 live sites, 5,000 page views per site per month and 20 leads per site per month.
- Requests: 250k page views + 500k photo requests + app, admin and form traffic come to about 1M per month. That is inside Paid's included 10M.
- R2: roughly 1M Class B operations, inside the free 10M.
- D1: tiny.
- Images: 50 sites × about 15 uploads is about 750 transformations. Free covers 5,000 unique transformations per month. After that it is $0.50 per 1,000 on the Images Paid plan; the Free plan returns error `9422` beyond 5,000. [verified]
- Email: about 1,100 per month. Resend Free covers 3,000 per month with a limit of 100 per day [verified], but the daily limit is shared by every email type, so plan on Pro ($20 per month) past about 20 live sites (§7.6).
- D1 reads also include one indexed read per site per data centre per minute of page traffic (§7.3): still tiny.
- Model: see §6.6.
- **Total fixed cost: about $5 per month (Workers Paid) plus model spend, and $20 per month for Resend Pro once the pilot grows past about 20 live sites.**

---

## 2. Data model

### 2.1 Three layers that never mix

| Layer | Who writes it | Stored as | Rules |
|---|---|---|---|
| Owner facts | owner (questionnaire and Details forms) | `sites.facts_json` (may be incomplete while drafting) | Plan 1 `Facts`: any script, not NFKC-normalised, hidden characters rejected |
| Brief | owner (tone, goal, notes, comments, review attestation) | `sites.brief_json` | `Brief` (§2.8). Sent to the model as data. Never rendered. |
| AI draft | generator only | `generations.output_json` | `AiDraft` = Plan 1 `Copy` + `Layout` + `Theme`; must pass `SiteDocument` with `hidden: []` |
| Owner edits | owner (editor) | `sites.edits_json` | `OwnerEdits` shape (§2.8); after composition, every Plan 1 `Copy` rule applies |
| Page document | nobody edits it; rebuilt on demand, and frozen only as a version snapshot (`site_versions.document_json`, parsed, §2.5) | `composeDocument(facts, ai, edits)` | Plan 1 `SiteDocument` (with A6) |

- The generator writes only `generations`. It never writes `sites`.
- The site's AI draft is the newest `generations` row for that site with `status = 'succeeded'`.

### 2.2 Owner-edited wording: which rules apply, and escaping

**Decision:** the composed copy must pass Plan 1's `Copy` schema and the `SiteDocument` checks unchanged. That means the 80/160/24/480/140/160/80/320 caps, the `FACT_LIKE` ban (no digits in any script, currency, `@`, `http:`, `https:` or `www.`), A1 (Latin, Common and Inherited scripts only), the letter rule (A9b, A9c, A9e, A9f, A9g; below), hidden-character bans (`\p{Cc}`, `\p{Cf}`, and `HIDDEN_IN_COPY`), NFKC, and the claim checker (`NEVER_IN_COPY`, and `NEEDS_A_FACT` backed by facts).

**Scope and standard (A9f, 2026-09-27):** the letter rule and the claim checker below apply only to copy (AI copy and owner copy edits), which is English marketing text. Facts (business names, places, testimonials, services) are never affected. The standard: no ordinary English marketing sentence is refused that main (acae4ab) accepts, English sentences with real proper names and places in any Latin orthography included (Hawaiian, Vietnamese, Spanish, Polish, Nordic, German, Azerbaijani names, GNIS names), and no look-alike claim that 3fc9a93 caught passes where catching it is cheap. Non-English running text, transliterations and IPA are accepted residuals (listed below); the approval screen is the backstop, and a claim message names the word that triggered it.

**Letter rule (changed by A9b, A9c, A9d, A9e, A9f and A9g, 2026-09-27):** copy refuses small capitals, which pass for A-Z letters (and, since A9g, the Latin epigraphic letters; below): every letter whose Unicode name says SMALL CAPITAL (UnicodeData.txt 18.0.0: 78 letters in IPA Extensions, the Phonetic Extensions and Latin Extended-C, -D, -E, -F and -G, the modifier small capitals included), so "ɪnsured", "ᴄertified" and "ʟɪᴄᴇɴꜱᴇᴅ" are refused. Every other Latin letter is allowed, phonetic letters included (A9e), because real names and places use them: "Bjørn", "Łukasz", "Straße", "Cœur d’Alene", "Hawaiʻi" (U+02BB ʻokina), "Oʼahu" (U+02BC), "Tiệm Giặt Sấy", "Saïd", the glottal stop of "dukMéʔem wáťa" (GNIS 260516), the schwa of "Wewətanagok" (GNIS 580743) and of Azerbaijani names ("Ayşən Əbdüləzimova"), the saltillo of "Chevak Cupꞌik" and the open e and open o of West African names ("Ofon Na Ɛdi Asɛm Fo", "Oberi Ɔkaimɛ"). The claim checker reads the look-alikes among them as the A-Z letters they look like (below), so "ꬶuaranteed" and "licənsəd" are claims. A9's rule that every letter be A-Z once its accents are removed, and A9b's rule that refused every letter of the phonetic blocks (it refused "Wewətanagok" too), are replaced. Accepted residual: a real name or title written with a small capital is refused ("Hrøríkʀ of Novgorod", "Naimángitsoᴋ' Petersen", IPA titles such as "/ɪ/": 164 of the 1,550,638 non-ASCII English Wikipedia titles, measured by A9e and again by A9f), and (A9f ruling) so are small capitals used as ordinary letters in living African and Indigenous orthographies (Kusaal, Fante and Dagaare ᴐ and ᴜ: "Ba mᴐri", "Ankara yᴜᴜm", "Dzin Pᴐtsee"; Dagbani and Ewe ᴐ for ɔ: "kᴐŋko", "Igbo (gbegbᴐgblᴐ)"; Gua ɪ: "àkpálɪ̀"; Wendat ᴕ: "oskᴕenha") and IPA pronunciations in a sentence ("Nguyen sounds like /wɪn/."). The `FACT_LIKE` ban also refuses the Latin letters that look like a digit (A9c, `DIGIT_LETTER` in copy.ts): those Unicode's confusables.txt (18.0.0) reads as a digit, such as "Ƨ", "Ʒ" and "Ƽ", the other case of each, which draws the same digit smaller ("ƨ", "ƽ", "ȝ", "ǯ"), and the letters named after one of them ("ƺ", EZH WITH TAIL); "Ỽ" and "ỽ" (U+1EFC and U+1EFD, MIDDLE-WELSH V; A9d), which draw as a 6 and a small 6 in all six theme font stacks but have no confusables.txt entry; and (A9e) the letters of the blocks A9e opens that draw as a digit: those whose confusables.txt skeleton holds a digit or one of those letters ("ᴈ", "ᴤ", "ɮ", "ʤ", "Ꜩ", "ꜩ"), the cuatrillo "ꜭ" and "Ꜭ", which NamesList.txt cross-refers to the digit four, and "Ꜣ", "ꜣ", "Ꝝ", "Ꝣ", "ꝸ", "ᵷ", "ᵹ", "Ꞁ", "ꭋ", "Ꟃ", "Ꟑ" and "ꟼ", which draw as a digit in the Unicode 18.0 code charts, the macOS theme fonts or Noto Sans and Noto Serif; and (A9f) "Ɥ" and "ɥ" (TURNED H), which draw like an open 4, the letters named after ɥ ("ʮ", "ʯ") and U+1DF3E BARRED TURNED H of Unicode 18.0 (confusables.txt: ɥ + U+0335). So "Call (ƧOȢ) ƼƼƼ-…", "Call (ƨƽƽ) ƽƽƽ-…", "Save ỼO% on drain cleaning", "Save ꜭO% today" and "Save ꞍO% on drain cleaning" are refused. Accepted residual: real words written with such a letter are refused too (Middle English yogh "Laȝamon", stylised "Merry Xmaƨ Everybody", the Egyptological alef of "Wꜣs-sceptre": 97 of the 1,550,638 non-ASCII English Wikipedia titles, 65 of them refused as a number since A9c and A9d, and all 97 refused before A9e; 105 since A9f, whose 8 more are IPA titles and single letters such as "/ɥ/" and "Ɥ (IPA)"). Measured by A9f on the 3,564,038 non-ASCII English Wiktionary titles (enwiktionary all-titles dump of 2026-09-02): 3,019 are refused as a number although main accepts them, by letter class ȝ Ȝ (Middle English yogh) 1,631, ꜣ Ꜣ (Egyptological alef) 988, ʒ Ʒ and the letters named after them (ezh: Laz, Skolt Sami, Dagbani and transcriptions) 162, ƨ Ƨ (the Zhuang tone letter) 76, ɜ and its kin (reversed open e) 12, ɥ Ɥ ʮ ʯ (A9f; IPA, Manta "mɥáà" and Bangime "ɥɛ̀") 9, ȣ Ȣ 3, and single letters of the other classes (a title can hold two classes). The A9e attack round also found Italian inclusive plurals with ɜ ("benvenutɜ") and Abenaki and Wendat words with ȣ in the French Wiktionary. Not caught (they pass at main too): ASCII "O" and "l" read as 0 and 1, and symbols that draw like a digit or "$": "⁊" (U+204A) for 7 ("Call l-⁊O⁊-…" reads "1-707-…" in five of the six theme font stacks, in Chromium and WebKit), and in WebKit "⧶" (U+29F6) and U+31C7 for 7, "℈" (U+2108) for 3, and "S" + U+20D2 for "$" ("Visits from S⃒five" reads "$five"); and, since A9e lets them into copy, the letters S with a stroke (U+A7A8-A7A9, U+A7C9-A7CA, U+A7CC-A7CD, such as "Ꞩ"), which can pass for "$" (the claim checker reads them as S). A9g: copy also refuses U+A7F7-A7FF, the Latin epigraphic letters ꟷ, ꟻ, ꟽ, ꟾ and ꟿ (UnicodeData.txt 18.0.0 names U+A7F7 and U+A7FB-A7FF LATIN EPIGRAPHIC LETTER: letters of ancient Roman and Celtic inscriptions), with the message "AI copy must use Latin script letters, not epigraphic letters such as ꟾ or ꟽ"; they have no use in English copy or real names, and ꟾ, which the claim checker reads as i or l, hid a claim when used both ways in one word ("ꟾꟾcensed"). The rest of the range is refused as before (ꟺ is a small capital, ꟼ looks like a digit), and NFKC turns ꟸ and ꟹ (superscript letters for IPA and UPA) into Ħ and œ first, so copy never holds a character of the range. The claim checker keeps their readings (harmless). Accepted residual: English Wikipedia and Wiktionary titles that are these letters themselves ("ꟾ", "Long ꟾ", "ꟿ."; 6 of the 1,550,638 unique non-ASCII English Wikipedia titles and 6 of the 3,564,038 unique non-ASCII English Wiktionary titles, all-titles dumps of 2026-09-04 and 2026-09-02, measured by A9g) are refused.

**Claim checker reading (A9, A9b, A9c, A9d, A9e, A9f, A9g):** the claim checker reads copy as typed and folded, and a claim any reading finds counts: as typed; and folded (`foldings` in lookalikes.ts): composed with NFC, every combining mark removed that is not part of a precomposed letter ("Licen" + U+0336 + "sed"), the look-alikes listed in `packages/site-schema/src/lookalikes.ts` read as the A-Z letters they look like ("lıcensed", "ƒree", "ŁICENSED", "ƜARRANTY" and, A9e, "ꬶuaranteed", "Ꝼree" and "ƐMERGENCY" are claims), and the click letters ǀ ǁ ǂ ǃ read as punctuation, never as letters ("ǀCertifiedǀ"). The typed reading runs first, then the folded one (A9c item 1 said "folded, then as typed"; the order only decides which spelling of a found word is shown, since a claim any reading finds counts; recorded by A9e). Reading it as typed too (A9b round 1) keeps every claim the checker found before A9, because the fold on its own joins words the page shows apart, such as "Top" + U+0336 + "rated". A9f: a letter that reads two ways is read both ways, each on its own, so the folded reading is made once for every combination of the two-way letters in the text (at most 8; 16 since A9g adds Ʋ, below): ʋ as v (like its capital Ʋ) or u (confusables.txt), ꞵ as b (like its capital Ꞵ) or ß, read "ss" (confusables.txt), and ꟾ (I longa) as i (its name) or l (confusables.txt), so "Fiʋe-star", "insʋred", "ꞵonded", "Licenꞵed", "Lꟾcensed", "cꟾock" and "ꟾnsʋred" are claims. A9f also reads ꟽ as w, ɘ as e, ᴉ as i, ꟻ as f and ʊ as u (with Ʊ as U and ᵿ as u, by the table's own rules), letters that draw like those A-Z letters though confusables.txt gives them no A-Z prototype ("ꟽARRANTY", "licɘnsɘd", "Lᴉcensed", "ꟻREE", "insʊred"), and ꟷ (U+A7F7 LATIN EPIGRAPHIC LETTER SIDEWAYS I, which draws as a dash) as an em dash, so "Awardꟷwinning" joins like "Award—winning". The A9f attack round found five more letters that draw like A-Z letters in all six theme font stacks (Chromium and WebKit render) and to which confusables.txt gives no prototype, and the claim checker now reads them too (A9f review round 1): ʗ (U+0297 STRETCHED C) as c, ʘ (U+0298 BILABIAL CLICK, an O with a dot) as o, Ꜧ and ꜧ (U+A726/U+A727 HENG; NamesList.txt cross-refers Ꜧ to Ⱨ) as H and h, and ɧ (U+0267 HENG WITH HOOK) as h; by the table's name rule, U+1DF0F (STRETCHED C WITH CURL) reads c, and copy's NFKC turns the modifier letters U+107B5, U+AB5C and U+10797 into ʘ, ꜧ and ɧ first. So "BʘNDED CREW", "Our ʗertified pros", "Aʗʗredited team", "Fully liʗensed", "Tɧousands served", "ꜦUNDREDS SERVED" and "Over ꜧundreds of homes" are claims. A9g: Ʋ, the capital of ʋ, reads both ways too, V by its name and U as it draws in all six theme font stacks, so "FULLY INSƲRED CREW", "GƲARANTEED WORK" and "HƲNDREDS SERVED" are claims. And four of the letters the table reads as A-Z letters also draw as punctuation or a symbol: ᴉ as "!", ʗ as "(", ʘ as "⊙" (its Unicode 1.0 name is LATIN LETTER BULLSEYE) and Ʊ as "℧" (confusables.txt reads ℧ as Ʊ). Read only as a letter, one glued to a claim word that carries a look-alike joined it and hid the claim, while the page showed "free!" or "(free)" (the A9f round-2 attack: 1,940 of 2,196 generated attacks passed at c76f761). So when the text holds one of them, every reading is made again with each of them read as a space, a word break (the attack's measured fix): "Estimates are ƒreeᴉ", "We are ƀondedᴉ", "ƱƑREE ESTIMATES", "Fully ƱŁICENSED", "Ask about our ʘƒree estimates" and "Estimates ʗƒree)" are claims. That makes at most 2^4 x 2 = 32 folded readings (16 for copy, which refuses ꟾ); the claim check of 36 fields (a page's most) of 480 characters each (more than any field but "about" holds), each holding all of these letters, takes about 42 ms in Node 25 on the development Mac (15 ms at c76f761; 21 ms without ꟾ), measured by A9g. The copy itself is never changed. Each of those readings is also read with every "_" as a space, and every symbol separator glued between two non-space characters as a space, before runs of whitespace are folded (`readings` in claims.ts, which generation's AI-only check uses too): "_" is a word character, so "Fully _insured", "Our _licensed_ crew" or "Award__winning" hid the claim word from every rule that needs a word boundary while the page shows it; the typed reading stays, so a pattern that matched through an underscore still does (2026-10-05). The glued symbols are a small named set: "·" (U+00B7 middle dot), "•" (U+2022 bullet), "~" (U+007E tilde), "*" (U+002A asterisk), "|" (U+007C vertical line), "∙" (U+2219 bullet operator), "・" (U+30FB katakana middle dot, which U+FF65 becomes under NFKC) and "●" (U+25CF black circle), so "Award·winning crew", "Same•day service", "Award∙winning crew", "Seven·days·a·week" and "After|hours cleaning" are claims like "Award winning crew", while "Plumbing · Austin", "Repairs | Installs" and "Fast • Friendly • Local" are not (M3, 2026-10-05). Named residual: a separator with a space on either side ("Award · winning", "Award ·winning") reads as a list, not one claim. "." "/" and ":" are not separators: "." ends a sentence (a full stop typed without its space, "the same.Day one", would read "same Day"), ":" introduces a list and "/" offers alternatives; "lic.", web addresses and "24/7" are kept by the typed reading (and copy bans digits).

Not caught (accepted residuals, with the approval screen as the backstop). Each of these attacks, from the A9b and A9c attack logs, passes at main (acae4ab) too, so none is a regression (recorded by A9d):
- a precomposed accented letter, read as typed, so a deliberately accented claim word is not caught, as before A9 (A9c): "lícensed", "frée", "Bónded", "LİCENSED", "Liceṅsed", "lịcensed", "Our Accreditėd crew";
- ASCII "l" or "|", or a click letter, used for "I" or "l": "CERTlFlED", "ǀicensed", "Estabǀished crew", "Save doǁars today", "Over a miǁion served", "ǀNSURED", "ǃNSURED CREW";
- a letter the table reads another way or does not list: þ reads "th", not "p" ("cheaþest", "comþlimentary"); Ɩ reads "I", not "l" ("Ɩicensed"); turned, reversed and open letters ("FrɅe"; since A9e lets the phonetic letters into copy, also "ɹated", "ɐward", "ɒward-winning", "bɔnded" and "ɔertified", which pass at main too) and the other look-alikes no rule derives ("Fully insᴗred" U+1D17, "ꞷarranty" U+A7B7, "ʃree quotes", "ʍillions served", "Ꜿertified", "Complimentarꝩ", "ꝭince"; all pass at main too; and ɞ and ʚ U+025E/U+029A for o, "Our bɞnded crew", ʬ U+02AC for w, "ʬarranty included", and ɿ U+027F for i, "Lɿcensed crew", which the A9f attack round rated weaker look-alikes than ʗ, ʘ and heng and left to the moderator; they pass at main too, and reading them would change no verdict in the A9f English corpora but those attacks); a combining Latin small letter used as a letter ("Lic" + U+0364 + "nsed"). "Ɛmergency" was here until A9e, which reads Ɛ as E, "insʊred", "ꟽARRANTY", "Lᴉcensed", "licɘnsɘd", "ꟻREE", "insʋred" and "cꟾock" until A9f, and "BʘNDED", "ʗertified", "Tɧousands" and "ꜦUNDREDS" until the A9f review round;
- a two-way letter used both ways inside one claim word: one reading reads every copy of a letter the same way (A9f record (b), confirmed by A9g). The case found, ꟾ for l and then i ("ꟾꟾcensed", "Estabꟾꟾshed"), no longer reaches a page: since A9g copy refuses ꟾ (letter rule above). ʋ and Ʋ keep the same limit, but no claim word the lists match holds both a u and a v. Also confirmed (A9f record (b)): ꞵ reads b or ß, which reads "ss", never a single s, so "Fully inꞵured" and "Five-ꞵtar service" pass, like "inßured", while "Licenꞵed" is a claim shown as "Licenssed";
- (A9g) a letter the table reads that draws as a letter, glued to a claim word that carries a look-alike, which joins the two: ɘ, ʊ, ꟻ and ꟽ ("Fully ɘlıcensed crew", "Our ʊƀonded crew"; "Fully ꟻlıcensed" and "Get a ꟽƒree quote" no longer reach a page, since copy refuses ꟻ and ꟽ), and the same for ᵿ, ɧ, ꜧ and Ɣ ("Fully ᵿlıcensed crew", "ɧƒree estimates", "ꜧƒree estimates", "Ɣƒree estimates"). The page shows an extra visible letter ("elicensed", "ubonded"), like ASCII "wfree" or "xlicensed", which no version catches; all pass at main too;
- (A9g) one of ᴉ, ʗ, ʘ and Ʊ used as a letter inside a claim word while another copy of one of them is glued to it: "Our ʗertifiedᴉ pros", "ʘbʘnded crew". The word-break reading reads every copy as a break and the letter reading every copy as a letter, so neither finds the claim; reading each copy both ways costs up to 128 readings (about 197 ms in the attack round's worst case). They pass at main too;
- the saltillo, which reads as an apostrophe (A9e), used for a letter: "ꞋNSURED" reads "'NSURED", as the ASCII apostrophe does at main (it draws as a raised tick, not an I);
- a symbol the table does not list: "fr℮℮" (U+212E), "L¡censed" (U+00A1), "seven days∕week" (U+2215), "INS℧RED" (U+2127 INVERTED OHM SIGN, which confusables.txt reads as Ʊ), "B⊙NDED CREW" and "Our b☉nded crew" (U+2299 ⊙, U+2609 ☉ and U+2A00 ⨀, which confusables.txt reads as ʘ; they pass at 3fc9a93 too);
- an overlay mark inside a claim word together with a listed look-alike glued to its end, which neither reading finds: "Bon" + U+0336 + "dedł crew", "Our Certi" + U+0307 + "fiedı crew", "Save dolla" + U+0336 + "rsı today";
- a claim word run into another word in CamelCase, read as typed, as before A9: "TopRated", "WeAreBonded", "TOPrated", "Top_Rated". A9c's CamelCase reading refused real names that main accepts, such as the official place name "McMillion Creek" (GNIS 1552041, read "Mc Million"), "FreeFlow Plumbing", "BondTech Roofing" and "StreakFree Window Cleaning", so A9d dropped it.
- (M3, 2026-10-05) a separator symbol (· • ~ * | ∙ ・ ●) with a space on either side between two claim words, which reads as a list, not one claim: "Award · winning crew", "Award ·winning crew". Only a symbol glued between two non-space characters ("Award·winning") is read as a space.

Refused although main accepts them (accepted residuals, recorded by A9e and A9f; the owner sees the message and rephrases):
- a name or title with a small capital or with a letter that looks like a digit (the letter rule above: "Hrøríkʀ of Novgorod", "kᴐŋko", "Laȝamon", "Merry Xmaƨ Everybody", "Wꜣs-sceptre", "Ɥ (IPA)");
- a straight-quoted phrase whose first letter is a look-alike, which the folded reading sees as a quote (since A9b): 'Crew lead "Łukasz" answers', 'FB "Łucznik" Radom', '"Đại Định"', 'National Library of Montenegro "Đurđe Crnojević"', and since A9e reads the other case of the letters it opened, 'Ask for "Əli"', 'The "Ɛdi" song', '"Əmək" ordeni'. The same phrase in ASCII ('"Lukasz"') is refused at main too, by the quote rule;
- (A9f ruling) words of other languages and transliterations that the folded reading turns into a claim word: Twi and Fante "frɛɛ" and "Wɔfrɛɛ no Kofi." ("free"), Dagbani and Kabiyè "saɣ", "Saɣ'tuliga" and "Serving homes near Saɣ'tuliga." ("say"), Azerbaijani "Əyn-Sincə" ("Since"), Hamer-Banna "bonɗá" ("bond"), the IPA "[ma.tsɯ.o ba.ɕoː]" (the web address "ba.co"). The claim message names the word;
- Middle English with þ, which reads "th" (since A9b; A9f keeps the reading): "Þursday", "þousand".

Reasons:
1. **Security on free subdomains.** A link-free, digit-free body stops an owner, or someone who hijacked an owner account, from planting "Call 1-800-…" or "paypa1-login.com" on a page served from our domain. The phone, email, prices and "Since" year shown on the page always come from facts, so they cannot drift from the facts the admin checked.
2. **One validation path.** Owner edits need no Plan 1 change.
3. **Honesty.** An owner who wants to say "licensed" adds the licence fact. The claim checker then allows the word, and the page shows the licence.

The cost of this decision: some honest phrases are blocked. Examples are "24/7" (the owner ticks the 24/7 fact, and the copy can say "around the clock"), "since 1998" (`yearFounded` renders "Since 1998"), "weekends" and "our customers say". The editor explains each block in plain words and links to the fact field that fixes it (§3.1). Relaxing the rules is listed as a user call (§12).

Composition changes to owner text, decided so the editor never fights the schema:
- `composeDocument` collapses every whitespace run in owner edit strings, including newlines, to one space. A textarea newline therefore becomes a space. Plan 1's `prose` rejects `\n`, because it is `\p{Cc}`.
- No other change is made. Invisible characters are still rejected with a message.

**Escaping:** owner edits are plain text, never HTML. They reach the page only through Plan 1's `html` template (`escapeText` for text, `escapeAttr` for attribute values). The owner app displays them only as React text nodes. `dangerouslySetInnerHTML` is banned by a lint rule in `apps/*`.

Owner facts keep the Facts rules: business names and pasted reviews may use any script and are not NFKC-normalised (Plan 1 Decision #19).

### 2.3 Owner-hidden sections: Plan 1 amendment A6 (additive)

This is executed in Stage 0 (§11), after Plan 1 merges. It touches only these files:

- `packages/site-schema/src/layout.ts`:
  ```ts
  export const HIDEABLE_SECTIONS = ["trust", "testimonials", "gallery", "about", "serviceArea", "faq"] as const;
  export type HideableSectionId = (typeof HIDEABLE_SECTIONS)[number];
  /** Sections the OWNER chose to hide. Never produced by the AI. */
  export const OwnerHidden = z
    .array(z.enum(HIDEABLE_SECTIONS))
    .max(HIDEABLE_SECTIONS.length)
    .refine((ids) => new Set(ids).size === ids.length, { error: "A section can be hidden only once" });
  ```
- `packages/site-schema/src/document.ts`: the `SiteDocument` object becomes `z.strictObject({ facts: Facts, copy: Copy, layout: Layout, theme: Theme, hidden: OwnerHidden.default([]) })`. The rest is unchanged: the `factSections` check still requires the layout to list every fact section, and A3's hero-photo override stays.
- `packages/site-schema/src/index.ts`: also export `HIDEABLE_SECTIONS`, `OwnerHidden` and `type HideableSectionId`.
- `packages/renderer/src/visibility.ts`: `visibleSections(doc)` also drops `s.id` when `doc.hidden.includes(s.id)`. Because the header navigation and FAQPage JSON-LD already follow `ctx.sections` / `isVisible`, hidden sections disappear from the navigation, and a hidden FAQ drops its JSON-LD. LocalBusiness JSON-LD is unchanged: hiding a section hides it, it does not delete facts.
- Tests:
  - a hidden section is gone from `<main>`, the navigation and (for FAQ) the JSON-LD;
  - `hidden: ["hero"]`, `["services"]` and `["contact"]` are rejected;
  - a duplicate id is rejected;
  - a document without `hidden` renders byte-for-byte the same as before. **All Plan 1 golden files must stay unchanged; this is the regression proof.**

Hero, services and contact cannot be hidden. The page must always say what the business does and how to reach it.

### 2.4 Looks

A look is a named Plan 1 `Theme` preset. It is defined in `@asksite/core/looks.ts`:

```ts
export const LOOKS = [
  { id: "classic", name: "Classic", theme: { palette: "navy-orange", font: "clean" } },
  { id: "bright", name: "Bright", theme: { palette: "blue-yellow", font: "friendly" } },
  { id: "outdoor", name: "Outdoor", theme: { palette: "green-amber", font: "sturdy" } },
  { id: "bold", name: "Bold", theme: { palette: "charcoal-red", font: "sturdy" } },
] as const satisfies ReadonlyArray<{ id: string; name: string; theme: Theme }>;
```

- The editor shows "Recommended for you" (the AI's theme) followed by the four looks. If the AI's theme equals one of the four, that card is marked "Recommended" and no duplicate card is shown.
- Picking a look sets `edits.theme`. Colour contrast is already proven for every palette by Plan 1 Task 7.

### 2.5 Draft, versions, live

- **Draft:** the site row's `facts_json`, `brief_json` and `edits_json`, plus the newest succeeded generation. Every draft write increments `sites.rev`, which gives optimistic concurrency. There is one draft per site. Drafts may be invalid while the owner is editing; validation issues are returned and shown, and publishing is blocked until they are fixed.
- **Version:** created when the owner clicks Publish. It is an immutable `site_versions` row plus the exact rendered HTML of each of its pages: **a version is 1 to 5 pages, Home first** (§2.9). WORK holds one object per page, at `versionPageKey` (§2.7). `site_versions.pages_json` (migration 0005) is `canonicalJson` of `[{ page, sha256 }]`, in page order, one `sha256` per page's exact bytes (`VersionPages`, `@asksite/core`); `html_sha256` is `pagesDigest` over every page, the SHA-256 of `canonicalJson` of those ids and hashes; `html_key` stays Home's WORK key. A row from before A16 holds `'[]'`, which `VersionPages` refuses, so such a version can never be approved or restored. **The admin approves those exact bytes, and the same bytes go live.** The approve request carries the `htmlSha256` (the digest) the admin was shown, and the server refuses if it no longer matches (§7.2).
- **Stored document:** `site_versions.document_json` is `canonicalJson` of the **parsed** `SiteDocument` (the `SiteDocument.safeParse(...).data` output: trimmed, NFKC-normalised copy, defaults filled, hero variant forced). `document_sha256` is `sha256Hex` of that string. The same function computes the draft's hash for "Unpublished changes", so whitespace-only or key-order differences never show as a change. `render()` re-parses the stored document; parsing a parsed document is a no-op [inferred: trim, NFKC and the hero overwrite are idempotent; Stage 0 adds a test on every Plan 1 fixture].
- **Live:** `sites.live_version_id`, plus in LIVE one **pointer** per site (the object at the bare slug, an empty object whose metadata names the live version) and immutable copies of that version's pages at `<slug>/<versionId>/<page>.html` (§2.7). The switch to a new version is **one pointer write, so all pages change together** and a visitor never sees two versions mixed (U2, user decision 2026-10-01). Pages are served only through the pointer and only while D1 says the site is live (§7.3).
- **Admin lease (A16-4c):** one admin action per site at a time. Migration 0006 adds `sites.admin_lock` (a random token) and `sites.admin_lock_until` (epoch ms), both NULL while no action runs. `approveVersion`, `takeDown`, `restore` and `copyLivePagesAgain` each take the lease for `ADMIN_LEASE_MS` (120 s), and §7.2 says how they use it.
- Display status is derived from these columns and never stored separately:
  - `live = live_version_id IS NOT NULL AND taken_down_at IS NULL`
  - `inReview = pending_version_id IS NOT NULL`
  - `takenDown = taken_down_at IS NOT NULL`

Version status transitions:

```text
pending --approve--> approved   (becomes sites.live_version_id; the previous live version stays "approved" as history)
pending --reject---> rejected   (with a note, emailed and shown to the owner)
pending --owner withdraws--> withdrawn
pending --owner publishes again--> superseded  (the new request replaces it; at most one pending version per site)
```

The slug can be changed only while `live_version_id IS NULL AND pending_version_id IS NULL`. After that it is locked, because the form action and the live pointer and page keys contain it.

### 2.6 D1 schema: `packages/core/migrations/0001_init.sql`

All times are Unix epoch milliseconds (`INTEGER`). All IDs are `crypto.randomUUID()`. Emails are stored trimmed and lower-cased. Money is stored as integer micro-US-dollars (µ$, 1 USD = 1,000,000).

```sql
CREATE TABLE owners (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  disabled_at INTEGER,
  disabled_reason TEXT
) STRICT;

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
) STRICT;
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
) STRICT;

CREATE TABLE login_tokens (
  token_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
) STRICT;
CREATE INDEX login_tokens_owner ON login_tokens(owner_id, created_at);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
) STRICT;
CREATE INDEX sessions_owner ON sessions(owner_id);

CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
) STRICT;
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
  model_slot INTEGER NOT NULL DEFAULT 0 CHECK (model_slot IN (0, 1)), -- 1 = this job took one of today's model calls (§6.3)
  provider TEXT,
  model TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_microusd INTEGER NOT NULL DEFAULT 0, -- reporting only; limits are counts (§6.3)
  error_code TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
) STRICT;
CREATE INDEX generations_site ON generations(site_id, created_at);
CREATE INDEX generations_owner ON generations(owner_id);
CREATE INDEX generations_slots ON generations(model_slot, started_at);
CREATE UNIQUE INDEX generations_one_active ON generations(site_id) WHERE status IN ('queued', 'running');

CREATE TABLE site_versions (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn', 'superseded')),
  document_json TEXT NOT NULL,          -- canonicalJson of the parsed SiteDocument that was rendered (§2.5)
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
) STRICT;
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
) STRICT;
CREATE INDEX leads_site ON leads(site_id, created_at);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
) STRICT;

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,                  -- 'admin:<email>' | 'owner:<id>' | 'system'
  action TEXT NOT NULL,                 -- one of AUDIT_ACTIONS (§2.8)
  site_id TEXT,
  detail_json TEXT
) STRICT;
CREATE INDEX audit_site ON audit_log(site_id, at);

CREATE TABLE dev_outbox (               -- written only by LogMailer (development/test); never in production
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  text TEXT NOT NULL,
  tag TEXT NOT NULL
) STRICT;
```

- **`settings` keys:**
  - `generation.enabled`: `"true"` or `"false"`. A missing row means `"true"`.
  - `generation.daily_model_limit`: an integer string, the most jobs per UTC day that may call the model. A missing row means the `DAILY_MODEL_LIMIT` variable.
- **Migrations:** every `wrangler.jsonc` sets `"migrations_dir": "../../packages/core/migrations"`. [verified: the key exists in wrangler 4.138.0; local apply ran in the spike] A plan that needs a schema change asks the moderator. No plan adds a migration by itself.
- **Partial unique index:** SQLite supports it, so D1 should too [inferred]. Stage 0 proves it with a test: a second `queued` row for the same site must fail.
- **STRICT tables (A9):** every table is `STRICT`, so D1 refuses a value whose type does not match its column (`SQLITE_CONSTRAINT_DATATYPE`) instead of storing it; for example, an expiry bound as a string would otherwise never expire under `expires_at > ?`. D1 recommends STRICT tables ("Type conversion", developers.cloudflare.com/d1/worker-api/). The schema uses only `TEXT` and `INTEGER`, both allowed in STRICT tables (sqlite.org/stricttables.html). Local D1 enforces it [verified: the migration test]; production is inferred from D1's `PRAGMA table_list`, which has a `strict` column, and Plan 2 Task 19 checks it after the first migration apply.

### 2.7 R2 key layout

| Bucket | Key | Writer | Reader | Metadata |
|---|---|---|---|---|
| `asksite-work` | Home: `versions/<siteId>/<versionId>.html`; every other page: `versions/<siteId>/<versionId>/<page>.html` (both from `versionPageKey`) | app (publish request) | admin (review, approve), app (owner's view of what is in review) | `httpMetadata.contentType = "text/html; charset=utf-8"`; `customMetadata = { siteId, versionId, page, sha256 }` (`sha256` is that page's) |
| `asksite-media` | `<siteId>/<uploadId>.webp` | app (upload) | sites (`media.<root>`); admin deletes on purge | `contentType = "image/webp"`; `customMetadata = { siteId, uploadId }` |
| `asksite-live` | the **pointer**: the bare slug (`livePointerKey`) | **admin only** (`@asksite/publishing`) | sites | an empty object; `customMetadata = { siteId, versionId, businessName, phoneText, phoneTel, writer }`: the live version and what the sites Worker's fixed pages say about the business (its name and phone, both already public on the page); `writer` is the writing action call's own random id (`crypto.randomUUID` via `newId`, never the lease token), read only by `@asksite/publishing`'s take-back and ignored by the sites Worker |
| `asksite-live` | a page: `<slug>/<versionId>/<page>.html` (`livePageKey`), `<page>` one of `home`, `services`, `about`, `gallery`, `contact` | **admin only** | sites | `contentType = "text/html; charset=utf-8"`; `customMetadata = { siteId, versionId, page, sha256 }`. Whether to add `noindex` is read from D1 (`sites.indexable`), not from R2 |

The pointer is not under the prefix `<slug>/`, so deleting the prefix (`liveSitePrefix`) removes every page and leaves the pointer; a takedown deletes the pointer itself first (§7.2). The page objects of a version are immutable, so a cached or half-copied page can never be another version's.

Key helpers live in `@asksite/core/keys.ts` (§2.8): `livePointerKey`, `liveSitePrefix`, `livePageKey`, `versionPageKey`, `publicPageUrl`, `previewSiteUrl` and `pageCacheUrl`, beside `versionKey`, `mediaKey`, `siteUrl`, `formActionUrl`, `previewFormActionUrl` and `mediaUrl`. No other code builds keys by hand. `livePointerKey`, `liveSitePrefix`, `livePageKey`, `versionPageKey` and `pageCacheUrl` are guarded (`publicPageUrl` checks only the page id, and `previewSiteUrl`, like `siteUrl`, checks nothing), so that a request path or a damaged pointer can never shape a key or a takedown's prefix delete: a page must be one of the 5 page ids (`isPageId`: an own key of the page map, never an inherited name such as `constructor`); a slug must be a string of the right shape (`slugIssue` is not `"invalid"`, so not `/` or `.`; a *reserved* word is accepted, so a site whose slug later became reserved can still be taken down and its LIVE objects managed, though the Worker no longer serves that host); an id must pass `isId`. Each throws (`Invalid slug`, `Unknown page id`, `Unknown site id`, `Unknown version id`) instead of returning a key. So no key of one site is another site's key, its pointer, or under its prefix.

### 2.8 `@asksite/core`: the shared contract (Stage 0)

This package is pure TypeScript with no bindings. It depends on `zod` 4.6.5 and `@asksite/site-schema`. Every export below is created in Stage 0 exactly as written. The bodies follow the semantics given here.

```ts
// ids.ts
export const newId = (): string => crypto.randomUUID();
export const isId = (s: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(s);

// tokens.ts: 32 random bytes, base64url without padding (43 characters)
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export function newToken(): string;
export function sha256Hex(input: string): Promise<string>;
/** HMAC-SHA256(key, ip) as base64url, first 22 characters. Never store a raw IP. */
export function hashIp(key: string, ip: string): Promise<string>;
export function canonicalJson(value: unknown): string; // keys sorted recursively, no whitespace

// time.ts
export const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);
export const TTL = { inviteMs: 7 * 86_400_000, loginTokenMs: 15 * 60_000, sessionMs: 30 * 86_400_000 } as const;

// keys.ts
export const versionKey = (siteId: string, versionId: string) => `versions/${siteId}/${versionId}.html`; // Home's WORK key
// A16: LIVE holds one pointer per site and the pages under the slug (§2.7). Guarded as §2.7 says, except publicPageUrl (page id only) and previewSiteUrl (nothing).
export const livePointerKey = (slug: string) => slug;                   // the pointer: the bare slug
export const liveSitePrefix = (slug: string) => `${slug}/`;             // every LIVE page of the site; not the pointer
export const livePageKey = (slug: string, versionId: string, page: PageId) => `${slug}/${versionId}/${page}.html`;
export function versionPageKey(siteId: string, versionId: string, page: PageId): string; // Home: versionKey; else versions/<siteId>/<versionId>/<page>.html
/** A page's public URL, also its canonical URL: siteUrl for Home, else https://<slug>.<root>/<page>. */
export const publicPageUrl = (root: string, slug: string, page: PageId) => `https://${slug}.${root}${PAGES[page].path}`;
/** The edge-cache key of a page of a version: the version id is in the PATH (not a query a cache setting could strip). */
export const pageCacheUrl = (root: string, slug: string, versionId: string, page: PageId) => `https://${slug}.${root}/__v/${versionId}${PAGES[page].path}`;
export const previewSiteUrl = (root: string, slug: string | null) => siteUrl(root, slug ?? "preview");
export const mediaKey = (siteId: string, uploadId: string) => `${siteId}/${uploadId}.webp`; // in MEDIA
export const siteUrl = (root: string, slug: string) => `https://${slug}.${root}/`;
export const formActionUrl = (root: string, slug: string, siteId: string) => `https://${slug}.${root}/_f/${siteId}`;
/** The owner app's in-browser preview renders with this before a slug is chosen ("preview" is reserved;
 *  the sandboxed preview can never submit the form anyway). */
export const previewFormActionUrl = (root: string, slug: string | null, siteId: string) => formActionUrl(root, slug ?? "preview", siteId);
export const mediaUrl = (root: string, siteId: string, uploadId: string) => `https://media.${root}/${siteId}/${uploadId}.webp`;
export type HostKind =
  | { kind: "apex" } | { kind: "www" } | { kind: "media" }
  | { kind: "site"; slug: string } | { kind: "unknown" };
/**
 * host = URL.host (lower-case, includes a non-default port); root = ROOT_DOMAIN.
 * host === root -> apex; "www." + root -> www; "media." + root -> media;
 * "<label>." + root where <label> has no "." and slugIssue(label) === null -> site;
 * anything else (deeper subdomains, reserved labels such as "app", other domains, a port mismatch) -> unknown.
 */
export function parseHost(host: string, root: string): HostKind;

// slug.ts
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?!-)){1,38}[a-z0-9]$/; // 3-40 characters, no "--", no leading or trailing "-"
export const RESERVED_SLUGS: ReadonlySet<string>; // at least: www app admin media api mail email smtp imap pop ftp static
  // assets cdn img images files status help support docs blog abuse security billing account accounts login
  // signin signup auth dashboard staging stage dev test preview ns1 ns2 mx autodiscover autoconfig webmail
  // send inbound bounce (Resend and mail DNS labels, §1.1)
/** Shape and reserved-word check only. Plan 4 adds the brand and obscenity blocklist (§11). */
export function slugIssue(slug: string): "invalid" | "reserved" | null;

// brief.ts
export const TONES = ["friendly", "professional", "no-nonsense"] as const;
export const GOALS = ["call", "quote", "book"] as const;
// Same hidden-character rule as Facts text (\p{Cc} and \p{Cf} rejected, U+200D allowed), except "\n" is also allowed.
const briefText = (max: number) =>
  z.string().trim().max(max).refine((s) => !/(?!\n)\p{Cc}|(?!\u200D)\p{Cf}/u.test(s), { error: "Invisible or control characters are not allowed" });
export const Brief = z.strictObject({
  tone: z.enum(TONES),
  goal: z.enum(GOALS),
  differentiator: briefText(140).optional(),       // "What makes you different?"
  notes: briefText(2000).optional(),               // "Pretend you're texting a friend..."
  comments: z.record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/), briefText(500))
    .refine((c) => Object.keys(c).length <= 20, { error: "You can add at most 20 comments." }).default({}), // per-question comments, keyed by question id (message: A9)
  reviewsAreReal: z.boolean().default(false),      // owner attests pasted reviews are real (FTC)
});
export type Brief = z.infer<typeof Brief>;

// rows.ts: one TypeScript interface per table in §2.6, with snake_case fields exactly as the columns
// (OwnerRow, SiteRow, InviteRow, LoginTokenRow, SessionRow, UploadRow, GenerationRow,
// SiteVersionRow, LeadRow, SettingRow, AuditRow). INTEGER 0/1 columns are typed `0 | 1`.

// draft.ts
import { Copy, Layout, Theme, SECTION_VARIANTS, OwnerHidden, type Facts, type SectionId, type SiteDocument, type SiteDocumentInput } from "@asksite/site-schema";
export const AiDraft = z.strictObject({ copy: Copy, layout: Layout, theme: Theme });
export type AiDraft = z.infer<typeof AiDraft>;
const EditText = z.string().max(2000);
// Service name -> owner text (A7): a plain object is checked as a Map and rebuilt with Object.fromEntries,
// so an own "__proto__" key is plain data (z.record would drop it). At most 12 entries, as many as Facts
// allows services (A8c): a 13th is a too_big issue ("Too big: expected map to have <=12 entries"), and a
// name over 40 characters is too_big too.
const ServiceDescriptionEdits = z.preprocess(
  (value, ctx) => { if (isPlainObject(value)) return new Map(Object.entries(value)); ctx.issues.push({ code: "invalid_type", expected: "record", input: value }); return value; },
  z.map(z.string().max(40), EditText).max(12),
).transform((edits) => Object.fromEntries(edits));   // isPlainObject: prototype Object.prototype or null
export const CopyEdits = z.strictObject({
  heroHeadline: EditText.optional(),
  heroSubheadline: EditText.optional(),
  ctaText: EditText.optional(),
  about: EditText.nullable().optional(),                        // null = remove the about text
  sectionIntros: z.strictObject({
    services: EditText.nullable().optional(), gallery: EditText.nullable().optional(),
    faq: EditText.nullable().optional(), contact: EditText.nullable().optional(),
  }).optional(),
  serviceDescriptions: ServiceDescriptionEdits.optional(),     // key = facts.services[].name, exact
  faq: z.array(z.strictObject({ question: EditText, answer: EditText })).max(8).optional(), // replaces the AI list
});
export const SECTION_IDS = Object.keys(SECTION_VARIANTS) as [SectionId, ...SectionId[]];
/** A full order: every section id exactly once, hero first. The editor always saves all of them
 *  (it lists only the visible ones and keeps the rest in place). */
export const SectionOrder = z.array(z.enum(SECTION_IDS)).length(SECTION_IDS.length)
  .refine((ids) => new Set(ids).size === ids.length && ids[0] === "hero", { error: "Order must list every section once, hero first" });
export const OwnerEdits = z.strictObject({
  baseGenerationId: z.string().max(36).nullable(), // copy and order edits apply only to this generation (a newId(), A8c)
  copy: CopyEdits,
  order: SectionOrder.nullable(),
  hidden: OwnerHidden,                       // A6 schema from @asksite/site-schema (unique, hideable ids only)
  theme: Theme.nullable(),
});
export type OwnerEdits = z.infer<typeof OwnerEdits>;
export const EMPTY_EDITS: OwnerEdits = { baseGenerationId: null, copy: {}, order: null, hidden: [], theme: null };

// compose.ts
export interface CurrentAi { generationId: string; draft: AiDraft }
/**
 * Builds the page document. Never throws; validate the result with SiteDocument.safeParse.
 * - facts: passed through unchanged (it may be incomplete while the owner is drafting).
 * - If edits.baseGenerationId !== ai.generationId, edits.copy and edits.order are IGNORED (they belong
 *   to an older AI draft); edits.hidden and edits.theme still apply. This is how "regenerate" resets
 *   the wording without any database write. The editor, before saving its first wording or order change
 *   on a newer draft, starts from { ...edits, baseGenerationId: ai.generationId, copy: {}, order: null }.
 * - Owner strings: every whitespace run (including newlines) is collapsed to one space. Nothing else changes.
 * - Required copy fields: edit ?? AI value. Optional fields (about, sectionIntros.*): edit === null means
 *   leave it out; undefined means use the AI value.
 * - serviceDescriptions: one entry per facts.services[i].name, in facts order:
 *   edits.copy.serviceDescriptions[name] ?? the AI entry whose `service` === name ?? "" (the empty
 *   string makes SiteDocument report copy.serviceDescriptions.<i>.description, so the editor asks the
 *   owner to write it). If facts.services is not an array, the result is []. Record lookups use
 *   Object.hasOwn, so a service named "constructor" or "__proto__" behaves like any other name.
 * - faq: edits.copy.faq ?? ai.copy.faq.
 * - layout (A16, U1: user decision 2026-10-01): every SectionId once. The order is the owner's (edits.order) when
 *   edits.order applies (see the first bullet), else DEFAULT_SECTION_ORDER, the page map's order (hero first, then
 *   each page's sections in turn, §2.9). The AI's layout only picks the VARIANTS of the sections it lists; its order
 *   decides nothing. Every section it lacks is added with its first variant (SECTION_VARIANTS[id][0]), so the layout
 *   always holds every section and Plan 1's visibleSections shows only those with content and not in edits.hidden
 *   (this keeps the document valid when the owner adds a first photo, review or licence after generation, and lets
 *   owner-written about or FAQ text appear even if the AI wrote none). A section never leaves its page: each lives on
 *   one fixed page (§2.9) and the order only places sections within it. The AI output contract (§6.1) is unchanged.
 * - hidden: edits.hidden. theme: edits.theme ?? ai.theme.
 * - The result is typed `ComposedDocument` (SiteDocumentInput with `facts: unknown`), because facts may be
 *   incomplete while drafting. Callers validate it with SiteDocument.safeParse and use `.data` from then on.
 */
export type ComposedDocument = Omit<SiteDocumentInput, "facts"> & { facts: unknown };
export function composeDocument(facts: unknown, ai: CurrentAi, edits: OwnerEdits): ComposedDocument;
/** sha256Hex(canonicalJson(parsed)) for a parsed SiteDocument; used for document_sha256 and "Unpublished changes". */
export function documentSha256(parsed: SiteDocument): Promise<string>;
/** Dotted paths of copy fields whose value came from the owner, e.g. "copy.heroHeadline", "copy.faq". */
export function ownerEditedPaths(ai: CurrentAi, edits: OwnerEdits): string[];
/** Every facts photo (heroPhoto, photos[]) must equal mediaUrl(root, siteId, u.id) for a non-deleted upload u
 *  of this site, with width and height equal to the upload's. Returns issues at facts.heroPhoto.url etc. */
export function photoRefIssues(facts: unknown, siteId: string, root: string, uploads: ReadonlyArray<{ id: string; width: number; height: number }>): Issue[];

// issues.ts
export interface Issue { path: Array<string | number>; code: string; message: string }
export function toIssues(error: z.ZodError): Issue[]; // the first 50 issues only (A9: zod reports one issue per bad array element, and a facts JSON near its cap gave 152,289); symbol path keys become String(key)

// looks.ts: LOOKS as in §2.4

// limits.ts (defaults; the caps are the user's call, §12)
export const LIMITS = {
  generationsPerSitePerDay: 5,
  generationsPerOwnerTotal: 20,
  defaultDailyModelLimit: 30,                 // model-calling jobs per UTC day, all owners (overridden by settings / env)
  uploadsPerSite: 40,                         // non-deleted
  uploadsPerSiteTotal: 150,                   // every upload ever, soft-deleted included: bounds R2 and Images spend
  uploadMaxBytes: 10 * 1024 * 1024,
  loginTokensPerOwnerPerHour: 5,
  loginTokensPerOwnerPerDay: 10,
  leadsPerSitePerDay: 50,
  leadRetentionDays: 180,
  factsJsonMaxBytes: 307_200,                 // 300 KiB: the largest valid Facts is 306,352 bytes once JSON-encoded (A8b, A9)
  briefJsonMaxBytes: 74_752,                  // 73 KiB: the largest valid Brief is 73,865 bytes once JSON-encoded (A8)
  editsJsonMaxBytes: 436_224,                 // 426 KiB: the largest valid OwnerEdits is 435,810 bytes once JSON-encoded (A8c)
} as const;

// errors.ts
export const ERROR_STATUS = {
  bad_request: 400, unauthenticated: 401, forbidden: 403, owner_disabled: 403, not_found: 404,
  conflict: 409, slug_taken: 409, slug_locked: 409, generation_in_progress: 409,
  nothing_pending: 409, version_not_pending: 409, wording_changed: 409,
  invite_invalid: 410, token_invalid: 410,
  payload_too_large: 413, unsupported_media_type: 415,
  validation_failed: 422, not_ready: 422, publish_invalid: 422, slug_invalid: 422, image_rejected: 422,
  site_taken_down: 423,
  rate_limited: 429, generation_cap_reached: 429, upload_limit_reached: 429,
  internal: 500, email_failed: 502, generation_disabled: 503, budget_exhausted: 503,
} as const;
export type ErrorCode = keyof typeof ERROR_STATUS;
export interface ErrorBody { error: { code: ErrorCode; message: string; issues?: Issue[]; retryAfter?: number; currentRev?: number } }

// generation.ts (types shared with Plan 3)
export const GENERATION_ERROR_CODES = ["generation_disabled", "budget_exhausted",
  "provider_unavailable", "provider_timeout", "invalid_output", "internal"] as const;
export type GenerationErrorCode = (typeof GENERATION_ERROR_CODES)[number];
export const FALLBACK_REASONS = ["disabled", "budget", "provider_error", "invalid_output"] as const; // "budget" = today's model limit reached
export type FallbackReason = (typeof FALLBACK_REASONS)[number];
export interface GenerationJob { v: 1; generationId: string } // everything else is read from the row
export interface GenerationInputSnapshot { facts: Facts; brief: Brief } // stored in generations.input_json

// audit.ts
export const AUDIT_ACTIONS = ["invite.created", "invite.revoked", "invite.accepted", "auth.login",
  "generation.requested", "version.requested", "version.withdrawn", "version.approved", "version.rejected",
  "site.taken_down", "site.restored", "site.indexable_changed", "owner.disabled", "owner.enabled",
  "settings.updated", "admin.login_link_sent"] as const;

// views.ts: response types (§4)
```

`views.ts` and `api.ts` (request schemas) are specified in §4.

---

### 2.9 Pages (A16)

A site has up to 5 pages (user decision 2026-10-01). The page map `PAGES` (`@asksite/site-schema`) is fixed, and each section lives on exactly one page:

| Page id | Path | Label | Sections, in the page's own order |
|---|---|---|---|
| `home` | `/` | Home | hero, trust, testimonials; plus a services preview (right before testimonials, or after the last section when there are none) and the closing band |
| `services` | `/services` | Services | services, faq; plus the closing band |
| `about` | `/about` | About | about; plus the closing band |
| `gallery` | `/gallery` | Gallery | gallery; plus the closing band |
| `contact` | `/contact` | Contact | the contact form, then the service area and hours; **no** closing band |

- **A page exists if and only if at least one of its sections is visible** (it has content and the owner did not hide it, §2.3). Home, Services and Contact therefore always exist, because each holds a section that always has content and can never be hidden (hero, services, contact). About, Gallery and the trust and testimonials sections come and go with the owner's content. `sitePages(doc)` returns the pages in map order, Home first; the order of sections within a page follows the document's layout (§2.8).
- **Per page:** the title is `Name | Plumbing in Austin, TX` on Home (just the name when that is over 70 characters once escaped, clipped if even that is) and `<Label> | Name` elsewhere (the name clipped to fit); the meta description is built from facts and fixed words (Services, Gallery and Contact), is the hero subheadline on Home, and is the claim-checked `copy.about` clipped to 160 characters on About (no section intro is used: they are optional, so three pages of a small site would share one); the canonical URL is the site URL plus the page's path; `LocalBusiness` JSON-LD is on Home only and `FAQPage` JSON-LD on Services only (when the FAQ is on the page). Each inner page's first section carries its one `<h1>`.
- **The call bar** (phone-only, hidden from `md` up): "Call" and "Get a quote". It is sticky at the bottom of every page except `/contact`, where it is static at the end of the page (moderator ruling: Send, stacked above a sticky bar, covered its buttons on phone windows about 915-1040 px tall, WCAG 2.5.8).
- **Every "Get a quote" link** goes to `QUOTE_HREF`, `/contact#quote`; the contact `<form>` carries `id="quote"` (`QUOTE_ID`). The sites Worker's fixed error pages link to the same address.
- Owners reorder sections only within a page (U1, §2.8); the navigation lists every rendered page.

## 3. Journeys

### 3.1 Owner, end to end

1. **Invite.** An admin creates an invite (§3.2). The owner receives an email containing `https://app.<root>/invite#<token>`. The link is only ever emailed; it is never shown to the admin, so accepting it proves the owner controls that mailbox, which is where leads and sign-in links go. (A copy-and-text option was cut: a mistyped address would then send leads and sign-in links to a stranger. If texting is needed later, add an email-confirmation step first.)
2. **Accept.** The app page reads the token from the URL fragment. The page shows "Set up your website" with one button, which sends `POST /api/auth/invite/accept`. The server creates the owner (or reuses one with the same email), creates a draft site and sets the session cookie. The app then calls `history.replaceState` to remove the fragment. Email link scanners that open the URL with GET, or even run its JavaScript, never use up the token, because using it requires the button press.
3. **Questionnaire** (Plan 4 owns the wording).
   - Steps, each saved with `PATCH /api/sites/:id/draft` as the owner goes:
     1. Business: name, trade, phone, public email, city and state, optional street and ZIP.
     2. Services: 1–12 services with an optional "from" price; free estimates yes or no; 24/7 emergency yes or no.
     3. Area and hours.
     4. Trust: licences, insured, year founded (the form asks "years in business" and converts it; Plan 1 Decision #6), pasted real reviews, and the attestation checkbox → `brief.reviewsAreReal`.
     5. Photos: hero photo, up to 12 work photos, with required alt text and an optional caption. Social links.
     6. Your words: what makes you different, tone, goal, and the "texting a friend" notes.
     7. Web address: slug, with a live availability check.
   - Every step has an optional "Anything we should know?" box. Its text goes to `brief.comments[<questionId>]`.
   - Uploads start as soon as a file is chosen (§8).
   - Nothing is ever asked twice (WCAG 3.3.7).
4. **Build.** The owner clicks "Build my website", which sends `POST /api/sites/:id/generations`. The server requires `Facts` and `Brief` to be valid and photo references to be clean; otherwise it returns `422 not_ready` with the issues, and the app jumps to the first one. A progress screen polls `GET /api/sites/:id/generations/:genId` every 2 s for the first 2 minutes and every 10 s after that, until the status is `succeeded` or `failed`, with an `aria-live="polite"` status ("Still working…" after 2 minutes). Plan 3 guarantees a final status within 12 minutes of the request (§6.3). The first build ends `succeeded` even when the model is off, over the daily limit, failing or its job crashed, by using the template fallback (§6.3). Only a failure to write even the template marks it `failed`, and then the owner sees "Try again".
5. **Preview and edit.** The editor has the live preview on one side (a phone-width toggle is available) and the side panel on the other. On screens narrower than 768 px there are "Edit" and "Preview" tabs instead. Panel tabs:
   - **Words:** every copy field grouped by section, with character counters from `COPY_LIMITS` and plain-language errors. A rule message links to the fact that fixes it: "licensed" leads to Licences, "free" leads to the free-estimates toggle, and digits or years lead to Details.
   - **Look:** "Recommended" plus the four `LOOKS`.
   - **Sections:** order with Move up and Move down buttons. No drag-only control is used (WCAG 2.5.7). There is a Hide toggle for `HIDEABLE_SECTIONS`. Hero, services and contact have no toggle and show a line explaining why.
   - **Photos:** swap the hero photo, add, remove and reorder work photos, edit alt text and captions. These change facts.
   - **Details:** the questionnaire forms, reused.

   Saving and preview behaviour:
   - Changes save automatically, debounced by 800 ms. The client sends one request at a time and always sends the newest state with `rev`.
   - The preview re-renders in the browser on every valid change with `render(parsed, { stylesheet: SITE_CSS, formAction: previewFormActionUrl(root, slug, siteId) })`. While the document is invalid, it keeps the last valid render and shows "Fix 1 issue to update the preview", with a link to the issue.
   - "Write new wording" regenerates the copy. It asks for confirmation ("This replaces all wording, including your edits. Your look, photos and hidden sections stay.") and counts against the caps.
6. **Publish.** The owner clicks Publish, which sends `POST /api/sites/:id/publish-requests` with `rev`.
   - Blocking checks: the composed document is valid; `reviewsAreReal` is true if there are any testimonials; the slug is set and valid; photo references are clean; the site is not taken down.
   - The server then renders the page and stores the version.
   - The status page shows "Waiting for approval", the version number, a "See what we're reviewing" link (the stored bytes) and a Withdraw button.
   - Editing can continue. Publishing again supersedes the pending version.
7. **Approved.** The owner gets an email with the live link (`https://<slug>.<root>/`, visible within about a minute, §7.3), and the app shows it. Once live, the app shows "Unpublished changes" whenever the draft is invalid or `documentSha256(parsed draft) !== liveVersion.document_sha256` (§2.5).
8. **Rejected.** The owner gets an email with the admin's note, which also appears in the app. The owner fixes the problem and publishes again.
9. **Leads.** The site's contact form posts to us. The lead is stored and emailed to the owner's login email, and it appears on the app's Leads page.

### 3.2 Admin

1. **Sign in.** The admin goes to `https://admin.<root>`. Cloudflare Access handles the login (identity provider with MFA; which provider is the user's call). The Worker verifies the Access JWT and the email allowlist.
2. **Invites.** Enter an email and create the invite. The invite email is always sent; the link is never shown to the admin. If sending fails, no invite is kept and the admin sees "Email could not be sent, try again" (`502 email_failed`). The invites list shows status (sent, used, expired, revoked) and has a revoke action. To re-send, revoke and invite again.
3. **Review queue** (`GET /api/admin/reviews`, oldest first). The detail view shows:
   - the exact stored page in a sandboxed iframe, at phone and desktop widths;
   - automated checks: first publish or update; testimonial count and attestation; hidden sections; social link hosts; photo count with thumbnails; fallback copy used; slug flags; **text flags** (§4.2 `ReviewChecks.textFlags`): every owner fact string (business name, reviews, captions, alt text, service names, service-area note, licence labels) that contains a web address, an `@`, a phone number other than the site's own, or a phishing word (password, login, sign in, verify, bank, gift card, crypto, wire, SSN). Copy cannot contain these (§2.2), but facts can, and they render as text on our domain;
   - the wording the owner changed (from `ownerEditedPaths`), highlighted;
   - a text diff against the live document for updates.

   Actions:
   - **Approve**, with an optional note and "Allow search engines" (on by default). The request carries the `htmlSha256` of the page the admin was shown. Publishes within about 1 minute and emails the owner.
   - **Reject**, with a required note that is emailed to the owner.
4. **Sites.** Search and filter by live, in review, taken down or draft. The site detail shows versions, generations with cost, a lead count, the audit trail, and these actions:
   - **Take down:** reason, optional message to the owner, optional "also delete photos".
   - **Restore.**
   - **Search engines on or off.**
   - **Disable owner**, which also ends every session that owner has.
5. **Settings.** An AI generation on/off switch (the kill switch), the daily model limit, today's model calls and spend, and the worst-case daily cost that the limit allows (§6.3).

---

## 4. APIs

### 4.1 Conventions (all Workers)

- **Request and response bodies:** JSON (`application/json; charset=utf-8`) except the upload (`multipart/form-data`) and the public form (`application/x-www-form-urlencoded`). The server checks `Content-Length` first and stops reading past the limit. Limits: 256 KB for JSON bodies, 10 MB for uploads, 16 KB for the public form. Larger bodies get `413 payload_too_large`. **One exception:** `PATCH /api/sites/:siteId/draft` reads up to 1 MiB (`DRAFT_JSON_MAX_BYTES`, A8c). It is the only request whose body carries a whole Facts, Brief or OwnerEdits, and those parts may reach `LIMITS.factsJsonMaxBytes` + `briefJsonMaxBytes` + `editsJsonMaxBytes` = 818,176 bytes (§2.8). A test pins `DRAFT_JSON_MAX_BYTES` at or above that sum plus 4 KiB, so the body limit never refuses a draft whose parts fit their own limits, and a part over its limit gets that part's own 413. The three parts together stay under D1's 2,000,000-byte row limit.
- **Errors:** `ErrorBody` (§2.8) with `ERROR_STATUS[code]`. `validation_failed`, `not_ready` and `publish_invalid` include `issues`. `conflict` includes `currentRev`. Every 429 includes `retryAfter` (seconds) and the `Retry-After` header.
- **CSRF defence:** every state-changing `/api/*` request must carry `Origin` equal to `APP_ORIGIN` (or `ADMIN_ORIGIN` on the admin Worker) and the expected content type. Otherwise the server returns `403 forbidden`. Cookies are `SameSite=Lax`.
- **Response headers on every API response:** `Cache-Control: no-store`, `X-Robots-Tag: noindex`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`. **One exception:** the two stored-version page routes send `X-Frame-Options: SAMEORIGIN` and the §7.4 review CSP (which has `frame-ancestors 'self'`), because the admin review screen shows them in an iframe; `DENY` would blank that iframe. **PLANNED (Plan 4's A16 adapt, not built):** the two routes become per-page, `…/versions/:versionId/pages/:pageId`, because a version is up to 5 pages (§2.9); the exception applies to them.
- **Owner authorisation:** every `/api/sites/:siteId/...` handler loads the site with `WHERE id = ? AND owner_id = ?`. A site belonging to someone else returns `404 not_found`, never 403, so site IDs cannot be probed. A disabled owner returns `403 owner_disabled` on every authenticated route.
- **Rate-limit bindings** (per location, approximate):

| Binding | Worker | Key | Limit |
|---|---|---|---|
| `AUTH_RL` (`namespace_id` "1001") | app | `hashIp(ip)` | 10 per 60 s on `/api/auth/*` |
| `API_RL` ("1002") | app | owner id | 120 per 60 s on authenticated `/api/*` |
| `UPLOAD_RL` ("1003") | app | owner id | 20 per 60 s on uploads |
| `FORM_RL` ("1004") | sites | `${siteId}:${hashIp(ip)}` | 5 per 60 s on `POST /_f/*` |
| `ADMIN_RL` ("1005") | admin | admin email | 300 per 60 s |

  The client IP comes from the `CF-Connecting-IP` header.
- **Exact limits** (D1 counts): the `LIMITS` table in §2.8.

### 4.2 Response views (`@asksite/core/views.ts`)

```ts
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
  textFlags: Array<{ path: string; reason: "web_address" | "at_sign" | "other_phone" | "phishing_word" }>; // §3.2
}
export interface AdminVersionDetail {
  version: VersionSummary & { siteId: string; htmlSha256: string; generationId: string | null; requestedBy: string };
  site: AdminSiteRow; document: unknown; ownerEditedPaths: string[];
  liveDocument: unknown | null; checks: ReviewChecks; pageUrl: string; // "/api/admin/versions/<id>/page" (one-page form)
  // PLANNED (Plan 4's A16 adapt, not built): pageUrl is replaced by
  //   pages: Array<{ page: PageId; label: string; url: string; sha256: string }>, Home first, each url "/api/admin/versions/<id>/pages/<page>".
}
export interface AdminSettings {
  generationEnabled: boolean; envGenerationEnabled: boolean; dailyModelLimit: number;
  modelCallsToday: number; spentTodayMicrousd: number;
  worstCaseDailyMicrousd: number | null; // dailyModelLimit x worst-case cost of one job for the configured model (§6.3); null = no recorded price (M3)
}
```

### 4.3 Request schemas (`@asksite/core/api.ts`)

```ts
const Token = z.string().regex(TOKEN_PATTERN);
const Rev = z.int().min(1);
const Json = z.record(z.string(), z.unknown());
const Email = z.string().trim().pipe(z.email().max(254)); // trimmed before the email check (A9)
export const AcceptInviteBody = z.strictObject({ token: Token });
export const LoginBody = z.strictObject({ email: Email });
export const VerifyLoginBody = z.strictObject({ token: Token });
export const PatchDraftBody = z
  .strictObject({ rev: Rev, facts: Json.optional(), brief: Json.optional(), edits: OwnerEdits.optional() })
  .refine((b) => b.facts !== undefined || b.brief !== undefined || b.edits !== undefined, { error: "Nothing to save" });
export const SetSlugBody = z.strictObject({ rev: Rev, slug: z.string().max(40) });
export const PublishBody = z.strictObject({ rev: Rev });
export const CreateInviteBody = z.strictObject({ email: Email }); // always emailed (§3.2)
export const ApproveBody = z.strictObject({
  htmlSha256: z.string().regex(/^[0-9a-f]{64}$/), // the version's html_sha256 as shown to the admin
  note: z.string().trim().max(1000).optional(), indexable: z.boolean().default(true),
});
export const RejectBody = z.strictObject({ note: z.string().trim().min(1).max(1000) });
export const TakedownBody = z.strictObject({
  reason: z.string().trim().min(1).max(1000), ownerMessage: z.string().trim().max(1000).optional(),
  purgeMedia: z.boolean().default(false),
});
export const IndexableBody = z.strictObject({ indexable: z.boolean() });
export const DisableOwnerBody = z.strictObject({ reason: z.string().trim().min(1).max(1000) });
export const SettingsBody = z.strictObject({
  generationEnabled: z.boolean().optional(),
  dailyModelLimit: z.int().min(0).max(1000).optional(),
});
```

Emails are trimmed and lower-cased before use. A request body that fails its schema gets `422 validation_failed` with `issues`.

### 4.4 Owner API (`asksite-app`, base `https://app.<root>`)

"Session" means the `__Host-asksite_sid` cookie maps to a live session and the owner is not disabled.

| Method and path | Auth | Request | Success | Errors |
|---|---|---|---|---|
| `POST /api/auth/invite/accept` | none | `AcceptInviteBody` | `200 { owner: OwnerView, siteId }` plus `Set-Cookie` | 410 `invite_invalid` (unknown, expired, used or revoked), 403 `owner_disabled`, 429 |
| `POST /api/auth/login` | none | `LoginBody` | `202 { ok: true }`, always the same (no account enumeration); the lookup, token and email run in `ctx.waitUntil` after the response, so its timing reveals nothing | 429 |
| `POST /api/auth/login/verify` | none | `VerifyLoginBody` | `200 { owner: OwnerView }` plus `Set-Cookie` | 410 `token_invalid`, 403 `owner_disabled`, 429 |
| `POST /api/auth/logout` | session (or none) | — | `204`; deletes the session row and expires the cookie | — |
| `GET /api/me` | session | — | `200 { owner: OwnerView, sites: SiteSummary[] }` | 401 |
| `GET /api/sites/:siteId` | session | — | `200 SiteView` | 401, 404 |
| `PATCH /api/sites/:siteId/draft` | session | `PatchDraftBody` | `200 { rev, issues: SiteView["issues"] }`; each given part replaces that part | 409 `conflict` (`currentRev`), 409 `wording_changed` (the edits' copy or order changes carry a stale `baseGenerationId`: they belong to an older generation), 413, 422, 423 `site_taken_down` |
| `PUT /api/sites/:siteId/slug` | session | `SetSlugBody` | `200 { rev, slug }` | 409 `slug_taken` / `slug_locked` / `conflict`, 422 `slug_invalid` (`issues[0].code`: `invalid` / `reserved` / `blocked`) |
| `GET /api/slugs/:slug/availability` | session | — | `200 { available: boolean, reason: "taken" \| "invalid" \| "reserved" \| "blocked" \| null }` | 401 |
| `POST /api/sites/:siteId/uploads` | session | multipart, field `file` | `201 UploadView` | 413, 415 `unsupported_media_type`, 422 `image_rejected` (too small, too many pixels, undecodable), 429 `upload_limit_reached` |
| `DELETE /api/sites/:siteId/uploads/:uploadId` | session | — | `204` (soft delete, §8 step 4) | 404 |
| `POST /api/sites/:siteId/generations` | session | `{}` | `202 { generation: GenerationView }` | 422 `not_ready` (issues), 409 `generation_in_progress`, 429 `generation_cap_reached`, 503 `generation_disabled` / `budget_exhausted` (regenerations only, §6.3), 423 |
| `GET /api/sites/:siteId/generations/:generationId` | session | — | `200 GenerationView` | 404 |
| `POST /api/sites/:siteId/publish-requests` | session | `PublishBody` | `201 { version: VersionSummary }` | 409 `conflict`, 422 `publish_invalid` (issues; codes include `attestation_required`, `slug_missing`, `photo_ref`), 423 |
| `DELETE /api/sites/:siteId/publish-requests/pending` | session | — | `204` | 409 `nothing_pending` |
| `GET /api/sites/:siteId/versions` | session | — | `200 { versions: VersionSummary[] }`, newest first | 404 |
| `GET /api/sites/:siteId/versions/:versionId/page` (**PLANNED A16 adapt, Plan 4 builds it:** `…/versions/:versionId/pages/:pageId`, one route per page) | session | — | `200` stored HTML with the review headers (§7.4) | 404 |
| `GET /api/sites/:siteId/leads?before=<ms>&limit=<1-100>` | session | — | `200 { leads: LeadView[], nextBefore: number \| null }`, newest first, `spam = 0` only | 404 |
| `GET /api/dev/outbox?to=<email>` | **development only** | — | `200 { messages: Array<{ at, to, subject, text, tag }> }` | route is not registered unless `ENVIRONMENT === "development"` and the request hostname ends in `localhost` |

Session cookie: `__Host-asksite_sid=<token>; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000`. D1 stores `sha256Hex(token)`.

### 4.5 Admin API (`asksite-admin`, base `https://admin.<root>`)

Every route requires Access plus the allowlist (§5.3), and every response carries the §4.1 headers.

| Method and path | Request | Success | Errors |
|---|---|---|---|
| `GET /api/admin/me` | — | `200 { email }` | 403 |
| `POST /api/admin/invites` | `CreateInviteBody` | `201 { invite: InviteView }` after the invite email was accepted by the mailer. The link is never returned | 422, 502 `email_failed` (the invite row is deleted; nothing to revoke) |
| `GET /api/admin/invites` | — | `200 { invites: InviteView[] }` | — |
| `DELETE /api/admin/invites/:inviteId` | — | `204` (sets `revoked_at`) | 404 |
| `GET /api/admin/reviews` | — | `200 { items: Array<{ version: VersionSummary, site: AdminSiteRow }> }`, pending, oldest first | — |
| `GET /api/admin/sites?filter=live\|in_review\|taken_down\|draft\|all` | — | `200 { sites: AdminSiteRow[] }` | — |
| `GET /api/admin/sites/:siteId` | — | `200 { site: AdminSiteRow, versions: VersionSummary[], generations: Array<GenerationView & { provider, model, costMicrousd, attempts }>, leadCount, audit: Array<{ at, actor, action, detail }> }` | 404 |
| `GET /api/admin/versions/:versionId` | — | `200 AdminVersionDetail` | 404 |
| `GET /api/admin/versions/:versionId/page` (**PLANNED A16 adapt, Plan 4 builds it:** `…/versions/:versionId/pages/:pageId`) | — | `200` stored HTML with the review headers (§7.4) | 404 |
| `POST /api/admin/versions/:versionId/approve` | `ApproveBody` | `200 { siteId, liveUrl }` (idempotent, §7.2) | 409 `version_not_pending`, 423 `site_taken_down`, 500 `internal` (`PublishError("integrity")`: the stored bytes or the reviewed `htmlSha256` do not match; audited and never expected in normal operation) |
| `POST /api/admin/versions/:versionId/reject` | `RejectBody` | `200 { siteId }` | 409 `version_not_pending` |
| `POST /api/admin/sites/:siteId/takedown` | `TakedownBody` | `200 {}` (idempotent) | 404 |
| `POST /api/admin/sites/:siteId/restore` | `{}` | `200 { liveUrl }` | 409 `conflict` if the site was never live (`PublishError("not_live")`) |
| `PUT /api/admin/sites/:siteId/indexable` | `IndexableBody` | `200 {}` | 404 |
| `POST /api/admin/owners/:ownerId/disable` | `DisableOwnerBody` | `200 {}` (deletes that owner's sessions) | 404 |
| `POST /api/admin/owners/:ownerId/enable` | `{}` | `200 {}` | 404 |
| `GET /api/admin/settings` | — | `200 AdminSettings` | — |
| `PUT /api/admin/settings` | `SettingsBody` | `200 AdminSettings` | 422 |

Every state change writes one `audit_log` row with `actor = 'admin:<email>'`.

**PLANNED, not built (Plan 4's A16 adapt).** `@asksite/publishing` (§7.2) already refuses a second action on a site with `site_busy`; Plan 4 maps it to `409` with `Retry-After` set from `detail.retryAfter` when present (a lease lost mid-action is `site_busy` with `detail.reason = "lease_lost"`). The restore request carries `expectedTakenDownAt`, the `taken_down_at` the admin's page showed (so `{}` in the table above becomes `{ expectedTakenDownAt }`); a takedown by someone else since is `site_taken_down` with `detail.reason = "taken_down_again"`. "Copy the live pages again" (`copyLivePagesAgain`) gets an admin route for a live site, and a taken-down site is `site_taken_down`, which Plan 4 answers `409`. Plan 4's per-page review routes and `AdminVersionDetail.pages` are in §4.1 and §4.2.

### 4.6 Public endpoints (`asksite-sites`)

| Request | Response |
|---|---|
| `GET` or `HEAD` `https://<slug>.<root>` + exactly one of `/`, `/services`, `/about`, `/gallery`, `/contact` (a query string is ignored; no trailing slash, case folding or decoding) | `200` the page with the §7.4 headers when the site's LIVE pointer exists, D1 says the site is live and not taken down, and the pointer's version is D1's live version; `404` noindex page when there is no pointer, or D1 says not live or taken down; `404` naming the business when the pointer's version has no object for that page (a page the site does not have; a missing Home is `503`); `503` noindex with `Retry-After: 60` if R2 or D1 fails, the pointer is damaged, or it names a version other than D1's (§7.3) |
| `GET` or `HEAD` `https://<slug>.<root>/services/` (likewise `/about/`, `/gallery/`, `/contact/`) | `301` to the canonical `https://<slug>.<root>/services`; Home has no such form. No R2 or D1 read |
| any other path on `<slug>.<root>` (except `/_f/*`, `/favicon.ico`), and any other method | `404` noindex page; for `GET` and `HEAD` on a live site it links the business's page, named from the pointer alone (no D1) |
| `GET` `https://<slug>.<root>/favicon.ico` | `204`, cacheable for a week |
| `POST https://<slug>.<root>/_f/<siteId>` | `303` to `/_f/<siteId>/sent`, or an error page (§7.5) |
| `GET https://<slug>.<root>/_f/<siteId>/sent` | `200` fixed thank-you page (noindex) |
| `GET https://media.<root>/<siteId>/<uploadId>.webp` | `200 image/webp` from `MEDIA: mediaKey` when the upload row exists for that site and the site is not taken down; otherwise `404` (§7.3) |
| `GET https://<root>/` and `/.well-known/security.txt` | fixed placeholder page (with the abuse contact), and security.txt with the RFC 9116 fields `Contact: mailto:security@<root>` and `Expires` (set at build time to one year ahead) |
| `https://www.<root>/*` | `301` to `https://<root>/` |

### 4.7 Internal contracts

- **Queue:** name `asksite-generation`, binding `GEN_QUEUE`, message body `GenerationJob` (`{ v: 1, generationId }`). Consumer: `asksite-generator` with `"max_batch_size": 1`, `"max_retries": 2` and `"dead_letter_queue": "asksite-generation-dlq"`. Documented defaults are batch size 10, timeout 5 s, and 3 retries. [verified] Consumer limits: 15 minutes wall-clock and 30 s CPU by default per invocation; message size 128 KB. [verified: Queues limits page]
- **Library functions:** `@asksite/publishing` (Plan 2, §7.2), `@asksite/mailer` (Plan 2, §7.6), and `@asksite/generation`'s `requestGeneration` / `generationAllowance` (Plan 3, §6.4).

---

## 5. Auth

### 5.1 Why tokens are random and stored in D1, not signed

A signed stateless link cannot be single-use and cannot be revoked without storing state anyway. A random 256-bit token (`newToken()`) is stored only as `sha256Hex(token)` and used with a conditional update:

```sql
UPDATE invites SET used_at = ?
WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
```

`changes = 1` means the token was consumed. The same pattern is used for `login_tokens`. This works on a single primary. [inferred from D1's primary-only writes; Stage 0 adds a test in which two concurrent verifies of one token yield exactly one session]

### 5.2 Owners

| Item | Rule |
|---|---|
| Invite | Admin-only creation. Always emailed, never shown to the admin (§3.2). Expires after 7 days, single use. Link: `${APP_ORIGIN}/invite#<token>`. On accept:<br>(0) If the invite's email belongs to a disabled owner, return `403 owner_disabled` without claiming the token.<br>(1) Claim the token with the conditional update in §5.1.<br>(2) One `batch()`: `INSERT INTO owners … ON CONFLICT(email) DO NOTHING`, then create the site for the owner with that email, set `invites.owner_id` and `invites.site_id`, create the session, write the audit row.<br>If (2) fails, set `used_at = NULL` on that invite and return `500 internal`, so the owner can simply retry the link. |
| Magic link | `POST /api/auth/login` always answers 202; the rest runs in `ctx.waitUntil`. If the owner exists, is not disabled, and has fewer than 5 tokens in the last hour and 10 in the last day: create a token valid for 15 minutes and email `${APP_ORIGIN}/login#<token>`. The login page shows a "Sign in" button; only that click sends the fragment token to `/api/auth/login/verify` (no automatic submit: some mail scanners run page scripts). The daily cap matters because Resend Free allows only 100 emails a day for the whole account [verified: resend.com/pricing], and a flood of sign-in requests must not stop lead emails. |
| Session | 30 days, fixed (not extended by activity). `last_seen_at` is updated at most once per hour. Logout deletes the session. Disabling an owner deletes all their sessions. Expired sessions and tokens are deleted by the app Worker's daily cron. |
| Tokens in the URL fragment | The fragment is never sent to a server, so it never reaches logs or `Referer`. Email scanners that follow links do not consume it, because consuming needs a POST that only a button press sends. After use the page calls `history.replaceState` to drop the fragment. `Referrer-Policy: no-referrer` is sent anyway. |
| Accessible authentication | No password and no puzzle (WCAG 2.2 3.3.8). |

### 5.3 Admins

- **Cloudflare Access** (Zero Trust) application on `admin.<root>/*`. The policy allows the admin email list and uses an identity provider with MFA (the user picks: Google or GitHub). The free Zero Trust plan covers up to 50 users. [verified: Cloudflare blog "Zero Trust For Everyone"; the plans page did not render its details]
- **The Worker verifies again**, as defence in depth:
  - Read the `Cf-Access-Jwt-Assertion` header.
  - Run `jwtVerify(token, createRemoteJWKSet(new URL(ACCESS_TEAM_DOMAIN + "/cdn-cgi/access/certs")), { issuer: ACCESS_TEAM_DOMAIN, audience: ACCESS_AUD })` with `jose` 6.2.12. The header, certs URL and aud/iss/exp claims are as documented. [verified]
  - Then require `payload.email`, trimmed and lower-cased, to be in `ADMIN_EMAILS` (a comma-separated variable, compared lower-cased).
  - Any failure returns `403 forbidden`.
- **Local development:** `ADMIN_AUTH_MODE = "dev"` is honoured only when the request hostname is `localhost` or ends with `.localhost`. The identity is then `DEV_ADMIN_EMAIL`. The production config sets `"access"`. A unit test fails the build if the production wrangler config contains `"dev"`.
- **CSRF protection for admin** is the same as for owners: the `Origin` must equal `ADMIN_ORIGIN`, plus the JSON content type.

---

## 6. Generation (Plan 3)

### 6.1 Contract

- **Input:** `GenerationInputSnapshot { facts: Facts; brief: Brief }`. This is the parsed output of both schemas, frozen into `generations.input_json` when the request is made.
- **Output:** an `AiDraft` such that `SiteDocument.safeParse({ facts, ...draft, hidden: [] }).success`. Consequences:
  - The layout lists every `factSections(facts)` entry (Decision #16).
  - The layout starts with the hero.
  - `serviceDescriptions` match the services.
  - The copy passes every Plan 1 rule.
- **Privacy:** Plan 3 sends the model only `toModelFacts(facts)`. That covers the business name, trade, city and state, service names and flags (`insured`, `emergency247`, `freeEstimates`, whether licences exist, `yearFounded` present or not), service-area places and the brief. Phone, email, street, ZIP, licence numbers, testimonials, photo URLs and social links are never sent; the copy cannot use them anyway.

### 6.2 Provider interface (internal to `@asksite/generation`)

```ts
export interface ModelRequest {
  system: string; user: string;            // Plan 3's prompt; owner text is quoted as data
  jsonSchema: Record<string, unknown>;     // z.toJSONSchema(AiDraft); refinements are checked afterwards by SiteDocument.
  maxOutputTokens: number; signal: AbortSignal;
}
export interface ModelResponse {
  json: unknown; model: string;
  usage: { inputTokens: number; outputTokens: number };
  stop: "end" | "max_tokens" | "refusal" | "other";
}
export interface ModelProvider { readonly id: "anthropic" | "openai-compatible" | "fake"; generate(req: ModelRequest): Promise<ModelResponse> }
export class ProviderError extends Error { constructor(readonly kind: "timeout" | "rate_limited" | "unavailable" | "bad_request" | "auth", message: string) { super(message) } }
export interface ModelPrice { inputMicrousdPerToken: number; outputMicrousdPerToken: number; source: string; checkedOn: string }
```

Provider is chosen by the `MODEL_PROVIDER` and `MODEL_ID` variables:

| Provider | How it is called | Secret |
|---|---|---|
| `anthropic` | Messages API, structured output | `ANTHROPIC_API_KEY` |
| `openai-compatible` | `POST ${OPENAI_COMPAT_BASE_URL}/chat/completions` with `response_format: { type: "json_schema", … }`. Base URLs: Workers AI `https://api.cloudflare.com/client/v4/accounts/<account_id>/ai/v1` with a Bearer API token [verified: Workers AI "OpenAI compatible API endpoints" page]; the Hugging Face router `https://router.huggingface.co/v1` [verified]; Groq, Together, OpenRouter (model-options note §2) | `OPENAI_COMPAT_API_KEY` (for Workers AI: an API token limited to Workers AI) |
| `fake` | returns `templateDraft()`. `FAKE_MODE` = `ok` \| `invalid-once` \| `invalid-always` \| `timeout` \| `error` scripts failures for tests. | none |

Plan 3 verifies each provider's request and response format against its official docs before coding it. The Anthropic structured-output parameter names must come from the official docs or the `claude-api` skill, not from memory.

JSON schema facts checked on 2026-09-24:
- `z.toJSONSchema` over `z.strictObject({ copy: Copy, layout: Layout, theme: Theme })` runs on zod 4.6.5 and yields 3,366 bytes with `maxLength`, `maxItems`, `default` and a `oneOf` for the layout's discriminated union; `.normalize()`/`.refine()` are simply left out. [verified: ran it in the scratchpad against `packages/site-schema/src`]
- Anthropic structured outputs take the schema in `output_config.format`, support `anyOf` but do not list `oneOf`, and do not support `minLength`/`maxLength`, `maxItems`, `minItems` above 1 or `pattern`; the official SDKs strip unsupported constraints and validate against the original schema. [verified: platform.claude.com structured-outputs page] So the `anthropic` adapter must rewrite `oneOf` to `anyOf` (safe here: the branches are told apart by the `id` constant) and strip the unsupported keywords, or use the SDK helper that does this. Each adapter has a test that sends its real transformed schema shape through a recorded fixture.
- **Why no separate Workers AI binding adapter (KISS):** the model-options note recommends two real adapters, Anthropic and OpenAI-compatible, and Workers AI offers an OpenAI-compatible endpoint. That drops a third adapter, the per-model input-format differences of `env.AI.run` (chat `messages` vs a Responses-style `input`), and an `AI` binding that cannot run locally. The cost is one scoped secret. The Workers AI "OpenAI compatible" page does not mention `response_format`/`json_schema` [verified: absent from the page], so whether the schema passes through that endpoint is [unverified]; the evaluation measures it. If it does not and a Workers AI model is still wanted, the moderator may add a binding-based adapter behind the same interface; nothing outside `@asksite/generation` changes.

**Data use:** a provider route is allowed only if its terms say it does not train on or let humans review our inputs. Never configure a free route that may do so (for example OpenRouter `:free` models served from Google AI Studio's unpaid tier). [verified: model-options note §2]

### 6.3 The job

`apps/generator` `queue()` handler. Each message is `{ v: 1, generationId }`. After the claim in step 1 the handler never throws: every path ends in the terminal write of step 4, so a queue retry happens only when the runtime itself dies.

Constants: `MAX_ATTEMPTS = 3`; 90 s per attempt; `JOB_STUCK_AFTER_MS = 6 × 60,000` (the longest normal job is 3 × 90 s plus 8 s of backoff, about 4.6 minutes). The consumer's wall-clock limit is 15 minutes. [verified: Queues limits page]

1. **Claim the job and, in the same statement, one of today's model calls.** One statement, so the daily limit is exact under concurrent consumers:
   ```sql
   UPDATE generations
   SET status = 'running', started_at = :now,
       model_slot = CASE WHEN :enabled = 1
                          AND (SELECT COUNT(*) FROM generations WHERE model_slot = 1 AND started_at >= :dayStart) < :limit
                         THEN 1 ELSE 0 END
   WHERE id = :id AND status = 'queued'
   ```
   - `:enabled` is the kill switch: `GENERATION_ENABLED === "true"` **and** the setting `generation.enabled` is not `"false"`. `:limit` is the setting `generation.daily_model_limit`, else the variable `DAILY_MODEL_LIMIT`. `:dayStart` is 00:00 UTC of `:now`.
   - `changes = 1`: this invocation owns the job; continue.
   - `changes = 0`: another delivery owns it, it is finished, or the sweeper took it. Acknowledge and stop. This makes duplicate or concurrent delivery safe.
2. **No model call allowed** (`model_slot = 0`): go to step 4 with no output. The reason is `disabled` if the kill switch is off, else `budget`.
3. Run up to **3 attempts** (`MAX_ATTEMPTS`).
   - Each attempt has a 90 s `AbortSignal.timeout`.
   - Transient `ProviderError` (`timeout`, `rate_limited`, `unavailable`) is retried inside the attempt budget after 2 s and then 6 s.
   - After each response, run `SiteDocument.safeParse({ facts, ...draft, hidden: [] })`. On failure, the next attempt includes the `toIssues()` list as repair feedback.
   - Token usage is added up across attempts. `cost_microusd` comes from the `ModelPrice` table and is for reporting only.
4. **Terminal write**, always `… WHERE id = :id AND status = 'running'`, so a late or duplicate invocation never overwrites another one or the sweeper:
   - valid output: `output_json`, `status = 'succeeded'`, provider, model, tokens, cost, `finished_at`;
   - otherwise, apply the fallback rule below.

**Fallback rule:**
- `kind = 'first'`: if there was no model call (`disabled` or `budget`) or the attempts ended without valid output (`provider_error` or `invalid_output`), write `templateDraft(facts, brief)` as the output. The row gets `succeeded`, `used_fallback = 1` and `fallback_reason`. `templateDraft` is deterministic, trade-aware copy that passes the claim checker for any facts. For example, it never names a service inside prose, because service names may contain digits. Plan 3 tests it against every Plan 1 fixture and against property-generated facts.
- `kind = 'regenerate'`: write `failed` with `error_code` (`generation_disabled`, `budget_exhausted`, `provider_unavailable`, `provider_timeout` or `invalid_output`). The owner keeps the current wording.

**Cost limits are counts, not money.** Each job that may call the model holds one model slot, and at most `:limit` slots are taken per UTC day across all owners; per-site and per-owner counts are enforced when the job is requested (§6.4). One job's cost has a hard ceiling: `MAX_ATTEMPTS × (maxInputTokens × inputPrice + maxOutputTokens × outputPrice)`. The prompt is built only from capped inputs (§2.8 `Brief`, `toModelFacts`, the issue list), so Plan 3 measures `maxInputTokens` once per provider with every input at its cap, adds a safety margin, and exports `worstCaseJobMicrousd(provider, modelId)`. The admin settings show `limit × worstCaseJobMicrousd` as the worst case per day. Example [inferred, token counts assumed]: Opus 5.5 at 8k input and 4k output tokens per attempt is 3 × ($0.032 + $0.08) ≈ $0.34 per job, so the shipped 8 per day caps worst-case spend at about $10.65 per day on Opus 5.5 ($1.33 per-job ceiling; 30 per day would be $39.95 — M1); typical spend is a small fraction. The provider-side spend limit (§12) is the money backstop. This replaces an earlier money-reservation design (reserve, settle, release, crash conversion, a `spend_days` table and owner balances): counts give the same hard bound with one atomic statement and do not depend on a correct price table for safety.

**Sweeper.** The generator's cron runs `*/5 * * * *`. For each row still `queued` with `created_at`, or `running` with `started_at`, older than `JOB_STUCK_AFTER_MS`: a `first` job gets the template fallback (`succeeded`, `used_fallback = 1`, `fallback_reason = 'provider_error'`); a `regenerate` job gets `failed` with `internal`. Each write is conditional on the status the sweeper read. So every generation reaches a final status within about 12 minutes of its request (6-minute threshold + 5-minute cron + slack), and a first build always ends with a draft unless writing the template itself fails.

### 6.4 What Plan 3 exports to Plan 4

```ts
export async function requestGeneration(
  env: { DB: D1Database; GEN_QUEUE: Queue<GenerationJob>; GENERATION_ENABLED: string; DAILY_MODEL_LIMIT: string },
  input: { siteId: string; ownerId: string; snapshot: GenerationInputSnapshot; now: number },
): Promise<
  | { ok: true; generation: GenerationView }
  | { ok: false; code: "generation_in_progress" | "generation_cap_reached" | "generation_disabled" | "budget_exhausted" | "internal" }
>;
export async function generationAllowance(
  env: { DB: D1Database }, input: { siteId: string; ownerId: string; now: number },
): Promise<{ generationsLeftToday: number; generationsLeftTotal: number }>;
export function isGenerationEnabled(env: { DB: D1Database; GENERATION_ENABLED: string }): Promise<boolean>;
/** Daily limit in force: the setting, else DAILY_MODEL_LIMIT. Used by admin settings. */
export function dailyModelLimit(env: { DB: D1Database; DAILY_MODEL_LIMIT: string }): Promise<number>;
/** Hard ceiling of one job's cost for this provider and model (§6.3); null = no recorded price (M3). Used by admin settings. */
export function worstCaseJobMicrousd(provider: string, modelId: string): number | null;
export function toGenerationView(row: GenerationRow): GenerationView;
```

How `requestGeneration` works:
- `kind` is `first` when the site has no succeeded generation, otherwise `regenerate`.
- For `regenerate`, it pre-checks the kill switch (`generation_disabled`) and whether today's model limit is used up (`budget_exhausted`), so the owner hears at once. These pre-checks are advisory; the exact check is the claim in §6.3 step 1. For `first`, it never blocks on them (fallback, §6.3).
- It inserts the `queued` row with one conditional statement, so the per-site daily count and the per-owner total are exact even for an owner with two sites acting at once. The per-site daily count covers every kind. The per-owner total counts only `regenerate` rows, and a `first` job is never refused by it (D2); `generationAllowance` computes `generationsLeftTotal` the same way:
  ```sql
  INSERT INTO generations (id, site_id, owner_id, kind, status, input_json, created_at)
  SELECT :id, :site, :owner, :kind, 'queued', :input, :now
  WHERE (SELECT COUNT(*) FROM generations WHERE site_id = :site AND created_at >= :dayStart) < :perSiteDay
    AND (:kind = 'first'
         OR (SELECT COUNT(*) FROM generations WHERE owner_id = :owner AND kind = 'regenerate') < :perOwnerTotal)
  ```
  A violation of the unique index `generations_one_active` means `generation_in_progress`; `changes = 0` means `generation_cap_reached`.
- It sends `{ v: 1, generationId }`. If `send` throws, it marks the row `failed` with `internal` (conditional on `queued`) and returns an `internal` error, so the one-active index never blocks the site. Then it writes the `generation.requested` audit row.

### 6.5 Prompt injection and cost abuse

- Owner text (brief, comments, business name) is untrusted and is placed in the prompt as quoted data. The model gets no tools.
- Any successful injection is limited to the owner's own draft. That draft must still pass the schema and claim checker, is visible to the owner, and is reviewed by a human before going live.
- Brief lengths are capped (§2.8). Costs are bounded by the per-site daily count, the per-owner total, the global daily model limit (each job's cost has a hard ceiling, §6.3), the one-active-job index and the kill switch. The user should also set a spend limit in the provider's console (§12).

### 6.6 Answer to "Can we use a Hugging Face or other free open-source model? Would we have to deploy it?"

The detailed, source-checked comparison is `docs/superpowers/specs/2026-09-24-model-options.md`. Where the two differ, that note's facts win and this design's interfaces win (its `CopyGenerator` sketch is superseded by §6.2's `ModelProvider`, and its "hand it to a human" step by the §6.3 fallback rule).

- **Yes, and nothing to deploy.** Open-licence models (gpt-oss-120b, Apache-2.0; Gemma 4 26B A4B, Apache-2.0; Qwen3.8-27B, Apache-2.0; each licence read from the model's own licence file) are sold as pay-per-token APIs by Cloudflare Workers AI, Groq, Together, OpenRouter and the Hugging Face router. We send one HTTPS request, exactly as for Claude. The `ModelProvider` interface makes it a configuration change. [verified: model-options note §1–2]
- **"Free" means a free licence, not free computing.** Workers AI gives 10,000 Neurons a day on Free and Paid, then $0.011 per 1,000 Neurons on Workers Paid; that covers roughly 30 sites a day on gpt-oss-120b, 90 on Gemma 4 26B or 12 on Qwen3.8-27B at one attempt each [inferred from verified prices, note §6]. Hugging Face gives $0.10 of credit a month free ($2 on PRO) and passes provider prices through with no markup. These are enough for the evaluation and a small pilot, not a base for a paid product. Never send real owner data to a free route that may train on it or let humans read it (§6.2 "Data use").
- **Workers AI JSON-schema output is best effort.** The JSON Mode page says it "can't guarantee" schema compliance and can fail with "JSON Mode couldn't be met". [verified] Our validate-and-repair loop and the template fallback absorb those failures; the eval counts them.
- **Self-hosting is the only option that means deploying**: a GPU server around the clock costs about $250 to $2,100 a month each, two for redundancy, to save tens of dollars a month at our volume; this Mac took 14 minutes for one site on a 7B model and broke our rules. Rejected. [verified prices and run, note §3]
- **Cost is not the deciding factor:** at 1,000 sites a month, about $32 on Sonnet 5, $64 on Opus 5.5, under $10 on the open models. [inferred, note §6]
- **Quality is the real risk.** No provider enforces our length, no-digit and claim rules; our validators do, for every model. The question is first-try pass rate and wording quality, which only our own test measures.
- **The evaluation** follows the note's §7 protocol: 20 made-up businesses (6 trap profiles, 4 edge, 10 ordinary), 3 runs each per model, the same prompt and validators. `pnpm eval:generation` (Plan 3; runs only when keys are present) reports first-try pass rate, pass rate within 2 retries, which rule failed, p50/p95 latency and cost per passing site. The blind human rating and the proposed gate (≥ 95 % pass within 2 retries, ≥ 80 % first try, no unbacked claim found by a human, mean score within 0.3 of Claude) are a manual step the user runs on its output (§12).
- **Prices already recorded:** Opus 5.5 $4 / $20 per million tokens; Sonnet 5 $2 / $10 (the note found the introductory price "is now the standard price"); Haiku 4.5 $1 / $5. [verified 2026-09-24, note §4]

---

## 7. Publish, serving, takedown, leads (Plan 2)

### 7.1 Rendering a version

The app Worker receives the publish request, composes the document and validates it. It then calls `createPendingVersion` with the **parsed** document (`SiteDocument.safeParse(...).data`, §2.5), which renders the site with Plan 1's `render()`:
- `stylesheets` is `DESIGN_CSS` from `@asksite/site-css`: one compiled sheet per design (A12). `render()` inlines the sheet of the document's own design, so a caller can never pair a page with another design's sheet.
- `formAction` is `formActionUrl(ROOT_DOMAIN, slug, siteId)`. Plan 1 `render()` requires `https:`, and the local development setup is https too (§10). `siteUrl` is `siteUrl(ROOT_DOMAIN, slug)`: an https origin with its final `/` and nothing else (it builds each page's canonical URL).
- `render()` is synchronous, pure and deterministic. It returns a `RenderedSite`: `{ design, stylesheetSha256, pages }`, where `pages` is `{ page, path, html }[]`, Home first, one per page the site has (§2.9). It does not hash: publishing hashes each page (`hashPages`, then `pagesDigest`, §2.5). The version stores `stylesheet_sha256 = stylesheetSha256` for audit.

### 7.2 `@asksite/publishing` (Plan 2)

Every function takes `now`. Every function that changes a site's state writes its audit row.

```ts
export class PublishError extends Error {
  constructor(readonly code: "render_failed" | "nothing_pending" | "version_not_pending" | "site_taken_down" | "integrity" | "not_live"
    | "publish_cap_reached" | "site_not_found"
    | "live_copy_failed"  // A16: the pointer write failed or is unconfirmed; the same action again finishes it
    | "site_busy",        // A16-4c: another admin action on the site is running ({ retryAfter }), or this one's lease ran out ({ reason: "lease_lost" })
    readonly detail?: unknown) { super(code) }
}
export async function createPendingVersion(
  env: { DB: D1Database; WORK: R2Bucket; ROOT_DOMAIN: string },
  input: { siteId: string; ownerId: string; slug: string; document: SiteDocument; edits: OwnerEdits; generationId: string | null; now: number },
): Promise<VersionSummary>;
// 1) Cheap refusals first (the site is the owner's, not taken down, under the day's publish cap, still has this slug, the
//    generation is this site's): a refused request renders and stores nothing.
// 2) site = render(document, …) (RenderedSite, §7.1); on throw -> PublishError("render_failed", issues). Each page is hashed;
//    pages_json = canonicalJson of [{ page, sha256 }]; html_sha256 = pagesDigest(pages).
//    document_json = canonicalJson(document); document_sha256 = documentSha256(document) (§2.5).
// 3) PUT WORK versionPageKey(siteId, versionId, page) for every page, with metadata { siteId, versionId, page, sha256 }.
// 4) batch(): current pending -> 'superseded'; INSERT the new version (number = max + 1) 'pending', with pages_json, html_key
//    (Home's WORK key) and html_sha256 (the digest); sites.pending_version_id = id, updated_at = now; audit version.requested.
//    The batch re-checks the owner, slug, takedown and cap. If it refuses, the stored pages are deleted again (only when no
//    version row names them; orphans are harmless: nothing serves WORK publicly) and the refusal is explained.
export async function withdrawPending(env: { DB: D1Database }, input: { siteId: string; ownerId: string; now: number }): Promise<void>;
export async function approveVersion(
  env: { DB: D1Database; WORK: R2Bucket; LIVE: R2Bucket; ROOT_DOMAIN: string },
  input: { versionId: string; htmlSha256: string; reviewer: string; note: string | null; indexable: boolean; now: number },
): Promise<{ siteId: string; slug: string; liveUrl: string }>;
// What the admin was shown is what goes live, every page of it at once (U2). Under the site's lease (below):
// 1) input.htmlSha256 must equal the row's html_sha256 (the digest), else PublishError("integrity", { reason: "reviewed_hash_mismatch" }).
// 2) A version that will be refused copies nothing: it must be the site's pending version (or the accepted retry: approved,
//    live and not taken down), else version_not_pending; a taken-down site is site_taken_down.
// 3) Verify: pages_json must parse as VersionPages, hash (pagesDigest) to html_sha256 and start with the page html_key names, and
//    every page's stored WORK bytes must still hash to its sha256; else PublishError("integrity", { reason: "pages_invalid" |
//    "pages_digest_mismatch" | "stored_bytes_mismatch" }), with nothing changed yet.
// 4) Copy every verified page to its own immutable LIVE key livePageKey(slug, versionId, page). Nothing is served from them yet.
// 5) D1, conditional, in one batch(), fenced by the lease token: sites.live_version_id = this version, pending cleared,
//    indexable set; the version -> 'approved'; audit version.approved. If nothing changed and the version is already approved,
//    is the live version and the site is not taken down -> continue (idempotent retry after a failed step 6); otherwise ->
//    version_not_pending or site_taken_down (or site_busy if the lease was lost).
// 6) ONE write of the LIVE pointer livePointerKey(slug) (an empty object with metadata { siteId, versionId, businessName,
//    phoneText, phoneTel, writer }; writer is this call's own random id, never the lease token, read only by the
//    publishing take-back and ignored by the sites Worker) switches every page at once. If it fails after step 5, live_copy_failed is thrown and approving
//    the same version again, or "Copy the live pages again", finishes it.
// 7) The post-write takedown re-check: taken_down_at is read again, whether the write resolved or rejected. If a takedown
//    committed meanwhile (only possible once the lease ran out), the action takes back its own pointer write, and any pointer while this action holds the lease on a site D1 shows down, and site_taken_down is thrown.
//    A rejected write on a site that is not down is live_copy_failed, and so is a failed read (after a best-effort pointer delete).
// 8) The other versions' LIVE pages are removed (best effort, logged, never thrown): see "the cleanup" below.
export async function rejectVersion(env: { DB: D1Database }, input: { versionId: string; reviewer: string; note: string; now: number }): Promise<{ siteId: string }>;
export async function takeDown(env: { DB: D1Database; LIVE: R2Bucket; MEDIA: R2Bucket }, input: { siteId: string; reviewer: string; reason: string; purgeMedia: boolean; now: number }): Promise<void>;
// Under the lease. In order: 1) DELETE the LIVE pointer: it stops every page at once, cached ones included (§7.3). If that fails
// the takedown fails with nothing changed in D1, and the admin retries. 2) the D1 batch: taken_down_at, takedown_reason,
// pending_version_id = NULL; the pending version (if any) -> 'rejected' (review_note = TAKEDOWN_REVIEW_NOTE, "Site taken
// down", exported from @asksite/core); audit. 3) DELETE the pointer again (an approve that wrote a pointer in between, once its
// lease ran out, is undone), then 4) delete every object under liveSitePrefix(slug): every LIVE page. 5) If purgeMedia, list and
// delete MEDIA <siteId>/ and set uploads.deleted_at. Idempotent: call it again to retry the deletes. Only the first call writes
// the takedown audit row; a later call whose purge deletes anything writes its own.
export async function restore(
  env: { DB: D1Database; LIVE: R2Bucket; WORK: R2Bucket; MEDIA: R2Bucket; ROOT_DOMAIN: string },
  input: { siteId: string; reviewer: string; expectedTakenDownAt: number; now: number },
): Promise<{ liveUrl: string; missingPhotos: number; healed: boolean }>;
// Of a TAKEN-DOWN site only. expectedTakenDownAt is the taken_down_at the admin's page showed: a different one (restored and
// taken down again since) is PublishError("site_taken_down", { reason: "taken_down_again" }) before any R2 write; a site that is
// not taken down is already restored and comes back with the normal result (and its pointer checked, a missing or wrong one healed: see below). Requires a live version (else
// "not_live"). Verify the live version's pages as approve's step 3, copy every page to LIVE, write the pointer (D1 still says taken down: on an
// edge-cache MISS the Worker checks D1 and does not serve it, but a page copy already in the edge cache under that version, s-maxage=60 from
// before the takedown, can be served with no D1 check once the pointer exists), then clear taken_down_at, fenced on the expected time, the copied version and the lease. If the
// clear changes nothing, D1 is asked before the pointer goes: a site still down (or gone, or a read that throws) has this call's own
// pointer write taken back out (and any pointer when the re-read shows this call holds the lease on the down site), a site that is live (another restore made it live after this one outlived its lease) keeps it; either way site_busy (lease_lost).
// If the clear throws, D1 is asked (it can commit a batch and still throw): a committed clear keeps the pointer and succeeds; a site
// still down, or a read that throws too, takes this call's own pointer write back out (any pointer under the same lease rule) and rethrows; a live site with another version (only after a lost
// lease) is left alone and is site_busy (lease_lost). A REJECTED pointer write asks D1 the same way: still down or unreadable, this call's own
// pointer write is taken back out (any pointer under the same lease rule) and the answer is live_copy_failed, the site not served (call restore again); live, the pointer is left and the
// answer is site_busy (lease_lost). All three take-backs are one helper, and a take-back removes its own write (the pointer's
// `writer` is this call's own id) and any pointer while this call holds the lease on a site D1 shows down; with the lease lost, a pointer another restore wrote, even before its clear commits, is left alone. RESIDUAL: the helper's
// HEAD and delete are two R2 calls and R2's delete takes no condition, so another action's pointer written between them is removed and
// the site has no pointer; losing a VALID pointer this way needs this action to have outlived its lease (over ADMIN_LEASE_MS), while
// another action's late put landing there under this call's lease only removes a late pointer from a down site. Likewise a re-read that THROWS after
// another restore made the site live is treated as down, so this call's own pointer is taken out of a live site, and a HEAD that throws
// deletes whoever's pointer it is. Restore again or Copy the live pages again heals it (`healed: true`). RULED RESIDUAL: a stale pointer from an earlier failed take-back stays on a down site when this action's re-read throws or its lease is lost; the host's 404 may show the business name until Take down again (logged takedown_pointer_left). Then the
// cleanup. missingPhotos counts photos a purge deleted: the page still goes back up. Retry-safe: an already-restored site's
// pointer is HEAD-checked under the lease; a missing one, or one naming another version, is healed (the same copy-and-point
// sequence as copyLivePagesAgain) and `healed` is true; a right pointer is left alone, `healed` false (as on a normal restore).
export async function copyLivePagesAgain(
  env: { DB: D1Database; LIVE: R2Bucket; WORK: R2Bucket; ROOT_DOMAIN: string },
  input: { siteId: string; reviewer: string; now: number },
): Promise<{ liveUrl: string }>;
// NEW (A16-4c): "Copy the live pages again" on a LIVE site: verify the live version's pages, copy every page back to LIVE,
// rewrite the pointer, re-read taken_down_at (as approve's step 7: a site taken down meanwhile has this call's own pointer write taken back, and any pointer while this
// call holds the lease on a site D1 shows down, and is site_taken_down; a failed read is live_copy_failed after a best-effort pointer delete), then the cleanup. It writes no D1 state and no audit row (Plan 4 may record the admin action itself). A
// taken-down site is site_taken_down (it never touches taken_down_at); no live version is not_live; a rejected pointer write
// is live_copy_failed (call it again).
export async function setIndexable(env: { DB: D1Database }, input: { siteId: string; reviewer: string; indexable: boolean; now: number }): Promise<void>;
// D1 update only; the sites Worker reads sites.indexable (§7.3).
```

**The per-site admin lease (A16-4c).** Two admins' actions (or an action and its retry) on one site must not interleave their R2 and D1 writes, so `approveVersion`, `takeDown`, `restore` and `copyLivePagesAgain` each take a lease on the `sites` row (migration 0006, §2.5):
- `acquireLease` is one conditional `UPDATE sites SET admin_lock = <random token>, admin_lock_until = now + ADMIN_LEASE_MS WHERE id = ? AND (admin_lock IS NULL OR admin_lock_until < now)`. `ADMIN_LEASE_MS` is 120 s, assumed to be longer than any admin action. A site held by another action is `site_busy { retryAfter }` (seconds to wait); a site that does not exist is the action's own error (`version_not_pending` for approve, `site_not_found` for the others). An action that dies frees the site when its lease runs out, and a takedown may wait up to that long behind a hung action (accepted: it answers `site_busy` and the admin retries).
- **The state writes carry the token**: the `sites` updates are conditioned on `admin_lock = <token>` directly, and the `site_versions` and `uploads` writes on an `EXISTS` over the `sites` row: `EXISTS (SELECT 1 FROM sites WHERE id = ? AND admin_lock = ?)` for takedown's and the purge's, and approve's `site_versions` update `EXISTS (SELECT 1 FROM sites WHERE id = ? AND live_version_id = ? AND admin_lock = ?)`. Each audit row is written only when the fenced statement before it changed a row, except a repeat takedown's purge row, which is written whenever the purge deleted objects. When a fenced write changes no row, `assertLease` tells "already done" from a lost lease: it throws `site_busy { reason: "lease_lost" }` unless the token still holds the site.
- **R2 cannot be conditioned on D1**, so `assertLease` is also called right before each pointer write or delete and before the LIVE prefix delete (the MEDIA purge is not lease-checked). The take-back deletes (approve's deletes after its takedown re-read, restore's pointer take-back, and those of the shared copy-and-point step used by copyLivePagesAgain and restore's heal) are deliberately NOT re-checked: they remove a pointer from a site D1 says is down (or whose state cannot be read), and a check there could leave the pointer on a taken-down site. A take-back removes its own write, and any pointer while this action holds the lease on a site D1 shows down: each action call that writes the pointer stores its own random write id in the pointer's metadata as `writer` (never the lease token; the sites Worker ignores it), and one shared helper, given the one D1 re-read of `taken_down_at` and `admin_lock`, deletes the pointer whatever its writer when that row shows the site down and `admin_lock` equal to this action's own token (and, as below, when a HEAD of the pointer throws) (acquireLease writes a new token on every takeover, so a match proves none happened; no expiry check is needed; this removes a stale pointer an earlier failed action left on the down site). Otherwise (the lease lost, the site gone, D1 unreadable) it deletes the pointer only when a HEAD of it shows that call's own `writer` (a missing pointer needs no delete; a pointer another action wrote is left alone). A HEAD that throws deletes, takedown safety first, so it can remove another action's pointer (the availability cost: Restore or Copy the live pages again heals it). R2's delete takes no condition, so another action's pointer written between that HEAD and the delete is still removed. NAMED RESIDUAL of the any-pointer rule: a takeover, its full page copy and its pointer put all landing between this re-read and the delete (then this delete removes the new holder's pointer: the site is live with no pointer until Restore again / Copy the live pages again heals it). RULED RESIDUAL (2026-10-05): a stale pointer from an earlier failed take-back stays on a down site when this action's re-read throws or its lease is lost; the host's 404 may show the business name until Take down again (logged takedown_pointer_left). Restore's take-backs ask D1 first and leave the pointer of a site that is live.
- The release (`releaseLease`) clears only its own token, so a lease another action took over is left alone; a failed release is logged (`lease_release_failed`, ids only) and never masks the action's result.
- **The cleanup** (`removeOtherVersions`, after approve, restore and `copyLivePagesAgain`) deletes every LIVE page that is not the kept version's, a listing page at a time (R2 lists and deletes at most 1,000 keys a call), and re-reads D1 before each delete: it goes on only while D1 still names the kept version as live and the action's lease is still its own, else it stops and logs `live_cleanup_skipped`. A failure is logged (`live_cleanup_failed`), never thrown; the next approval or restore removes the orphans.
- **Residuals, as the code states them** (`packages/publishing/src/shared.ts`, `site-state.ts`): (1) if the lease runs out between an `assertLease` check and the R2 call (only an action longer than `ADMIN_LEASE_MS`), that R2 write can land after another action's; the D1 fence still keeps D1 right. On a cache miss the sites Worker serves only when D1 says the site is live and not taken down and the pointer's version equals D1's live version (a mismatch is a `503`, never wrong bytes, §7.3); a page already in the edge cache under the pointer's version is served with no D1 check, for up to its 60 s `s-maxage`, so a late pointer write on a taken-down site can be served for that long. `approveVersion`, `restore`'s heal and `copyLivePagesAgain` re-read `taken_down_at` after their pointer write and take back their own pointer write, and any pointer while this action holds the lease on a site D1 shows down, from a site that went down. (2) Pages of a version that approve copied and that never became live (approve failed or was refused before its D1 batch made it live: `lease_lost`, `site_taken_down`, `version_not_pending`, an R2 error), and other versions' pages a stopped cleanup left, stay in LIVE unserved (the pointer never names them) until the next approval's or restore's cleanup or a takedown removes them. Pages `restore` or `copyLivePagesAgain` copied before a refusal are the live version's own: no cleanup removes them, and the next successful call serves them.
- `ADMIN_LEASE_MS`, `acquireLease`, `assertLease` and `releaseLease` are exported by `@asksite/publishing` for Plan 4's ops sweep, which must take the lease with them and never copy the SQL.
- **PLANNED, not built (Plan 4):** the HTTP mapping of `site_busy` (`409` with `Retry-After`), the restore page sending `expectedTakenDownAt` and the admin route for "Copy the live pages again" (§4.5).

### 7.3 The sites Worker

1. Parse the Host with `parseHost(url.host, ROOT_DOMAIN)`. On a site host, `GET` or `HEAD` of `/favicon.ico` is a `204`.
2. **Page** (`GET` or `HEAD` of exactly one of the 5 paths in the page map, §2.9: `/`, `/services`, `/about`, `/gallery`, `/contact`; any query string is ignored). The site's **LIVE pointer** says which version is live, D1 decides whether to serve, and R2 holds the bytes (`apps/sites/src/page.ts`):
   - `LIVE.head(livePointerKey(slug))`. An R2 error: a `503` noindex page with `Retry-After: 60`. No pointer (never approved, unknown, or taken down: a takedown deletes it first): a `404` noindex page, not cached, **and no D1 read** (Decision 24). A pointer whose `versionId` is not a valid id is damaged: `503`; it never chooses a key.
   - Look in `caches.default` under `pageCacheUrl(root, slug, versionId, page)`: the version id is in the PATH, so a cached page can only be served for the version the pointer names, and a cached page of a replaced version is never read again. On a hit, return it with the browser headers below (no D1 read).
   - On a miss, `LIVE.get(livePageKey(slug, versionId, page))`. If the object is missing, the pointer is **re-read once** (A16-4c: an approval switches the pointer and then deletes the replaced version's pages, so a view that read the old pointer can find its page gone); if it now names another valid version, that version is served the same way (its own cache key, the same D1 check). If it is still missing: for Home a `503` (a broken state); for another page a `404` noindex page that links Home, named from the pointer's metadata (a page the site does not have), not cached, no D1 read.
   - Then `SELECT indexable, live_version_id FROM sites WHERE slug = ? AND live_version_id IS NOT NULL AND taken_down_at IS NULL`. No row: a `404` noindex page, not cached. D1 error: a `503` noindex page with `Retry-After: 60`, not cached (a 503 tells search engines the outage is temporary). A pointer version other than D1's `live_version_id` (an approval or restore half-way, or a late write of an older version) is a `503`, never served, not cached.
   - Otherwise respond `200` with the §7.4 headers. `X-Robots-Tag: noindex` is added when `sites.indexable = 0`.
   - `cache.put` of a copy with `Cache-Control: public, s-maxage=60` (Cloudflare does not cache a response marked `no-cache`; `s-maxage` sets the edge TTL). **Browsers get `Cache-Control: no-cache`**, a cached copy included: a page cached by a browser could otherwise sit next to a newer one (U2), and every revalidation goes through the pointer.
   - Cache API entries stay in the originating data centre, and `cache.delete` purges only that one. [verified] An approval or a takedown goes through the pointer, which is read on every request, so it takes effect at once; a change only D1 knows (the search-engine switch, a takedown written to D1 alone) spreads within the edge TTL of about 60 s.
   - **Redirect:** `GET` or `HEAD` of `/services/`, `/about/`, `/gallery/` or `/contact/` is a `301` to the canonical `publicPageUrl` (Home has no such form). Every other path is the `404` noindex page, which on a live site links the business's page, named from the pointer alone (never D1: Decision 24); a `POST` to any of these paths is that `404` too.
   - **Cost** (Decision 24): a wrong path, a missing page, an unknown slug or a redirect reaches no D1. A real page view costs one R2 `head` of the pointer, and on an edge-cache miss one `get` and one indexed D1 read, at most once per page of the version per data centre per minute of traffic; D1 Paid includes 25 billion rows read a month (§1.3).
3. **Media:** after checking `isId` on both parts, look in `caches.default`; on a miss, `SELECT 1 FROM uploads u JOIN sites s ON s.id = u.site_id WHERE u.id = ? AND u.site_id = ? AND s.taken_down_at IS NULL`, then `MEDIA.get(mediaKey(siteId, uploadId))`. No row or no object: 404. Soft-deleted uploads are still served (a live or pending version may show them); a takedown stops them without a purge.
   - Unapproved photos are reachable by anyone who has their unguessable URL (two random UUIDs), because the owner's preview and the admin review need them. The residual abuse risk (free image hosting on our domain) is bounded by invite-only access, re-encoding, the per-site upload caps and takedown. [inferred]
   - Headers: `Content-Type: image/webp` (always set by the Worker, never from object metadata), `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'`, `Cross-Origin-Resource-Policy: cross-origin`, `Cache-Control: public, max-age=86400`.
   - Edge cache TTL is 300 s. Plan 2 verifies which directive the Cache API honours for a different edge and browser TTL, and must prove that a taken-down site's photos stop being served from the edge within 5 minutes.
4. **Forms:** §7.5. The form reads the LIVE pointer first (`LIVE.head`, and the pointer's `siteId` must equal the form's), so a form for a site with no pointer never reaches D1; the pointer is written only after every page is copied, so a visitor who can see `/contact` always has a working form.
5. **Cron** (`0 7 * * *`): delete leads older than `leadRetentionDays`.

### 7.4 Headers

**Live page** (every page of a site, §2.9):
```text
Content-Type: text/html; charset=utf-8
Cache-Control: no-cache
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src https://media.<root>; font-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Strict-Transport-Security: max-age=31536000; includeSubDomains
Permissions-Policy: camera=(), microphone=(), geolocation=()
(X-Robots-Tag: noindex only when sites.indexable = 0)
```

Why the CSP looks like this:
- `style-src 'unsafe-inline'` is needed for Plan 1's inline stylesheet and theme block.
- `font-src data:` only: the CSP allows `data:` fonts ahead of time for the one embedded heading font the Bold (impact) design build will add (user decision 2026-09-27; the impact row in `sheet-rules.ts` allows it). No page at head loads any font.
- `Cache-Control: no-cache` is what a browser gets; the copy kept at the edge is `public, s-maxage=60` (§7.3).
- The pages contain no scripts. JSON-LD blocks are data and are not run. [inferred: Plan 2's browser test asserts zero CSP violations on every fixture]

**Stored version shown for review** (admin and owner):
```text
Content-Type: text/html; charset=utf-8
Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src https://media.<root>; form-action 'none'; frame-ancestors 'self'
X-Frame-Options: SAMEORIGIN
X-Content-Type-Options: nosniff
X-Robots-Tag: noindex
Cache-Control: no-store
```

`frame-ancestors 'self'` (not `'none'`) because the admin review screen embeds this page in an `<iframe sandbox>` on the same origin (§3.2); the admin app's own CSP therefore has `frame-src 'self'` (§9.1).

**Every other response** from sites, app or admin: `X-Robots-Tag: noindex`. Customer hostnames never carry anything that has not been approved.

### 7.5 Contact form: `POST /_f/<siteId>`

1. `siteId` must pass `isId`, and the host must be a site host. Otherwise return 404.
2. Content type must be `application/x-www-form-urlencoded` (else 415). The body may not exceed 16 KB (else 413).
3. `FORM_RL.limit({ key: siteId + ":" + ipHash })`. If refused, return a 429 page with `Retry-After: 60`.
4. If the honeypot field `website` is not empty, return 303 to the thank-you page and store nothing.
5. Validate the fields:
   - `name`: 1–80 characters.
   - `phone`: 7–30 characters from `[0-9+().\- ]` with at least 7 digits.
   - `email`: optional, valid, at most 254 characters.
   - `service`: optional, at most 60 characters.
   - `message`: optional, at most 2,000 characters.
   - Control characters are removed; `\n` is kept in `message`.
   - Any failure returns a `400` page listing the problems in plain words, with a "Go back" link to `/contact#quote` (the form, §2.9). The page is built from fixed messages only and **never echoes a submitted value**.
   - Field names match Plan 1 Task 13 exactly: `name`, `phone`, `email`, `service`, `message`, `website`.
6. Look up the site:
   ```sql
   SELECT s.slug, s.live_version_id, s.taken_down_at, o.email
   FROM sites s JOIN owners o ON o.id = s.owner_id WHERE s.id = ?
   ```
   It must be live, not taken down, and `slug` must equal the host's slug. Otherwise return 404.
7. Per-site day cap: if `COUNT(leads today) >= 50`, return a 429 page. Residual risk, accepted for the pilot: someone with many IP addresses can use up a site's 50 for a day and block real visitors until midnight UTC. The admin sees it in the site's lead count; the page still shows the phone number.
8. Store the lead:
   - Messages containing more than 3 `http` occurrences get `spam = 1` and `email_status = 'skipped'`.
   - Otherwise insert with `'pending'`, send through the `Mailer`, then set `sent` or `failed` (with a short error code in `email_error`).
   - The lead is saved even when email fails, and the owner sees it in the app.
9. Return `303 See Other` to `/_f/<siteId>/sent`. That fixed page reads "Thanks! Your message was sent." and has a "Back to the website" link to `/`. It needs no dynamic content, so there is nothing to escape.

**The lead email** goes only to the owner's **login email**, which is verified by the invite or magic link. It never goes to `facts.email`, which is unverified and could be used to make us email a stranger.
- `From`: `MAIL_FROM`.
- `Reply-To`: the visitor's email if it is valid.
- `Subject`: `New request from your website: <name>`, with CR, LF and control characters removed and cut to 100 characters.
- Body: text, plus HTML escaped with Plan 1's `escapeText`. Visitor values go only into text nodes; the email never builds a link or an attribute from visitor input (the visitor's email and phone appear as plain text; replying uses `Reply-To`).
- `idempotencyKey`: `lead:<leadId>`.

**Fixed pages** served by the sites Worker (thank-you, form error, 404, 503, apex placeholder) are constant HTML with `lang="en"`, a `<title>`, one `<h1>`, a readable layout at 320 px, and the §7.4 live-page CSP plus `X-Robots-Tag: noindex`. Plan 2 runs axe on each of them.

### 7.6 `@asksite/mailer` (Plan 2)

```ts
export type EmailTag = "lead" | "magic_link" | "invite" | "review_result" | "site_notice" | "admin_alert"; // site_notice: takedown message to the owner
export interface OutgoingEmail { to: string; subject: string; text: string; html: string; replyTo?: string; tag: EmailTag; idempotencyKey: string }
export interface Mailer { send(email: OutgoingEmail): Promise<{ id: string }> }
export class MailerError extends Error { constructor(readonly code: "rate_limited" | "rejected" | "unavailable" | "misconfigured", message: string) { super(message) } }
export function createMailer(env: { MAILER: "resend" | "log"; MAIL_FROM: string; RESEND_API_KEY?: string; DB: D1Database; ENVIRONMENT: string }): Mailer;
```

- **`resend`:**
  - Request: `POST https://api.resend.com/emails` with `Authorization: Bearer`, the fields `from`, `to`, `subject`, `html`, `text`, `reply_to`, and an `Idempotency-Key` header (keys expire after 24 h, maximum 256 characters). The response is `{ id }`. [verified]
  - Status mapping: 429 → `rate_limited` (default limit 10 requests per second per team [verified]); 4xx → `rejected`; 5xx or network failure → `unavailable`.
  - Pricing: Free 3,000 per month and 100 per day; Pro $20 per month for 50,000. [verified]
- **`log`:** inserts into `dev_outbox`. It throws `misconfigured` if `ENVIRONMENT === "production"`.
- **Why not Cloudflare Email Service now:** the docs label outbound sending "Email Sending Beta … Available on Workers Paid plan". [verified] Pricing is 3,000 per month included, then $0.35 per 1,000, on Workers Paid only. [verified] It is a candidate `MAILER = "cloudflare"` implementation later; the interface already allows it.
- **Email templates** are owned by the plan that sends them: the lead email by Plan 2; the invite, magic link, review result, site notice and admin alert by Plan 4. Every template is plain text plus minimal escaped HTML and contains no tracking pixels. Every user-supplied value (business name, admin note, visitor fields) is `escapeText`-ed into a text node; the only links point to `APP_ORIGIN` or the site's own `siteUrl`, built from IDs and tokens, never from user input. Subjects have CR, LF and control characters removed.
- **Resend plan:** Free allows 100 emails a day for the whole account [verified]. Leads, sign-in links, invites and review results share that. Move to Pro ($20 a month, 50,000 a month, no daily limit [verified]) before the pilot passes about 20 live sites (§12). A `rate_limited` or `rejected` result on a lead email is visible in the admin's lead counts (`email_status = 'failed'`), and the lead itself is always saved.

---

## 8. Image upload pipeline (Plan 4 writes it; Plan 2 serves it)

1. **Client (owner app):**
   - `<input type="file" accept="image/jpeg,image/png,image/webp">`.
   - If the browser can decode the file (`createImageBitmap`), the client redraws it at 3,000 px maximum on the long edge to JPEG quality 0.9 before upload. This applies EXIF orientation, shrinks the upload and drops metadata early.
   - Whether iOS Safari hands over HEIC or converts it to JPEG for this `accept` list is [unverified]. Plan 4 tests it on a real iPhone. If HEIC arrives and cannot be decoded, the owner sees "Please choose a JPG or PNG photo".
2. **Server** (`POST /api/sites/:siteId/uploads`):
   - `UPLOAD_RL`; per-site count below 40 non-deleted and below 150 in total including soft-deleted (`upload_limit_reached`). The total cap stops an upload-delete loop from filling R2 or using up the monthly Images allowance, which on the Images Free plan would make every owner's uploads fail with error `9422` until the month ends. Both counts are pre-checked before the transform (so a refused upload costs nothing) and checked exactly by the conditional `INSERT … SELECT … WHERE` that creates the `uploads` row after the transform and before the object is written.
   - Size at most 10 MB, counted while reading (a missing or false `Content-Length` cannot get past it). The binding accepts up to 20 MB. [verified]
   - The part's file name and declared content type are ignored; they are never stored or shown.
   - Magic bytes must be JPEG (`FF D8 FF`), PNG (`89 50 4E 47 0D 0A 1A 0A`) or WebP (`RIFF????WEBP`). Everything else, including SVG, GIF, HEIC and PDF, gets 415.
   - `IMAGES.info()` must report width and height each at least 200 and width × height at most 50,000,000. Otherwise `image_rejected`. `.info()` calls are free. [verified]
3. **Transform:**
   ```ts
   IMAGES.input(bytes).transform({ width: 1600, height: 1600, fit: "scale-down" }).output({ format: "image/webp", quality: 82, anim: false })
   ```
   - `anim: false` turns an animated WebP or PNG (both pass the magic-byte check) into a still image; `anim` belongs to `.output()`, not `.transform()`. [verified: Images binding docs] Moving or flashing images on customer pages would fail WCAG 2.2.2 and risk 2.3.1.
   - WebP output discards all metadata, GPS included. [verified: "For all other output formats (e.g. WebP or PNG), all metadata will always be discarded", from the transformation docs; that the binding uses the same pipeline is inferred] Plan 4 proves it with a JPEG fixture tagged with GPS, in `wrangler dev --remote` once an account exists.
   - Whether the binding applies EXIF orientation itself is [unverified]. The client-side redraw already covers normal browsers, and Plan 4 tests a rotated JPEG uploaded directly.
   - Measure the output with `.info()` to get the stored width and height.
4. **Store:** `MEDIA.put(mediaKey(siteId, uploadId), webp)` and the `uploads` row. The original is never stored.
   - **Delete is a soft delete:** it sets `deleted_at` and hides the upload from the library. The R2 object is kept because a pending or live version may still show it. It is removed only by a takedown with media purge, or by a later cleanup job (not in v1).
5. **Alt text from the owner:** a photo can be added to facts only with alt text of 1–125 characters (Plan 1 `Photo.alt`). The form helps with a prompt and an example ("New water heater installed in a garage") and warns against "photo", "image" or file names. A caption of up to 80 characters is optional.
6. **References:** facts photos must point to this site's own uploads (`photoRefIssues`). This is checked on save (as issues), before generation, and on publish (blocking). An owner can never put an outside URL on a page.
7. **Local development:** the Images binding runs offline with `width`, `height`, `rotate` and `format` only, and without charges. [verified] Miniflare 5.20260921.1-alpha includes `sharp` 0.35.4 for this. [verified: package.json] Whether the offline binding accepts (ignores) `fit`, `quality` and `anim` or rejects them is [unverified]; Plan 4's first upload task checks it. The same call must run in development and production; if the offline binding rejects an option, Plan 4 tests that option in `wrangler dev --remote` instead of branching the code on `ENVIRONMENT`.
8. **Cost:** each upload is one unique transformation. Free covers 5,000 per month, then $0.50 per 1,000 on Images Paid. [verified]

---

## 9. Security and accessibility

### 9.1 Threats and mitigations

| Threat | Mitigation (owning plan) |
|---|---|
| Stored cross-site scripting on published pages | Plan 1 `html` template with context-aware escaping, the URL allowlist, zero JavaScript (A4, A5); page CSP `default-src 'none'` (§7.4); owner edits are copy and follow the same rules (§2.2) (Plans 1 and 2) |
| Cross-site scripting in the owner app or admin | React text nodes only; no `dangerouslySetInnerHTML` (enforced by lint); any `href` built from stored data (lead phone or email, social links) passes Plan 1's `isSafeUrl` first; CSP `script-src 'self'`; previews in `<iframe sandbox srcdoc>` without `allow-scripts` or `allow-same-origin`; stored versions served with `CSP: sandbox` (Plan 4) |
| Cross-site request forgery | `SameSite=Lax` cookie, exact `Origin` check, JSON or multipart content-type check (Plan 4) |
| Session theft | `__Host-` HttpOnly Secure cookie; only a hash in D1; 30-day expiry; logout; disabling an owner deletes sessions (Plan 4) |
| Invite or magic-link leakage | 256-bit single-use tokens stored as hashes; 7-day and 15-minute expiry; token in the URL fragment; consumed only by a button-press POST; invite links only emailed, never shown to admins; `Referrer-Policy: no-referrer`; `login` always returns 202 with the work in `waitUntil`; `AUTH_RL`; at most 5 tokens per owner per hour and 10 per day (Plan 4) |
| Admin takeover | Access with identity-provider MFA plus JWT verification in the Worker plus the email allowlist; no admin passwords; `workers_dev` off; every admin action audited; the dev bypass only works on `*.localhost` and a test forbids it in the production config (Plan 4) |
| Unsafe production configuration | One unit test per Worker parses its production `wrangler.jsonc` and fails if `ENVIRONMENT` is not `production`, `ADMIN_AUTH_MODE` is `dev`, `MAILER` is `log`, `MODEL_PROVIDER` is `fake`, `workers_dev` or `preview_urls` is not `false`, `observability.logs.invocation_logs` is not `false`, or any secret name appears in `vars` (Plans 2, 3 and 4) |
| Tampering between review and approval | Approve carries the `htmlSha256` the admin saw; the server checks it against D1 and against the stored bytes (§7.2) (Plans 2 and 4) |
| Reading another owner's site by ID | Every site query filters by `owner_id`; a mismatch returns 404; cross-owner tests on every route (Plan 4) |
| Server-side request forgery | No server fetches any user-supplied URL. Outbound requests go only to the configured model host and `api.resend.com`. Social links are never fetched. Photos come only from uploads. (Plans 2, 3 and 4) |
| Malicious uploads | Magic-byte allowlist; size and pixel caps; re-encoding to a still WebP (drops metadata and animation); only the re-encoded file stored; file names ignored; served from `media.<root>` out of a bucket that holds nothing else, with a Worker-set `Content-Type: image/webp`, `nosniff` and `CSP default-src 'none'`; per-site caps including a lifetime cap; a takedown stops a site's photos being served (Plans 2 and 4) |
| Phishing or abuse on free subdomains | Invite-only; a human approves **every** version; no digits, links or `@` in any copy; social links locked to the network's own hosts (Decision #18); review text flags for web addresses, `@`, other phone numbers and phishing words in owner facts (§3.2); a fixed contact form that cannot ask for passwords; slug blocklist plus human review of the slug; noindex for everything unapproved; per-site search-engine switch; takedown within about 2 minutes, effective from one D1 write; `abuse@` and `security.txt` on the apex; audit log; Public Suffix List submission as soon as the domain exists (Plans 2 and 4, and the user) |
| Contact form spam or abuse | Honeypot, `FORM_RL`, 50 leads per site per day, 16 KB body cap, link heuristic, leads emailed only to the verified owner email (Plan 2) |
| Email header injection | Resend JSON API; CR, LF and control characters removed; `replyTo` validated (Plan 2) |
| Cost abuse | Kill switch (variable plus setting), exact per-site daily count and per-owner total (conditional insert), exact global daily model limit (claimed atomically, each job's cost capped), one active job per site, input caps, provider-side spend limit (Plan 3); upload lifetime cap (Plan 4) |
| Prompt injection | Owner text is sent as data; no tools; schema, claim checker and human review; affects only the owner's own draft (Plan 3) |
| Secrets | Only in Wrangler secrets (`wrangler secret put`) or the gitignored `.dev.vars` (already in `.gitignore`); `.dev.vars.example` files list names only; the model key only in the generator; never logged or in client code; `ANTHROPIC_API_KEY` and friends never in `vars` (All) |
| Cookie tossing between customer subdomains | Customer pages are zero-JS and never set cookies; app and admin cookies are host-only `__Host-`; Public Suffix List submission (Plans 1, 4 and the user) |
| Clickjacking | `frame-ancestors 'none'` on every page, plus `X-Frame-Options: DENY` on app and admin; the only exception is the stored-version review page, framable by its own origin only (`frame-ancestors 'self'`, §7.4) (All) |
| Lead privacy | Raw IPs never stored (`hashIp` with the secret `IP_HASH_KEY`); invocation logs off, so request headers (IPs, cookies) are not logged (§1.2); leads deleted after 180 days; logs hold IDs only (Plan 2) |
| Supply chain | Exact version pins, pnpm lockfile, licences read from the actual LICENSE files (All) |

**Static-asset headers.** The app and admin Workers ship a `_headers` file generated at build time with the real media host. Static Assets support `_headers` with at most 100 rules and 2,000 characters per line. `_headers` does **not** apply to responses from Worker code, so Hono middleware sets the same headers on `/api/*`. [verified] Both apps also send `Strict-Transport-Security: max-age=31536000; includeSubDomains`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and `X-Frame-Options: DENY`. The app and the admin use the same CSP (the admin needs `frame-src 'self'` for the review iframe):

```text
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https://media.<root> blob: data:;
connect-src 'self'; frame-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'
```

The `srcdoc` preview inherits this policy. That is why `style-src` allows `'unsafe-inline'` (for the page's own `<style>`) and `img-src` lists the media host. [inferred: Plan 4's browser test asserts the preview renders with no CSP violations]

### 9.2 Accessibility (WCAG 2.2 AA)

- **Published pages:** proven by Plan 1 (axe, reflow at 320 px, focus not hidden behind the call bar).
- **Owner app and admin (Plan 4):**
  - native form controls with visible `<label>`s;
  - errors tied to fields with `aria-describedby` and an error summary that receives focus on a failed submit;
  - `autocomplete` tokens (1.3.5);
  - focus moves to the heading when the step changes;
  - autosave status in an `aria-live="polite"` region, including save failures and a `409 conflict` ("This site changed in another tab", with a Reload button);
  - Move up and Move down buttons instead of drag (2.5.7);
  - targets at least 24 × 24 CSS px (2.5.8);
  - no information asked twice (3.3.7);
  - no password or puzzle login (3.3.8);
  - the preview iframe has `title="Preview of your website"`;
  - dialogs use native `<dialog>`;
  - respects `prefers-reduced-motion`;
  - works at 320 px and 200 % zoom.
- **Tests:** Playwright 1.63.0 plus @axe-core/playwright 4.13.0 (the same pins as Plan 1) on every screen at 390 px and 1280 px, plus keyboard-only runs of the owner journey.

---

## 10. Local development, testing, and what needs the user's accounts

### 10.1 Running locally with no accounts [verified by running, 2026-09-24, wrangler 4.138.0]

A spike in the scratchpad showed the following:
- Two separate `wrangler dev` processes started with the same `--persist-to` **share local D1 and R2 state**.
- A queue message produced in one process **was consumed by the other**.
- `wrangler dev --local-protocol https` serves https with a self-signed certificate.
- `https://joes.localhost:8791/` reached the Worker with hostname `joes.localhost`. macOS resolves `*.localhost` to loopback.

Local D1 migrations apply with `wrangler d1 migrations apply <db> --local --persist-to <dir>`.

Canonical local origins. All are https, because Plan 1 `render()` and `Facts` photo URLs require https.

| Process | Command (Plan 2 owns the root `pnpm dev`) | Origin |
|---|---|---|
| sites | `wrangler dev -c apps/sites/wrangler.jsonc --port 8789 --local-protocol https --persist-to .wrangler/state` | `https://<slug>.localhost:8789`, `https://media.localhost:8789` |
| app | built app under `wrangler dev --port 8787 --local-protocol https`; `vite dev` (with `@vitejs/plugin-basic-ssl` 2.3.0) for the inner loop | `https://app.localhost:8787` |
| admin | same, port 8788 | `https://admin.localhost:8788` |
| generator | `wrangler dev --port 8790 --persist-to .wrangler/state` (queue consumer) | — |

Local variables: `ROOT_DOMAIN=localhost:8789`, `MAILER=log`, `MODEL_PROVIDER=fake`, `ADMIN_AUTH_MODE=dev`, `ENVIRONMENT=development`. Browsers must accept the self-signed certificate once. Playwright uses `ignoreHTTPSErrors: true`.

One convention for every Worker, so `pnpm dev` (Plan 2) can start all four: production values live in `wrangler.jsonc` `vars`; development values live in a gitignored `.dev.vars` next to it, created from the committed `.dev.vars.example` by `pnpm dev` when missing, and they override `vars` locally [inferred: Plan 2's first task confirms the override on wrangler 4.138.0 and in `createTestHarness`]. No Worker declares an `ai` binding (Workers AI has no local simulation [verified]; it is reached over HTTPS, §6.2), so every Worker runs locally with no account.

### 10.2 Testing

- **Unit tests:** Vitest 5.0.1 in Node, the same runner as Plan 1. They cover the pure logic: `core` (compose, keys, slug, tokens, schemas), mailer formatting, publishing with fakes, the generation loop with the fake provider, and templates.
- **Integration tests:** `createTestHarness` from `wrangler`. Cloudflare recommends it for integration tests; it runs production Worker builds in the local runtime "from any Node.js test runner", with `server.fetch`, `server.reset`, `worker.getEnv()` and `worker.applyD1Migrations()`. [verified: docs; the export exists in wrangler 4.138.0]
  - **Do not use `@cloudflare/vitest-pool-workers`.** Version 0.22.0 has peer `vitest ^4.1.0`, and the repo pins Vitest 5.0.1. [verified: `npm view`]
- **End-to-end tests:** Playwright against the four local Workers over https.
  - Owner journey: invite → questionnaire → fake generation → edit → publish → admin approve → live page → contact form → lead in `dev_outbox` and in the app.
  - Admin journey: invite, reject, takedown, restore, kill switch.
  - Plus axe on every screen.
- **Adversarial checks:** a separate review pass per plan, plus one whole-system pass that attacks the routes listed in §9.1.

### 10.3 Variables (non-secret) per Worker

| Variable | sites | app | admin | generator |
|---|---|---|---|---|
| `ENVIRONMENT` (`development` \| `production`) | yes | yes | yes | yes |
| `ROOT_DOMAIN` | yes | yes | yes | — |
| `APP_ORIGIN` | — | yes | yes (links in emails) | — |
| `ADMIN_ORIGIN` | — | — | yes | — |
| `MAILER`, `MAIL_FROM` | yes | yes | yes | — |
| `ADMIN_NOTIFY_EMAILS` | — | yes (new review alert) | — | — |
| `GENERATION_ENABLED`, `DAILY_MODEL_LIMIT` | — | yes | yes | yes |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ADMIN_EMAILS`, `ADMIN_AUTH_MODE`, `DEV_ADMIN_EMAIL` | — | — | yes | — |
| `MODEL_PROVIDER`, `MODEL_ID` | — | — | yes (worst-case cost shown in settings) | yes |
| `OPENAI_COMPAT_BASE_URL`, `FAKE_MODE` | — | — | — | yes |

Secrets are listed in §1.2. Each app's `Env` type is generated by `wrangler types`.

### 10.4 What needs the user, and when

| When | What | Why |
|---|---|---|
| Now | nothing | Stage 0 and all local building and testing of Plans 2–4 need no accounts |
| Before the first deploy (end of Plan 2) | **Domain chosen**, added to Cloudflare DNS; **Public Suffix List submission started** (review takes weeks to months) | Hostnames, TLS, email DNS, Access |
| Same | **Cloudflare account** (the user logs in with `wrangler login`; no token pasted into chat). Create: D1 `asksite` (`--location=enam`), R2 `asksite-live`, `asksite-work` and `asksite-media`, queues `asksite-generation` and `asksite-generation-dlq`, the Access application for `admin.<root>`. Upgrade to **Workers Paid ($5 per month) before the first real owner is invited.** | Hosting |
| Same | **Resend account**, domain verification DNS records on the sending subdomain `mail.<root>` (§1.1), API key put in with `wrangler secret put RESEND_API_KEY` (per Worker) by the user. Free (100 a day) is enough for the smoke test; **Pro ($20 per month) before about 20 live sites** (§7.6) | Email |
| Same | `abuse@` and `security@` forwarding with Cloudflare Email Routing (free) | Abuse contact |
| Plan 3 evaluation, or pilot launch | Model key: `ANTHROPIC_API_KEY` (about $20 prepaid), **or** a Cloudflare API token limited to Workers AI, **or** a Hugging Face (or Groq) token, put in by the user with `wrangler secret put`. Set a provider-side spend limit where the provider offers one. | Real generation |

There is no separate staging environment in v1. A second hostname level would need Advanced Certificate Manager [verified: Universal SSL covers first-level subdomains only]. Production with no invites is the staging environment: deploy, run a smoke test with an admin-created test site, then invite owners. A second cheap domain for staging is a later option (§12).

---

## 11. The split into Plans 2, 3 and 4, and the build order

### 11.1 Repository layout (new directories)

```text
apps/sites/        Plan 2   asksite-sites Worker
apps/app/          Plan 4   asksite-app Worker + owner single-page app
apps/admin/        Plan 4   asksite-admin Worker + admin single-page app
apps/generator/    Plan 3   asksite-generator Worker
packages/core/     Stage 0  @asksite/core (§2.8, §4.2, §4.3) + migrations/0001_init.sql
packages/site-css/ Stage 0  @asksite/site-css: build script writes src/generated.ts (gitignored):
                            export const SITE_CSS: string; export const SITE_CSS_SHA256: string
packages/mailer/   Plan 2   @asksite/mailer
packages/publishing/ Plan 2 @asksite/publishing
packages/generation/ Plan 3 @asksite/generation
```

- `pnpm-workspace.yaml` gains `apps/*`.
- The root `build:css` becomes: the renderer build, then `pnpm --filter @asksite/site-css run build`.
- Every package uses exact versions: wrangler 4.138.0, hono 4.13.9, jose 6.2.12, react and react-dom 19.3.0, @types/react and @types/react-dom 19.3.0, vite 8.3.1, @vitejs/plugin-react 6.1.1 (peer vite ^8), @cloudflare/vite-plugin 1.59.0 (peers vite ^6, ^7 or ^8 and wrangler ^4.138.0), @vitejs/plugin-basic-ssl 2.3.0, @tailwindcss/vite 4.3.3, react-hook-form 7.88.0, @hookform/resolvers 5.9.1 (peer zod ^3.25 or ^4), zod 4.6.5, vitest 5.0.1, @playwright/test 1.63.0, @axe-core/playwright 4.13.0. All [verified: `npm view`, 2026-09-24]. Licences: hono, react, vite and jose are MIT (`npm view license`). Plans re-check each licence by reading the actual LICENSE file.
- Whether the `.ts`-extension package imports that Plan 1 uses bundle cleanly with wrangler/esbuild and Vite is [inferred]. Stage 0 proves it by building a Worker that imports `@asksite/renderer`.

### 11.2 Frontend choice (Plan 4)

The owner app and the admin are React single-page apps built with Vite and served from Workers Static Assets, with a Hono JSON API in the same Worker. Config: `"assets": { "not_found_handling": "single-page-application", "run_worker_first": ["/api/*"] }`, with `directory` set to the client build output of the Vite plugin. That config shape is documented. [verified]

Reasons:
1. **Instant, free live preview.** Plan 1's `render()` is pure and has no Node APIs, so the editor renders the exact page in the browser on every keystroke. No server round-trip, no server cost.
2. **One set of rules.** The same zod schemas validate in the browser and on the server, so the owner sees the same message the server would give.
3. **Accessible forms.** react-hook-form works with native inputs, which keeps labels, `autocomplete` and native validation.
4. **Free hosting.** Static Assets requests are free and unlimited, and one Worker serves both the app and its API.

Rejected:
- Server-rendered forms or htmx: the preview would need a round trip per change.
- Next.js or Remix: server rendering is not needed and they need adapters.
- A component library: native elements plus Tailwind 4.3.3, the same tool as Plan 1.

No router library: there are 8 or fewer routes, handled by a small tested `useRoute` hook over the History API. Plan 4 owns the route list.

### 11.3 What each plan provides and consumes

| Plan | Provides (exact names in this document) | Consumes |
|---|---|---|
| **Stage 0** (written as Plan 2 "Part A"; executed first) | `@asksite/core` exactly per §2.8, §4.2 and §4.3, with tests (compose semantics including: adding a first photo, review or licence after generation still gives a valid document; a service named `constructor` or `__proto__`; a stale `baseGenerationId`; `SectionOrder` rejects partial or duplicate orders; `parseHost` for apex, www, media, a site, a reserved label, a deeper subdomain and a port mismatch; `slugIssue`; tokens; `photoRefIssues`; `toIssues`; `documentSha256` is unchanged by re-parsing every Plan 1 fixture); `packages/core/migrations/0001_init.sql` (§2.6) with a test that applies it locally and proves the partial unique index; `@asksite/site-css`; workspace and script changes; **Plan 1 amendment A6** (§2.3), after Plan 1 merges; spikes proving that a Worker importing `@asksite/renderer` builds and that `createTestHarness` runs under Vitest 5.0.1 | Plan 1 packages |
| **Plan 2**: hosting, publish, leads | `apps/sites` (§4.6, §7.3–7.5, cron); `@asksite/publishing` (§7.2); `@asksite/mailer` (§7.6); the root `pnpm dev` orchestration (§10.1); `.dev.vars.example` for sites; a deploy runbook section inside Plan 2 (resource creation commands, DNS records, the Access setup checklist, secrets); a CI workflow (typecheck, unit, integration, e2e); the lead email template | core, site-css, renderer (`render`, `escapeText`), site-schema |
| **Plan 3**: generation | `apps/generator` (§6.3, sweeper cron); `@asksite/generation`: `ModelProvider` and the three providers (`anthropic`, `openai-compatible`, `fake`), prompt, `toModelFacts`, validate-and-repair loop, `templateDraft`, price table (`ModelPrice` with source and date, for reporting and `worstCaseJobMicrousd`), the atomic claim with the daily model slot, the sweeper's fallback, `requestGeneration`, `generationAllowance`, `isGenerationEnabled`, `dailyModelLimit`, `worstCaseJobMicrousd`, `toGenerationView` (§6.4); `pnpm eval:generation` (only runs when keys are present; reports the §6.6 metrics) | core (`GenerationJob`, `GenerationInputSnapshot`, `LIMITS`, `settings` keys, tables), site-schema (`Facts`, `Copy`, `Layout`, `Theme`, `SiteDocument`, `factSections`, `COPY_LIMITS`, `SECTION_VARIANTS`) |
| **Plan 4**: owner app, editor, admin | `apps/app` (§4.4, questionnaire, editor, uploads per §8, leads page, cron cleanup of sessions and tokens); `apps/admin` (§4.5, review UI, settings); the brand and obscenity slug blocklist (`slug_invalid` with code `blocked`) with licences verified; email templates (invite, magic link, review result, site notice, admin alert); the review text flags (§3.2); the owner-facing message catalogue for schema issues; full-journey end-to-end tests across all four Workers; axe suites | core, site-css, renderer (`render` in the browser), site-schema, `@asksite/publishing` (`createPendingVersion`, `withdrawPending`, `approveVersion`, `rejectVersion`, `takeDown`, `restore`, `setIndexable`), `@asksite/mailer`, `@asksite/generation` (`requestGeneration`, `generationAllowance`, `isGenerationEnabled`, `dailyModelLimit`, `worstCaseJobMicrousd`, `toGenerationView`) |

Rules for plan writers:
- **Code against the contract.** Plans 3 and 4 code against the §6.4 and §7.2 signatures. Until the real package lands, their tests use a local fake that implements the same signature.
- **Stay in your own files.** No plan edits another plan's package. Only Stage 0 edits Plan 1's packages, and only as A6.
- **Contract changes go through the moderator.**

### 11.4 Build order (parallel where the contracts allow)

```text
now ───────── Plan 1 stages B, C (running)              Plans 2, 3, 4 written and reviewed (in parallel)
Plan 1 merged ─► Stage 0  (core, site-css, migration, A6, spikes)   ~1 short session
             ├─► Session X: Plan 2  (sites, publishing, mailer, pnpm dev, CI)
             ├─► Session Y: Plan 3  (generation, generator, fake + real providers, eval)
             └─► Session Z: Plan 4  (app API + questionnaire + editor; then admin)
                   (optional Session Z2: split admin out of Plan 4 once §7.2 publishing fakes exist)
all merged ──► integration end-to-end tests (Plan 4's journey tests) + whole-system adversarial security pass
          ──► user: domain, Cloudflare, Resend, key ──► deploy runbook ──► smoke test ──► first invites
```

If Plan 1 is still running when Stage 0 starts, the parts of Stage 0 that do not depend on A6 can go first: keys, tokens, slug, migration, site-css against the current stylesheet, and the tests of compose that do not parse `hidden`. A6 and its dependent tests run as soon as Plan 1 merges.

---

## 12. The user's calls

1. **Domain name.** It blocks every deploy, the Public Suffix List submission (weeks to months), email DNS and Access.
2. **Workers Paid ($5 per month)** from the pilot launch. Recommended (§1.4).
3. **Default model provider** after Plan 3's evaluation: Claude (the best rule-following expected, paid per token) or an open model through the `openai-compatible` provider, e.g. on Workers AI (free daily allowance, more repairs and fallbacks expected). Both paths are built; no model server is deployed either way. Also: set a spend limit in the provider's console.
4. **Cost cap defaults:** 5 generations per site per day, first builds included; 20 regenerations per owner in total; first builds do not count toward it (D2); 8 model calls per day across all owners (about $10.65 a day worst case on Opus 5.5, §6.3; M1); 150 photo uploads per site in total (§2.8 `LIMITS`). All are counts; money is bounded by count × each job's hard cost ceiling, plus the provider-side spend limit.
   - **Invites by email only** (recommended, §3.1): the admin can no longer copy an invite link to send by text. Keeping a text option would need an email-confirmation step first.
   - **Resend Pro ($20 per month)** before about 20 live sites: Free's 100 emails a day is shared by leads, sign-in links and invites (§7.6).
5. **Admin sign-in:** identity provider for Cloudflare Access (Google or GitHub, with MFA) and the admin email list.
6. **Email provider:** Resend (recommended now) or Cloudflare Email Service once it leaves Beta.
7. **Lead retention:** 180 days by default.
8. **Owner-edit strictness:** the same rules as AI copy (recommended, §2.2). Relaxing would allow digits in owner edits, at the cost of the anti-phishing and fact-drift guarantees.
9. **Brand name and sender address** for emails (`MAIL_FROM`) and the apex placeholder page.
10. **Staging:** none in v1 (production without invites), or a second domain later.
11. **HSTS preload** for the root domain: not in v1. Once preloaded, it is hard to undo.

---

## Appendix A: verification log (2026-09-24)

| Claim | Source |
|---|---|
| Workers pricing: Free 100k per day and 10 ms; Paid $5, 10M requests, 30M CPU-ms, overage prices; static assets free and unlimited; KV, Queues and D1 tiers | https://developers.cloudflare.com/workers/platform/pricing/ |
| Workers limits: subrequests 50 / 10,000; 100 / 500 Workers; 1,000 routes; 100 custom domains; assets 20k / 100k files and 25 MiB; `waitUntil` 30 s; body 100 MB | https://developers.cloudflare.com/workers/platform/limits/ |
| R2 prices and free tier; Class A and B membership; deletes free | https://developers.cloudflare.com/r2/pricing/ |
| D1 limits table | https://developers.cloudflare.com/d1/platform/limits/ |
| D1 `batch()` is transactional | https://developers.cloudflare.com/d1/worker-api/d1-database/ |
| D1 location hints are not guaranteed | https://developers.cloudflare.com/d1/configuration/data-location/ |
| KV takes up to 60 s or more to propagate; not for atomic operations | https://developers.cloudflare.com/kv/concepts/how-kv-works/ |
| Queues on Free, operations, retention, prices | https://developers.cloudflare.com/queues/platform/pricing/ |
| Queue consumer config keys and defaults | https://developers.cloudflare.com/queues/configuration/configure-queues/ |
| `assets.run_worker_first` patterns and SPA handling | https://developers.cloudflare.com/workers/static-assets/binding/ |
| `_headers` limits; not applied to Worker responses | https://developers.cloudflare.com/workers/static-assets/headers/ |
| Route precedence (most specific wins); DNS required | https://developers.cloudflare.com/workers/configuration/routing/routes/ |
| Custom Domains: no wildcards; `100::` placeholder | https://developers.cloudflare.com/workers/configuration/routing/custom-domains/ |
| Proxied wildcard DNS on all plans | https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/ |
| Universal SSL covers first-level subdomains only | https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/ |
| Rate-limit binding config, 10 or 60 s, local and eventually consistent; wrangler ≥ 4.36.0 | https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ |
| Cache API is per data centre; `cache.delete` local | https://developers.cloudflare.com/workers/runtime-apis/cache/ |
| Images binding API, 20 MB input, local offline mode, billing | https://developers.cloudflare.com/images/transform-images/bindings/ |
| WebP and PNG output discards metadata | https://developers.cloudflare.com/images/transform-images/transform-via-url/ |
| Images 5,000 free, then $0.50 per 1,000; error 9422 | https://developers.cloudflare.com/images/pricing/ |
| Access JWT header, certs URL, aud/iss/exp | https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/ |
| Zero Trust free for up to 50 users | Cloudflare blog "Zero Trust For Everyone" (search result; the plans page did not render) |
| Email Service sending is Beta and needs Workers Paid; 3,000 included then $0.35 per 1,000 | https://developers.cloudflare.com/email-service/ and /email-service/platform/pricing/ |
| Resend prices, send API, idempotency, 10 requests per second | https://resend.com/pricing, https://resend.com/docs/api-reference/emails/send-email, https://resend.com/docs/api-reference/rate-limit |
| Hugging Face credits and router | https://huggingface.co/docs/inference-providers/pricing |
| Workers AI JSON mode models and failure message | https://developers.cloudflare.com/workers-ai/features/json-mode/ |
| `createTestHarness` (recommended; any Node runner) | https://developers.cloudflare.com/workers/testing/test-harness/get-started/ and the changelog of 2026-07-21 |
| Package versions and peer dependencies | `npm view` (wrangler, vite plugin, vitest-pool-workers peer vitest ^4.1.0, etc.) |
| `createTestHarness` export, `workers_dev`, `preview_urls`, `migrations_dir`, `local_protocol` config keys; default Text module globs (`*.txt`, `*.html`, `*.sql`; CSS not included, hence `@asksite/site-css`) | wrangler 4.138.0 tarball type definitions and `cli.js` |
| Two `wrangler dev` processes share D1, R2 and queues with the same `--persist-to`; `--local-protocol https`; `*.localhost` Host routing | ran in scratchpad `sd-verify/spike`; processes stopped and confirmed gone |
| Queue consumer: 15 min wall clock, 30 s CPU default, 128 KB messages, 100 per batch (review) | https://developers.cloudflare.com/queues/platform/limits/ |
| Invocation logs hold "the Request, Response, and related metadata"; `invocation_logs = false`; header redaction documented only for Tail Workers (review) | https://developers.cloudflare.com/workers/observability/logs/workers-logs/ and https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/ |
| `observability.logs.invocation_logs` key in wrangler 4.138.0 (review) | `wrangler-dist/cli.d.ts` in the scratchpad spike install |
| Images binding: `anim` is an `.output()` option; `anim: false` makes a still image (review) | https://developers.cloudflare.com/images/transform-images/bindings/ |
| Workers AI has no local simulation; errors in `wrangler dev` unless remote (review) | https://developers.cloudflare.com/workers/development-testing/ |
| Resend DNS labels `send` (MX, TXT), `inbound` (MX, optional), `resend._domainkey` (TXT); sending from a subdomain recommended (review) | https://resend.com/docs/knowledge-base/cloudflare, https://resend.com/docs/dashboard/domains/introduction |
| Resend Free 3,000 a month and 100 a day; Pro $20 for 50,000 with no daily limit (review, re-read) | https://resend.com/pricing |
| Anthropic structured outputs: `output_config.format`; `anyOf` supported, `oneOf` not listed; no `minLength`/`maxLength`/`maxItems`/`pattern`; SDKs strip them (review) | https://platform.claude.com/docs/en/build-with-claude/structured-outputs |
| `z.toJSONSchema` over the AiDraft shape: 3,366 bytes, `oneOf` for the layout union, keeps `maxLength`/`maxItems`/`default` (review) | ran in scratchpad `review/schema.mts` against `packages/site-schema/src`, zod 4.6.5, Node 25.6.1 |
| Workers AI OpenAI-compatible endpoint `…/accounts/<account_id>/ai/v1/chat/completions`, Bearer API token; page does not mention `response_format` (review) | https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/ |

---

## Review changes (adversarial design review, 2026-09-24)

Each item: what was wrong, and what this file now says. Section numbers point at the new text.

1. **Editor broke on new facts (cross-plan bug).** Adding a first photo, review or licence after generation made `factSections` require a section the AI layout lacked, so the document failed until the owner regenerated and lost every wording edit; owner-written about/FAQ text could not appear if the AI wrote none. `composeDocument` now adds every missing section (default variant, before contact); `edits.order` is a full `SectionOrder` (all ids once, hero first) (§2.8).
2. **Prototype-key lookups.** A service named `constructor` made `serviceDescriptions[name]` return a function. Lookups use `Object.hasOwn` (§2.8).
3. **`composeDocument` type lied** (`SiteDocumentInput` with unvalidated facts). Now `ComposedDocument`; versions store and hash the **parsed** document via `documentSha256`, so "Unpublished changes" ignores whitespace and key order (§2.5, §2.8, §7.1).
4. **Preview had no form action before a slug exists** (`render()` requires https). Added `previewFormActionUrl` (§2.8, §3.1).
5. **Takedown and search-engine switch raced R2 writes.** An approve's LIVE `PUT` landing after a takedown's `DELETE` re-published a taken-down page, and `setIndexable` rewrote LIVE with the same race. The sites Worker now serves a page only when D1 says live and not taken down, and reads `indexable` from D1; `setIndexable` is D1-only; `restore` writes R2 first, then D1, and checks the hash (§0.2, §7.2, §7.3).
6. **The public Worker could read unapproved pages** (it was bound to `asksite-work`). Photos moved to their own bucket `asksite-media`; sites binds only LIVE and MEDIA (§0.1, §1.2, §1.3, §2.7, §8).
7. **Takedown left photos online** unless purged. Media is served only while the upload's site is not taken down; the Worker always sets `Content-Type: image/webp` (§7.3).
8. **Review-to-approve tampering gap.** Approve now carries the `htmlSha256` the admin saw; the server checks it against D1 and the stored bytes (§4.3, §7.2).
9. **Admin review iframe would be blank**: every admin response sent `X-Frame-Options: DENY`/`frame-ancestors 'none'`. The stored-version route now allows same-origin framing; the admin CSP is specified (same as the app, `frame-src 'self'`) (§4.1, §7.4, §9.1).
10. **Unverified owner email.** A copied invite link sent by text meant leads and sign-in links could go to a mistyped address (and a typo-squatter could later sign in). Invites are email-only and never shown to admins; send failure returns `502 email_failed` (new code) (§0.8, §3.1, §3.2, §4.3, §4.5, §5.2, §12).
11. **Mail scanners that run JavaScript** could spend a magic link: sign-in now needs a button press. Login work runs in `waitUntil` (no timing leak). Disabled owners are refused before an invite token is claimed (§4.4, §5.2).
12. **Sign-in floods could stop lead emails**: Resend Free's 100/day is shared. Added 10 tokens per owner per day and a Resend Pro step before about 20 live sites (§2.8 `LIMITS`, §5.2, §7.6, §10.4, §12) [verified: resend.com/pricing].
13. **KISS: money reservations replaced by exact counts.** Removed `spend_days`, owner balances, reservation, settlement, release and crash conversion. A single `UPDATE` claims the job and one of today's model calls (`model_slot`); per-site/per-owner caps are one conditional `INSERT`. Each job's cost has a hard ceiling, so `limit × worstCaseJobMicrousd` bounds daily spend (default 30/day, about $10 worst case on Opus 5.5 [inferred]). Renamed `GLOBAL_DAILY_CAP_MICROUSD` to `DAILY_MODEL_LIMIT`; `AdminSettings`, `SettingsBody`, `FALLBACK_REASONS`, `GENERATION_ERROR_CODES` updated; new exports `dailyModelLimit`, `worstCaseJobMicrousd` (§2.6, §2.8, §4.2, §4.3, §6.3, §6.4, §10.3, §11.3, §12).
14. **Stuck jobs**: two thresholds (10 and 15 min), a 5-minute UI poll that could time out while the job was still "running", a crashed first build with no draft, and a queue-send failure that blocked the site forever. Now: one `JOB_STUCK_AFTER_MS` (6 min), sweeper every 5 min gives stuck first builds the template draft, terminal writes are conditional on `running`, the handler never throws after the claim, a failed `send` marks the row failed, and the UI polls until a final status (guaranteed within about 12 min) (§3.1, §6.3, §6.4). Queue wall-clock limit is 15 min [verified].
15. **Upload abuse**: an upload-delete loop was unlimited (R2 growth, and the Images Free plan's 5,000/month then error 9422 for everyone). Added a 150-per-site lifetime cap. Animated WebP/PNG now become still images (`anim: false` on `.output()` [verified]; WCAG 2.2.2). File names are ignored; body size is counted while reading (§8).
16. **Logs could hold secrets and raw IPs**: invocation logs record request metadata and Cloudflare documents header redaction only for Tail Workers. `invocation_logs: false` on every Worker plus one structured line per request (§1.2) [verified key exists in wrangler 4.138.0].
17. **DNS labels vs slugs**: any label with its own record (Resend's `send`, `inbound` [verified]) escapes the wildcard, so a site with that slug would be unreachable. Added reserved slugs, a runbook test, and sending from `mail.<root>` (§1.1, §2.8).
18. **`parseHost` semantics were unspecified.** Now exact, including deeper subdomains and reserved labels (§2.8).
19. **Phishing text in facts** (reviews, captions, names may hold URLs, `@`, other phone numbers) was not surfaced to reviewers. Added `ReviewChecks.textFlags` (§3.2, §4.2, §9.1).
20. **Unsafe production config** now fails a unit test (dev auth, log mailer, fake model, `workers_dev`, invocation logs, secrets in `vars`) (§9.1).
21. **Escaping rules made explicit** for the form error page (never echoes input), fixed pages (constant HTML, axe-tested), all email templates (text nodes only; links only to our origins), and admin/app `href`s from stored data (`isSafeUrl`) (§7.5, §7.6, §9.1).
22. **Takedown message had no email tag**: added `site_notice` (§7.6).
23. **Model section aligned with the model-options note**: open models need no deploy; free tiers are for eval/pilot only; data-use rule for provider routes; eval protocol and gate from the note; Sonnet 5 price no longer "introductory" (§6.2, §6.6). Anthropic uses `output_config.format`, lists `anyOf` but not `oneOf`, and rejects length/pattern constraints, while `z.toJSONSchema(AiDraft)` emits `oneOf` and `maxLength` [both verified today], so the Anthropic adapter must transform the schema (§6.2).
24. **Local testing without accounts; one fewer adapter (KISS)**: the `AI` binding has no local simulation and errors in `wrangler dev` [verified], and `env.AI.run` input formats differ by model. The `workers-ai` provider is dropped; Workers AI is reached through the `openai-compatible` provider at its OpenAI-compatible endpoint [verified URL] with a scoped token, as the model-options note recommends (two real adapters). Whether that endpoint honours `json_schema` is [unverified] and measured by the eval (§6.2). One `vars` / `.dev.vars` convention for all Workers; the Images binding's offline support for `fit`/`quality`/`anim` is flagged [unverified] for Plan 4 (§1.2, §8, §10.1).
25. **Smaller fixes**: admin allowlist compared lower-case (§5.3); lead-cap denial-of-service recorded as an accepted pilot risk (§7.5); save conflicts announced accessibly (§9.2); cost section updated for Resend Pro and the D1 page gate (§1.5); Stage 0 tests list the new edge cases (§11.3).

Decided 2026-09-25 (D5, D6): owner edits stay strict for v1 and spam-flagged leads stay hidden. Known trade-offs: owner-edit strictness (§12 item 8) blocks honest phrases such as "our team will review your options" (`review` is a banned word); hidden testimonials still need the attestation (safe, slightly strict); spam-flagged leads stay hidden from owners with no way to see them.

---

## Moderator decisions (2026-09-25)

Approved changes proposed by Plan 3 (binding for Plans 2, 3 and 4):
- M1 (Plan 3 Decision 4): the shipped `DAILY_MODEL_LIMIT` is `"8"` in every Worker that declares it (apps/generator, apps/app, apps/admin), so the worst case stays near $10.65/day on Opus 5.5. The final model and limit are the user's call after the eval.
- M2 (Plan 3 Decision 9): `generation.requested` audit row is written in the same D1 batch as the job row, before the queue send.
- M3 (Plan 3 Decision 11): `worstCaseJobMicrousd` returns `number | null` (null = no recorded price); `AdminSettings.worstCaseDailyMicrousd` is `number | null`; the admin UI shows "unknown" for null.
- M4 (Plan 3 Decision 13, pins §10.3): every local D1 binding uses the placeholder `database_id` `00000000-0000-0000-0000-000000000000`; `pnpm deploy:check` refuses to deploy it.
- M5 (Plan 3 Decision 22): the prompt scopes "free" to estimates/quotes only; two trap eval profiles test it.
- M6 (from Plan 2 Decision 31): after Stage 0, shared root files are only edited in place (never rewritten); Plan 3 drops its own `vitest.config.ts` rewrite and relies on Stage 0's generic globs.

Cross-plan decisions D1–D6 (from `docs/superpowers/specs/2026-09-25-cross-plan-check.md` sections 2 and 3; binding for Plans 2B, 3 and 4):
- D1 (check §2 item 1): `AdminSettings.worstCaseDailyMicrousd` is `number | null` (M3; §4.2, §6.4); Stage 0 Task 4 already ships it in code (`packages/core/src/views.ts`, commit 48a23c6), although Task 4's text in Plan 2 still shows `number` (its text was frozen while it ran); Plan 4's `SettingsView` compiles either way.
- D2 (check §2 item 2): first builds (`kind = 'first'`) neither count toward nor are refused by the owner's lifetime cap of 20 (`LIMITS.generationsPerOwnerTotal`); only `regenerate` rows count, in the insert and in `generationAllowance`; the per-site daily cap still counts every kind (§6.4, §12 item 4).
- D3 (check §2 item 3): the moderator sets `MODEL_PROVIDER`, `MODEL_ID`, `DAILY_MODEL_LIMIT` and `GENERATION_ENABLED` in `apps/app`, `apps/admin` and `apps/generator` (each Worker that declares the variable) in ONE commit, because the cross-Worker config test needs them equal at every commit; Plan 4 Task 27 Step 1 only checks the values.
- D4 (check §3 item 4): Plan 2B runs in `/Users/ashir/Documents/workk2/web_maker` on branch `plan2-hosting`; Plans 3 and 4 run in worktrees outside that folder, `/Users/ashir/Documents/workk2/asksite-plan3` (`plan3-generation`) and `/Users/ashir/Documents/workk2/asksite-plan4` (`plan4-app`).
- D5 (check §2 items 5–11): the check's recommendations are accepted, including no email links in v1, no unifying of the two TypeScript setups, and spam-flagged leads that keep counting toward the lead cap while staying hidden from owners.
- D6 (user, 2026-09-25): owner-edited sentences stay strict, under the same rules as AI copy (§2.2, §12 item 8).
