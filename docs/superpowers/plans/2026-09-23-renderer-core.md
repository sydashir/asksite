# Renderer Core (Plan 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pure TypeScript library that turns a validated `SiteDocument` (owner facts + AI copy + layout + theme) into one complete, self-contained, zero-JavaScript static HTML page for a US home-services business, fully testable locally with no network, accounts or API keys.

**Architecture:** A pnpm monorepo with two packages. `@asksite/site-schema` holds Zod schemas that keep owner facts and AI copy in separate, strict objects, plus a claim checker that rejects AI copy stating anything the owner's facts do not back. `@asksite/renderer` turns a parsed document into HTML through one context-aware `html` tagged template (every interpolation is escaped for the place it lands; URL attributes accept only scheme-checked URLs; event-handler, style, srcset and srcdoc attributes accept nothing), section functions ported from AstroWind, and a Tailwind v4 stylesheet compiled once for all sites and inlined into every page next to a 12-variable per-site theme block. Root `fixtures/` holds five sample businesses whose output is locked by golden files, html-validate, a class-drift check, and Playwright + axe runs at 390/1200/1920 px (plus 320 px reflow and keyboard-focus checks on phones).

**Tech Stack:** Node 24.21.0 LTS or 25.6.1, pnpm 10.33.0 workspaces, TypeScript 7.0.2 (strict, no emit, Node runs `.ts` directly), Zod 4.6.5, Tailwind CSS 4.3.3 (`@tailwindcss/cli`), Vitest 5.0.1, html-validate 11.16.0, Playwright 1.63.0, @axe-core/playwright 4.13.0.

## Global Constraints

- TDD red-then-green: write the failing test, run it and watch it fail for the stated reason, then write the implementation and watch it pass. Never skip the red run.
- KISS and SOLID. No framework in the renderer. One responsibility per file.
- Commit messages are 3 words maximum. No `Co-Authored-By`, no "Generated with", no AI attribution of any kind. Commits are made as the repo-local identity `sydashir` <meetashirr@gmail.com> (already configured; never change global git config). Task 18 checks all three rules before the push.
- Never commit secrets (`.env`, `.env.*`, `.dev.vars`, `*.pem`, `*.key`). This plan needs no keys or accounts.
- Stage named paths only (`git add <paths>`). Never `git add -A` or `git add .`. The moderating session's uncommitted edits under `docs/` stay unstaged, so every git check in this plan that must ignore them uses the pathspec `-- . ':(exclude)docs'`.
- Before any git push run `gh auth switch --user sydashir`; afterwards run `gh auth switch --user dev778d`. Never log out, delete or change the `dev778d` account.
- Exact dependency versions (checked with `npm view` on 2026-09-23 and installed in a scratch replay of this plan): `typescript` 7.0.2, `vitest` 5.0.1, `zod` 4.6.5, `tailwindcss` 4.3.3, `@tailwindcss/cli` 4.3.3, `html-validate` 11.16.0, `@playwright/test` 1.63.0, `@axe-core/playwright` 4.13.0, `@types/node` 24.13.6. Package manager `pnpm@10.33.0`. Never use `^` or `~` ranges.
- Node: `engines` is `>=24.8.0` (html-validate's floor). This Mac's default `node` is 25.6.1 and every command below was replayed on it; typecheck, all unit tests, the extreme-fixture generator (same hash), the render script and the whole Playwright suite also pass on Node 24.21.0 LTS. `.nvmrc` pins `24.21.0` because Node 25 reached end of life on 2026-06-01 (nodejs/Release `schedule.json`; Node 24 is LTS until 2028-04-30) and Vitest 5.0.1 declares `engines.node` `^22.12.0 || ^24.0.0 || >=26.0.0` (checked with `npm view vitest@5.0.1 engines`), which leaves 25 out even though it works. nvm is installed at `~/.nvm` but no shell startup file loads it, so switching takes `source ~/.nvm/nvm.sh && nvm install && nvm use` (downloads Node 24.21.0 into `~/.nvm`), and it lasts only for that shell. Running on the default 25.6.1 is fine.
- The rendered page contains zero JavaScript: the only `<script>` elements are `type="application/ld+json"`. No `on*` attributes, no `javascript:` URLs, no `http-equiv`.
- Owner facts and AI copy never mix. Prices, phone, email, licences, hours, address, service area, testimonials and photos are read only from `facts`. Copy is NFKC-normalised and may not contain a number in any script, a currency symbol, `@`, a link or an invisible character, so it cannot state a fact in figures. The claim checker (`packages/site-schema/src/claims.ts`) rejects worded claims no owner fact backs ("bonded", "since", "five-star", "guaranteed", "same-day", "reviews", web addresses, quoted testimonials) and allows "licensed", "insured", "emergency"/"around the clock" and "free"/"no charge" only when the matching fact is set. AI copy never sits above reviews or the service area. The layout cannot leave out a section that shows owner facts. Every copy string has an explicit maximum length.
- Every value reaches HTML through the `html` tagged template (`packages/renderer/src/html.ts`): text nodes get `escapeText`, quoted attributes get `escapeAttr`, URL attributes (`href`, `src`, `action`, `formaction`, `poster`, `cite`, `data`, `ping`, `background`, `xlink:href`) accept only a `SafeUrl` from `safeUrl()` (http/https/tel/mailto) or `fragment()`, and `on*`, `style`, `srcset`, `imagesrcset` and `srcdoc` attributes refuse any interpolation.
- Tailwind class names are always whole literal strings in source. Variant switches are lookup tables of complete class strings. Never build a class name by string concatenation or interpolation. The class-drift tests fail the build if a rendered class is missing from the compiled CSS.
- Stylesheet decision: inline. The compiled sheet (measured 25,036 B raw / 5,536 B with `gzip -9` in the replay) is placed in a `<style>` element in every page. Reasons: a one-page site gains nothing from a cached shared file, inlining removes a render-blocking request, and each published page carries the exact CSS it was rendered with, so recompiling the sheet later can never break an already-published site.
- Font decision: system font stacks only (from modern-font-stacks, CC0). Zero font bytes, zero font requests, no Google Fonts or any third-party request from customer pages.
- The renderer is pure: no network, no clock, no randomness, no per-site build. Validation never reads the clock either (the founding-year bound is a fixed 1850–2100). `render()` re-validates its input and throws on anything invalid.
- Do not use the Playwright MCP browser tools (they write `.playwright-mcp/` into the project). Playwright runs only from this repo's dev dependencies.

## Decisions made while writing this plan

These go beyond or adjust the brief. Each was checked by running the code in the scratch replay.

1. **About section added.** The brief's copy includes an "about paragraph" but its section list has no place to show it, so `about` is a layout section that hides itself when `copy.about` is absent.
2. **Phone call bar added (phones only).** A `position: sticky` `<aside aria-label="Call us">` at the bottom of the screen with one tap-to-call button, hidden from 768 px up. No JavaScript. The header is not sticky, so an open `<details>` menu can never cover content after a jump link. While keyboard focus is on anything outside the bar, the bar stops sticking (`focus-outside:static`, a Tailwind custom variant using `:has(:focus-visible)`): WebKit ignores `scroll-padding` when it scrolls a focused field into view, and in the replay it left the contact fields under the bar (WCAG 2.4.11) until this rule was added.
3. **Gallery is a plain zero-JS grid** (`<figure><img><figcaption>`), lazy-loaded. AstroWind's `<dialog>` lightbox and its `<script>` are not ported, so its thumbnail `srcset` is not needed; the `html` template refuses `srcset` interpolation until a `SafeSrcset` type exists. The gallery shows for 1 or more photos and adapts its columns to the count.
4. **Hero headline cap is 80 characters** (the brief's "80-char headline" resilience case). [unverified] An earlier research note put real trade-site H1s at 25–65 characters; plan 3 should re-check that before choosing its prompt target.
5. **Numbers, currency symbols, `@`, links and invisible characters are banned in all copy, and a claim checker covers worded claims.** This is how "copy can never inject a fact" is enforced by the schema instead of by review. The word lists catch the usual phrasings, not every paraphrase; plan 4's approval screen still shows the owner every sentence.
6. **Years in business is stored as `yearFounded`** and rendered "Since 1998", so a static page never goes stale and render stays deterministic. Plan 4's questionnaire converts "years" to a year and rejects a future year against today's date; the schema's bound is fixed so validation never reads the clock.
7. **No "bonded" flag, no "bonded" copy and no star ratings.** California Business and Professions Code §7071.13: "Any reference by a contractor in his advertising … to any bond required to be filed pursuant to this chapter is a ground for the suspension of the license" (text checked 2026-09-23 at https://california.public.law/codes/ca_bus_and_prof_code_section_7071.13). Star ratings need 3:1 non-text contrast and invite fake-review risk. Testimonials are quote + name + optional location. The trust strip says "Insured", not "Fully insured": the owner only ticks a box.
8. **FAQPage JSON-LD is kept** because the brief requires it and it is valid schema.org, but it earns nothing in Google: Google's FAQ structured-data page says "This feature will no longer appear in Google Search starting May 7, 2026" (checked 2026-09-23 at https://developers.google.com/search/docs/appearance/structured-data/faqpage).
9. **Exactly 12 theme variables.** Dark bands (the trust strip "band" variant) use fixed white text, and the contrast tests prove white passes AA on every palette's dark colour, so no extra per-palette variables are needed.
10. **`heroPhoto` is a separate fact** from gallery `photos`, so the hero image is never repeated in the gallery.
11. **A WebKit project at 390 px** runs next to Chromium 390/1200/1920 (iOS is most US mobile traffic).
12. **Work happens on branch `plan1-renderer`**, pushed at the end. Merging to `main` is left to the user.
13. **AstroWind's Button is ported as CSS utilities** (`btn`, `btn-primary`, `btn-secondary` in `styles/input.css`). The component only picked a class and passed props through, so sections write `<a class="btn-primary …">` directly; `tailwind-merge` is not used anywhere.
14. **Every grid has an explicit `grid-cols-1` base, `<body>` sets `break-words`, and service-area chips are `max-w-full wrap-anywhere`.** The first browser run showed a 44 px sideways scroll at 390 px caused by one long unbroken word in an auto-sized grid track. A 40-letter upper-case place name still pushed the page 53 px sideways at 320 px (WCAG 1.4.10 reflow) until the chip rule was added; the same kind of word as the first service name, reviewer name and licence number stayed inside the page without any change.
15. **New owner fact `freeEstimates`** (default false). "Get a free quote" is the most common trades call to action, so the owner states it once and only then may the copy say "free", "no charge" or "complimentary". It is not rendered anywhere else.
16. **The layout must list every section that shows owner facts** (`factSections()`: services, service area and contact always; trust, testimonials and gallery when the owner gave credentials, reviews or photos). The AI picks order and variants but can never hide an owner fact. An owner-facing "hide this section" (planned for after the first preview) will need an explicit flag in a later plan.
17. **Service descriptions name their service.** `copy.serviceDescriptions` is `{ service, description }[]` in `facts.services` order, and the schema rejects a missing, extra or reordered entry, so a description can never land on the wrong service.
18. **Social links must point at the network's own site** (`SOCIAL_HOSTS`, e.g. `facebook.com` and its subdomains), and no owner URL may carry a user name or password, so a link labelled "Facebook" cannot send visitors to a phishing page.
19. **Owner text is not NFKC-normalised; AI copy is.** Normalising owner text would rewrite what they typed ("™" becomes "TM"). Owner text instead rejects control and invisible formatting characters (e.g. U+202E, U+200B) but keeps U+200D so emoji in pasted reviews survive.
20. **Every page carries one attribution comment** in `<head>` with the AstroWind and Tabler Icons copyright notices (MIT asks for the notice to travel with copies). Whether the full licence texts must also travel is left to the user.
21. **No `noindex` or site-id hooks in the renderer.** Plan 2's Worker can send `X-Robots-Tag: noindex` until a site is verified (Google: "Any rule that can be used in a robots `meta` tag can also be specified as an `X-Robots-Tag`", https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag; no re-render needed to flip it), and `formAction` is already per render, so plan 2 can put the site id in the form URL.

## File Structure

```text
.gitignore                       (modify) ignore compiled CSS, out/, Playwright output
.nvmrc                           Node 24.21.0 LTS
package.json                     root scripts: build:css, typecheck, test, test:e2e, e2e:install, render, check
pnpm-workspace.yaml              packages/*
tsconfig.json                    strict TS for packages, fixtures, scripts
vitest.config.ts                 unit test globs
playwright.config.ts             chromium-390/1200/1920 + webkit-390
THIRD_PARTY_NOTICES.md           AstroWind (MIT), Tabler Icons (MIT), modern-font-stacks (CC0)
packages/site-schema/            @asksite/site-schema: Zod schemas, no rendering
  src/url.ts                     isSafeUrl: absolute http/https/tel/mailto only
  src/facts.ts                   owner facts (never AI), social-link hosts
  src/copy.ts                    AI prose with hard caps, no numbers/currency/@/links/hidden characters
  src/claims.ts                  claim checker: worded claims in copy must be backed by facts
  src/layout.ts                  closed enum of sections and variants
  src/theme.ts                   palette and font ids
  src/document.ts                SiteDocument = facts + copy + layout + theme, cross-checks, factSections
  src/index.ts                   package entry
  test/*.test.ts
packages/renderer/               @asksite/renderer: SiteDocument -> HTML string
  styles/input.css               Tailwind input (compiled once to styles/site.css, gitignored)
  src/escape.ts                  escapeText / escapeAttr
  src/html.ts                    context-aware html tagged template, SafeHtml, SafeUrl
  src/json-ld.ts                 safe JSON-LD serialiser, LocalBusiness + FAQPage builders
  src/contrast.ts                WCAG 2.2 luminance and contrast ratio
  src/theme.ts                   4 palettes, 3 font presets, 12 CSS variables
  src/format.ts                  phone, price, time, weekly hours, trade labels
  src/icons.ts                   inline Tabler SVG icons (decorative)
  src/ui.ts                      headline + section shell (ported)
  src/context.ts                 RenderContext passed to every section
  src/visibility.ts              which sections have content
  src/sections/*.ts              header, hero, trust, services, testimonials, gallery,
                                 about, service-area, faq, contact, footer (+ call bar), ids
  src/render.ts                  page shell, render(), pageTitle()
  src/index.ts                   package entry
  test/support/css-classes.ts    class-drift helpers
  test/support/doc.ts            FULL / MINIMAL test documents
  test/*.test.ts
fixtures/                        five sample businesses + loader + golden HTML
  index.ts                       FIXTURES, loadFixture, loadStylesheet, renderFixture
  *.json                         plumber-austin, hvac-phoenix, roofing-extreme, cleaning-minimal, electrical-xss
  golden/*.html                  written by the golden test on first run
scripts/
  make-extreme-fixture.ts        writes fixtures/roofing-extreme.json (every field at its maximum)
  render-fixture.ts              pnpm render -> out/<name>.html for eyeballing
e2e/
  fixtures.spec.ts               axe (closed and open <details>), overflow at 390/320, focus under the
                                 call bar, zero-JS, screenshots, XSS, no-JS accordion/menu, RED proofs
  screenshot.css                 screenshot-only style (sticky bar static)
  tsconfig.json                  adds DOM types for browser callbacks
```

## Requirement coverage

| Brief requirement | Tasks |
|---|---|
| 1. Monorepo scaffold, pnpm workspaces, strict TS, Vitest | 1, 5, 9 |
| 2. SiteDocument schema, facts separate from copy (claim checker, fact-only sections, named service descriptions), capped copy, closed layout/theme enums | 2, 3, 4, 12, 13, 14 |
| 3. Sections: header, hero, services, gallery, testimonials, trust strip, service area + hours with LocalBusiness JSON-LD, FAQ with FAQPage JSON-LD, contact form, footer; AstroWind ports; notices | 6, 9, 10, 11, 12, 13, 14 |
| 4. Security: text/attribute escaping, URL allowlist, safe JSON-LD, XSS proof | 1, 2, 5, 6, 14, 15, 17 |
| 5. Tailwind compiled once, 12 CSS variables inline, literal classes, class-drift check, inline decision | 7, 9, 14, 15 |
| 6. Palettes, font presets, WCAG contrast function and AA test | 7 |
| 7. Zero JavaScript test | 14, 17 |
| 8. Content resilience (short/long text, 1–12 items, missing facts, unbroken words down to 320 px) | 10–15, 17 |
| 9. Unit tests, golden fixtures (incl. extreme + minimal), html-validate, Playwright + axe at 390/1200/1920, screenshot baseline | all; 15, 17 |
| 10. Render-a-fixture script | 16 |

---
### Task 1: Workspace scaffold and URL guard

**Files:**
- Modify: `.gitignore`
- Create: `.nvmrc`, `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `vitest.config.ts`
- Create: `packages/site-schema/package.json`, `packages/site-schema/src/url.ts`
- Test: `packages/site-schema/test/url.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `isSafeUrl(input: string, allowed?: readonly UrlScheme[]): boolean`, `LINK_SCHEMES: readonly UrlScheme[]` (`["http:", "https:", "tel:", "mailto:"]`), `type UrlScheme = "http:" | "https:" | "tel:" | "mailto:"`. Root scripts `pnpm test` (Vitest) and `pnpm typecheck` (`tsc -p .`).

- [ ] **Step 1: Create a working branch**

Run: `cd /Users/ashir/Documents/workk2/web_maker && git switch -c plan1-renderer && git config user.name && git config user.email`
Expected: `Switched to a new branch 'plan1-renderer'` (the uncommitted `docs/` edits come along, which is fine), then `sydashir` and `meetashirr@gmail.com`. Those `docs/` edits belong to the moderating session: leave them unstaged (every `git add` in this plan names its paths, and every git check that must ignore them uses `-- . ':(exclude)docs'`).

- [ ] **Step 2: Write the workspace files**

`.gitignore` — full new content (the first 19 lines are the existing file, unchanged; the last block is new):

```text
# Secrets
.env
.env.*
!.env.example
.dev.vars
*.pem
*.key

# Dependencies and build output
node_modules/
dist/
.wrangler/
.astro/

# OS / editor
.DS_Store

# Local Claude settings
.claude/settings.local.json

# Generated by the renderer build and test tools
packages/renderer/styles/site.css
out/
test-results/
playwright-report/
```

`.nvmrc`:

```text
24.21.0
```

`package.json`:

```json
{
  "name": "asksite",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.33.0",
  "engines": {
    "node": ">=24.8.0"
  },
  "scripts": {
    "typecheck": "tsc -p .",
    "test": "vitest run"
  },
  "devDependencies": {
    "@types/node": "24.13.6",
    "typescript": "7.0.2",
    "vitest": "5.0.1"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"

ignoredBuiltDependencies:
  - "@parcel/watcher"
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "es2023",
    "lib": ["es2023"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["packages/*/src", "packages/*/test", "fixtures", "scripts", "vitest.config.ts"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "scripts/**/*.test.ts"],
  },
});
```

`packages/site-schema/package.json`:

```json
{
  "name": "@asksite/site-schema",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "zod": "4.6.5"
  }
}
```


Run: `pnpm install`
Expected: ends with `Done in …s using pnpm v10.33.0`; `pnpm-lock.yaml` is created.

- [ ] **Step 3: Write the failing test**

`packages/site-schema/test/url.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isSafeUrl, LINK_SCHEMES } from "../src/url.ts";

describe("isSafeUrl", () => {
  it.each([
    "https://example.com/a?b=c",
    "http://example.com",
    "tel:+15125550142",
    "mailto:office@example.com",
  ])("accepts %s", (url) => {
    expect(isSafeUrl(url)).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    " javascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "//evil.example.com",
    "/relative/path",
    "#fragment",
    "",
    "https://example.com ",
  ])("rejects %j", (url) => {
    expect(isSafeUrl(url)).toBe(false);
  });

  it("can be narrowed to https only", () => {
    expect(isSafeUrl("https://example.com", ["https:"])).toBe(true);
    expect(isSafeUrl("http://example.com", ["https:"])).toBe(false);
  });

  it("lists exactly the four link schemes", () => {
    expect(LINK_SCHEMES).toEqual(["http:", "https:", "tel:", "mailto:"]);
  });
});
```


- [ ] **Step 4: Run it and watch it fail**

Run: `pnpm vitest run packages/site-schema/test/url.test.ts`
Expected: FAIL — `Error: Cannot find module '../src/url.ts' imported from …/packages/site-schema/test/url.test.ts`, `Test Files  1 failed (1)`.

- [ ] **Step 5: Write the implementation**

`packages/site-schema/src/url.ts`:

```ts
export type UrlScheme = "http:" | "https:" | "tel:" | "mailto:";

export const LINK_SCHEMES: readonly UrlScheme[] = ["http:", "https:", "tel:", "mailto:"];

// Control characters and whitespace are rejected up front: the URL parser silently strips
// tabs and newlines ("java\tscript:" parses as "javascript:"), so we never let it normalise.
const CONTROL_OR_SPACE = /[\u0000- \u007f]/;

/** True only for an absolute URL whose scheme is in `allowed`. Relative and protocol-relative URLs are rejected. */
export function isSafeUrl(input: string, allowed: readonly UrlScheme[] = LINK_SCHEMES): boolean {
  if (input === "" || CONTROL_OR_SPACE.test(input)) return false;
  if (!URL.canParse(input)) return false;
  return (allowed as readonly string[]).includes(new URL(input).protocol);
}
```


- [ ] **Step 6: Run the test and the typecheck**

Run: `pnpm vitest run packages/site-schema/test/url.test.ts && pnpm typecheck`
Expected: `Tests  18 passed (18)`; `tsc -p .` exits 0 with no output.

- [ ] **Step 7: Commit**

```bash
git add .gitignore .nvmrc package.json pnpm-workspace.yaml tsconfig.json vitest.config.ts pnpm-lock.yaml packages/site-schema/package.json packages/site-schema/src/url.ts packages/site-schema/test/url.test.ts
git commit -m "Scaffold monorepo workspace"
```

---
### Task 2: Owner facts schema

**Files:**
- Create: `packages/site-schema/src/facts.ts`
- Test: `packages/site-schema/test/facts.test.ts`

**Interfaces:**
- Consumes: `isSafeUrl` from `./url.ts` (Task 1).
- Produces: Zod schemas `Facts`, `UsPhone`, `OpeningHours`, `Service`, `Licence`, `Testimonial`, `Photo`, `SocialLink`, `Location`, `ServiceArea`; constants `TRADES`, `DAYS`, `SOCIAL_NETWORKS`, `SOCIAL_HOSTS`; types `Facts`, `Trade`, `Day`, `OpeningHours`, `Photo`, `SocialLink`. Parsed `Facts` always has arrays (`hours`, `licences`, `testimonials`, `photos`, `socialLinks`) and booleans (`insured`, `emergency247`, `freeEstimates`) filled with defaults. Phone is US E.164 (`+15125550142`); photos and social links must be `https:` with no user name or password, and a social link must be on its network's own host (`SOCIAL_HOSTS`). Every owner text field rejects control and invisible formatting characters except U+200D (emoji joiner). `yearFounded` is 1850–2100 (no clock read).

- [ ] **Step 1: Write the failing test**

`packages/site-schema/test/facts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Facts } from "../src/facts.ts";

const minimal = {
  businessName: "Mop",
  trade: "cleaning",
  phone: "+15125550142",
  email: "hello@example.com",
  location: { city: "Austin", state: "TX" },
  serviceArea: { places: ["Austin"] },
  services: [{ name: "House cleaning" }],
};

const issuePaths = (input: unknown) => {
  const result = Facts.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => i.path.join("."));
};

describe("Facts", () => {
  it("parses a minimal owner entry and fills defaults", () => {
    const facts = Facts.parse(minimal);
    expect(facts.hours).toEqual([]);
    expect(facts.licences).toEqual([]);
    expect(facts.testimonials).toEqual([]);
    expect(facts.photos).toEqual([]);
    expect(facts.socialLinks).toEqual([]);
    expect(facts.insured).toBe(false);
    expect(facts.emergency247).toBe(false);
    expect(facts.freeEstimates).toBe(false);
  });

  it("rejects unknown keys", () => {
    expect(issuePaths({ ...minimal, heroHeadline: "Hi" })).toEqual([""]);
  });

  it.each(["512-555-0142", "+1512555014", "+15121550142", "+44 20 7946 0958"])("rejects phone %j", (phone) => {
    expect(issuePaths({ ...minimal, phone })).toEqual(["phone"]);
  });

  it("enforces business name length 2..60", () => {
    expect(issuePaths({ ...minimal, businessName: "A" })).toEqual(["businessName"]);
    expect(issuePaths({ ...minimal, businessName: "A".repeat(61) })).toEqual(["businessName"]);
    expect(issuePaths({ ...minimal, businessName: "A".repeat(60) })).toEqual([]);
  });

  it("rejects hidden control and formatting characters but keeps emoji", () => {
    expect(issuePaths({ ...minimal, businessName: "Mop‮etis lacigol" })).toEqual(["businessName"]);
    expect(issuePaths({ ...minimal, serviceArea: { places: ["Aus​tin"] } })).toEqual(["serviceArea.places.0"]);
    const emoji = { quote: "Great job \u{1F44D}\u{1F3FD} \u{1F468}‍\u{1F527}", name: "Ana" };
    expect(issuePaths({ ...minimal, testimonials: [emoji] })).toEqual([]);
  });

  it("requires 1..12 services with names up to 40 chars", () => {
    expect(issuePaths({ ...minimal, services: [] })).toEqual(["services"]);
    expect(issuePaths({ ...minimal, services: Array(13).fill({ name: "Drains" }) })).toEqual(["services"]);
    expect(issuePaths({ ...minimal, services: [{ name: "x".repeat(41) }] })).toEqual(["services.0.name"]);
    expect(issuePaths({ ...minimal, services: [{ name: "Drains", startingPrice: 89.5 }] })).toEqual([
      "services.0.startingPrice",
    ]);
  });

  it("only accepts https photo URLs without credentials", () => {
    const photo = { alt: "Van", width: 800, height: 600 };
    expect(issuePaths({ ...minimal, photos: [{ ...photo, url: "http://example.com/a.jpg" }] })).toEqual(["photos.0.url"]);
    expect(issuePaths({ ...minimal, photos: [{ ...photo, url: "javascript:alert(1)" }] })).toEqual(["photos.0.url"]);
    expect(issuePaths({ ...minimal, photos: [{ ...photo, url: "https://user:pw@example.com/a.jpg" }] })).toEqual([
      "photos.0.url",
    ]);
    expect(issuePaths({ ...minimal, photos: [{ ...photo, url: "https://example.com/a.jpg" }] })).toEqual([]);
  });

  it("only accepts https social links", () => {
    expect(issuePaths({ ...minimal, socialLinks: [{ network: "yelp", url: "data:text/html,x" }] })).toEqual([
      "socialLinks.0.url",
    ]);
  });

  it("only accepts a social link on that network's own site", () => {
    const link = (network: string, url: string) => issuePaths({ ...minimal, socialLinks: [{ network, url }] });
    expect(link("facebook", "https://www.facebook.com/mopcleaning")).toEqual([]);
    expect(link("google", "https://maps.app.goo.gl/abc123")).toEqual([]);
    expect(link("facebook", "https://www.facebook.com@evil.example/login")).toEqual(["socialLinks.0.url"]);
    expect(link("facebook", "https://evil.example/facebook.com")).toEqual(["socialLinks.0.url"]);
    expect(link("facebook", "https://notfacebook.com/mop")).toEqual(["socialLinks.0.url"]);
    expect(link("yelp", "https://www.facebook.com/mop")).toEqual(["socialLinks.0.url"]);
  });

  it("bounds the founding year without reading the clock", () => {
    expect(issuePaths({ ...minimal, yearFounded: 1850 })).toEqual([]);
    expect(issuePaths({ ...minimal, yearFounded: 2100 })).toEqual([]);
    expect(issuePaths({ ...minimal, yearFounded: 1849 })).toEqual(["yearFounded"]);
    expect(issuePaths({ ...minimal, yearFounded: 2101 })).toEqual(["yearFounded"]);
  });

  it("validates opening hours", () => {
    const h = (days: string[], opens: string, closes: string) => ({ ...minimal, hours: [{ days, opens, closes }] });
    expect(issuePaths(h(["Monday"], "08:00", "17:00"))).toEqual([]);
    expect(issuePaths(h(["Monday"], "17:00", "08:00"))).toEqual(["hours.0.closes"]);
    expect(issuePaths(h(["Monday"], "07:5", "17:00"))).toEqual(["hours.0.opens"]);
    expect(issuePaths(h(["Funday"], "08:00", "17:00"))).toEqual(["hours.0.days.0"]);
    expect(
      issuePaths({
        ...minimal,
        hours: [
          { days: ["Monday", "Tuesday"], opens: "08:00", closes: "17:00" },
          { days: ["Tuesday"], opens: "09:00", closes: "12:00" },
        ],
      }),
    ).toEqual(["hours"]);
  });

  it("caps testimonial quotes at 320 characters", () => {
    const t = (quote: string) => ({ ...minimal, testimonials: [{ quote, name: "Ana" }] });
    expect(issuePaths(t("q".repeat(320)))).toEqual([]);
    expect(issuePaths(t("q".repeat(321)))).toEqual(["testimonials.0.quote"]);
  });

  it("validates state and ZIP formats", () => {
    expect(issuePaths({ ...minimal, location: { city: "Austin", state: "Texas" } })).toEqual(["location.state"]);
    expect(issuePaths({ ...minimal, location: { city: "Austin", state: "TX", postalCode: "7870" } })).toEqual([
      "location.postalCode",
    ]);
  });
});
```


- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/site-schema/test/facts.test.ts`
Expected: FAIL — `Error: Cannot find module '../src/facts.ts'`.

- [ ] **Step 3: Write the implementation**

`packages/site-schema/src/facts.ts`:

```ts
import { z } from "zod";
import { isSafeUrl } from "./url.ts";

// Owner-entered facts. Nothing in here ever comes from the AI.

export const TRADES = ["plumbing", "hvac", "electrical", "roofing", "cleaning", "landscaping"] as const;
export const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
export const SOCIAL_NETWORKS = ["facebook", "instagram", "google", "yelp", "nextdoor", "youtube", "linkedin"] as const;

/** Sites each network's link may point at (that host or a subdomain), so a "Facebook" link is really Facebook. */
export const SOCIAL_HOSTS: Record<(typeof SOCIAL_NETWORKS)[number], readonly string[]> = {
  facebook: ["facebook.com"],
  instagram: ["instagram.com"],
  google: ["google.com", "g.page", "maps.app.goo.gl"],
  yelp: ["yelp.com"],
  nextdoor: ["nextdoor.com"],
  youtube: ["youtube.com", "youtu.be"],
  linkedin: ["linkedin.com"],
};

// Control and invisible formatting characters (e.g. U+202E right-to-left override, U+200B
// zero-width space) can disguise text. U+200D (zero-width joiner) stays allowed because emoji
// use it. Owner text is not NFKC-normalised: that would rewrite what the owner typed ("™" -> "TM").
const HIDDEN_CHARACTER = /\p{Cc}|(?!‍)\p{Cf}/u;

const text = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((s) => !HIDDEN_CHARACTER.test(s), { error: "Control and invisible formatting characters are not allowed" });

const hasNoCredentials = (url: string) =>
  !URL.canParse(url) || (new URL(url).username === "" && new URL(url).password === "");

const HttpsUrl = z
  .string()
  .max(2048)
  .refine((url) => isSafeUrl(url, ["https:"]), { error: "Must be an absolute https:// URL" })
  .refine(hasNoCredentials, { error: "URL must not contain a user name or password" });

/** True when `url` is on one of `hosts` or a subdomain. A URL that is invalid for other reasons passes here (HttpsUrl already reported it). */
function isOnHost(url: string, hosts: readonly string[]): boolean {
  if (!isSafeUrl(url, ["https:"]) || !hasNoCredentials(url)) return true;
  const { hostname } = new URL(url);
  return hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

/** US number in E.164 form, e.g. +15125550142. Displayed as (512) 555-0142 by the renderer. */
export const UsPhone = z
  .string()
  .regex(/^\+1[2-9]\d{2}[2-9]\d{6}$/, { error: "Phone must be a US number in E.164 form, e.g. +15125550142" });

const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: "Time must be HH:MM (24-hour)" });

export const OpeningHours = z
  .strictObject({ days: z.array(z.enum(DAYS)).min(1).max(7), opens: Time, closes: Time })
  .refine((h) => h.opens < h.closes, { error: "closes must be later than opens", path: ["closes"] });

export const Service = z.strictObject({
  name: text(1, 40),
  /** Whole US dollars. Rendered as "From $89". */
  startingPrice: z.int().min(1).max(100_000).optional(),
});

/** Rendered exactly as entered, e.g. { label: "Arizona ROC", number: "ROC 300933" }. */
export const Licence = z.strictObject({ label: text(1, 40), number: text(1, 30) });

export const Testimonial = z.strictObject({
  quote: text(1, 320),
  name: text(1, 40),
  location: text(1, 40).optional(),
});

export const Photo = z.strictObject({
  url: HttpsUrl,
  alt: text(1, 125),
  width: z.int().min(1).max(10_000),
  height: z.int().min(1).max(10_000),
  caption: text(1, 80).optional(),
});

export const SocialLink = z
  .strictObject({ network: z.enum(SOCIAL_NETWORKS), url: HttpsUrl })
  .refine((link) => isOnHost(link.url, SOCIAL_HOSTS[link.network]), {
    error: "Link must point at that network's own site",
    path: ["url"],
  });

export const Location = z.strictObject({
  /** Optional: service-area businesses often hide their street address. */
  streetAddress: text(1, 80).optional(),
  city: text(1, 40),
  state: z.string().regex(/^[A-Z]{2}$/, { error: "State must be a two-letter code, e.g. TX" }),
  postalCode: z.string().regex(/^\d{5}$/, { error: "ZIP must be five digits" }).optional(),
});

export const ServiceArea = z.strictObject({
  /** City names or ZIP codes. */
  places: z.array(text(1, 40)).min(1).max(30),
  /** Free text such as "Within 25 miles of downtown Austin". Shown as the service-area subtitle. */
  note: text(1, 80).optional(),
});

export const Facts = z
  .strictObject({
    businessName: text(2, 60),
    trade: z.enum(TRADES),
    phone: UsPhone,
    email: z.email().max(254),
    location: Location,
    serviceArea: ServiceArea,
    hours: z.array(OpeningHours).max(7).default([]),
    services: z.array(Service).min(1).max(12),
    licences: z.array(Licence).max(5).default([]),
    insured: z.boolean().default(false),
    /**
     * Stored as a year so the page never goes stale ("Since 1998", not "27 years"). The bound is
     * fixed so validation never reads the clock; plan 4's questionnaire rejects a future year.
     */
    yearFounded: z.int().min(1850).max(2100).optional(),
    emergency247: z.boolean().default(false),
    /** The owner gives free estimates or quotes. Only then may the AI copy say "free". */
    freeEstimates: z.boolean().default(false),
    testimonials: z.array(Testimonial).max(12).default([]),
    heroPhoto: Photo.optional(),
    photos: z.array(Photo).max(12).default([]),
    socialLinks: z.array(SocialLink).max(7).default([]),
  })
  .refine((f) => new Set(f.hours.flatMap((h) => h.days)).size === f.hours.flatMap((h) => h.days).length, {
    error: "A day can appear in only one opening-hours entry",
    path: ["hours"],
  });

export type Facts = z.infer<typeof Facts>;
export type Trade = Facts["trade"];
export type Day = (typeof DAYS)[number];
export type OpeningHours = z.infer<typeof OpeningHours>;
export type Photo = z.infer<typeof Photo>;
export type SocialLink = z.infer<typeof SocialLink>;
```


- [ ] **Step 4: Run the test and the typecheck**

Run: `pnpm vitest run packages/site-schema/test/facts.test.ts && pnpm typecheck`
Expected: `Tests  16 passed (16)`; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/site-schema/src/facts.ts packages/site-schema/test/facts.test.ts
git commit -m "Add facts schema"
```

---
### Task 3: AI copy schema

**Files:**
- Create: `packages/site-schema/src/copy.ts`
- Test: `packages/site-schema/test/copy.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `Copy` (strict object: `heroHeadline` ≤80, `heroSubheadline` ≤160, `ctaText` ≤24, optional `about` ≤480, `sectionIntros` {services, gallery, faq, contact} each optional ≤140 (no AI intro for reviews or the service area), `serviceDescriptions: { service, description ≤160 }[]` (max 12; `service` repeats the owner's service name and is never rendered), `faq: {question ≤80, answer ≤320}[]` max 8), `COPY_LIMITS`, `prose(max)`, `SectionIntros`, `ServiceDescription`, `FaqItem`; types `Copy`, `FaqItem`. Every prose string is NFKC-normalised, then rejects any Unicode number (`\p{N}`), currency symbol (`\p{Sc}`), `@`, `http:`/`https:`, `www.` and control/invisible characters (issue code `custom`).

- [ ] **Step 1: Write the failing test**

`packages/site-schema/test/copy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Copy, COPY_LIMITS } from "../src/copy.ts";

const valid = {
  heroHeadline: "Fast, friendly plumbing in Austin",
  heroSubheadline: "Leaks, clogs and water heaters fixed right the first time.",
  ctaText: "Get a free quote",
  serviceDescriptions: [{ service: "Drain cleaning", description: "We clear stubborn drains without tearing up your yard." }],
};

const issues = (input: unknown) => {
  const result = Copy.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.code}`);
};

describe("Copy", () => {
  it("parses valid copy and fills defaults", () => {
    const copy = Copy.parse(valid);
    expect(copy.faq).toEqual([]);
    expect(copy.sectionIntros).toEqual({});
  });

  it.each(Object.entries({ heroHeadline: 80, heroSubheadline: 160, ctaText: 24, about: 480 }))(
    "caps %s at %i characters",
    (field, max) => {
      expect(issues({ ...valid, [field]: "a".repeat(max) })).toEqual([]);
      expect(issues({ ...valid, [field]: "a".repeat(max + 1) })).toEqual([`${field}: too_big`]);
    },
  );

  it("caps section intros, service descriptions and FAQ items", () => {
    expect(issues({ ...valid, sectionIntros: { faq: "a".repeat(141) } })).toEqual(["sectionIntros.faq: too_big"]);
    expect(issues({ ...valid, serviceDescriptions: [{ service: "Drains", description: "a".repeat(161) }] })).toEqual([
      "serviceDescriptions.0.description: too_big",
    ]);
    expect(issues({ ...valid, faq: [{ question: "a".repeat(81), answer: "b" }] })).toEqual(["faq.0.question: too_big"]);
    expect(issues({ ...valid, faq: [{ question: "a", answer: "b".repeat(321) }] })).toEqual(["faq.0.answer: too_big"]);
    expect(issues({ ...valid, faq: Array(9).fill({ question: "a", answer: "b" }) })).toEqual(["faq: too_big"]);
  });

  it("has no AI intro for reviews or the service area", () => {
    expect(issues({ ...valid, sectionIntros: { testimonials: "Real reviews" } })).toEqual(["sectionIntros: unrecognized_keys"]);
    expect(issues({ ...valid, sectionIntros: { serviceArea: "All of Texas" } })).toEqual(["sectionIntros: unrecognized_keys"]);
  });

  it("exposes the limits for the AI prompt (plan 3)", () => {
    expect(COPY_LIMITS.heroHeadline).toBe(80);
  });

  it.each([
    "Call (512) 555-0142 today",
    "Drain cleaning from $89",
    "Licence ROC 300933",
    "Serving Austin since 1998",
    "Email us at office@example.com",
    "Visit https://evil.example.com",
    "Visit www.evil.example.com",
    "Call ２０８ ５５５ ０１０７",
    "Only ＄８９",
    "Only €89",
    "Call ٥١٢",
    "Half price, just ½ off",
  ])("rejects a fact smuggled into copy: %j", (headline) => {
    expect(issues({ ...valid, heroHeadline: headline })).toEqual(["heroHeadline: custom"]);
  });

  it("rejects control and invisible characters", () => {
    expect(issues({ ...valid, heroHeadline: "Visit ww​w.evil.example" })).toEqual(["heroHeadline: custom"]);
    expect(issues({ ...valid, heroHeadline: "Mop‮etis" })).toEqual(["heroHeadline: custom"]);
  });

  it("normalises compatibility characters before checking", () => {
    expect(Copy.parse({ ...valid, ctaText: "Ｃａｌｌ ｕｓ" }).ctaText).toBe("Call us");
  });

  it("rejects fact fields placed in copy", () => {
    expect(issues({ ...valid, phone: "+15125550142" })).toEqual([": unrecognized_keys"]);
  });

  it("trims whitespace and rejects empty strings", () => {
    expect(Copy.parse({ ...valid, ctaText: "  Call us  " }).ctaText).toBe("Call us");
    expect(issues({ ...valid, ctaText: "   " })).toEqual(["ctaText: too_small"]);
  });
});
```


- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/site-schema/test/copy.test.ts`
Expected: FAIL — `Error: Cannot find module '../src/copy.ts'`.

- [ ] **Step 3: Write the implementation**

`packages/site-schema/src/copy.ts`:

```ts
import { z } from "zod";

// AI-written prose only. Every string has a hard length cap, is NFKC-normalised (so "＄８９"
// becomes "$89" before it is checked) and may not contain a number in any script, a currency
// symbol, "@", a link, or a control/invisible character: prices, phone numbers, licence numbers,
// years, emails and URLs are facts, so copy structurally cannot state one. Worded claims
// ("licensed", "free", "since") are checked against the owner's facts in claims.ts.
// The renderer reads facts only from `facts`.
const FACT_LIKE = /[\p{N}\p{Sc}@]|https?:|www\./iu;
const HIDDEN_CHARACTER = /[\p{Cc}\p{Cf}]/u;

export const prose = (max: number) =>
  z
    .string()
    .normalize("NFKC")
    .trim()
    .min(1)
    .max(max)
    .refine((s) => !FACT_LIKE.test(s), {
      error: "Copy must not contain numbers, currency symbols, @ or links; facts come from the owner",
    })
    .refine((s) => !HIDDEN_CHARACTER.test(s), { error: "Copy must not contain control or invisible characters" });

export const COPY_LIMITS = {
  heroHeadline: 80,
  heroSubheadline: 160,
  ctaText: 24,
  about: 480,
  sectionIntro: 140,
  serviceDescription: 160,
  faqQuestion: 80,
  faqAnswer: 320,
} as const;

/**
 * Intros only for sections whose body is not a list of owner facts. Reviews and the service
 * area get no AI subtitle, so AI prose never sits above real reviews or the owner's hours.
 */
export const SectionIntros = z.strictObject({
  services: prose(COPY_LIMITS.sectionIntro).optional(),
  gallery: prose(COPY_LIMITS.sectionIntro).optional(),
  faq: prose(COPY_LIMITS.sectionIntro).optional(),
  contact: prose(COPY_LIMITS.sectionIntro).optional(),
});

/**
 * `service` repeats the owner's service name exactly (it is never rendered; the page shows the
 * name from facts). SiteDocument checks it, so a reordered or missing description is caught.
 */
export const ServiceDescription = z.strictObject({
  service: z.string().trim().min(1).max(40),
  description: prose(COPY_LIMITS.serviceDescription),
});

export const FaqItem = z.strictObject({
  question: prose(COPY_LIMITS.faqQuestion),
  answer: prose(COPY_LIMITS.faqAnswer),
});

export const Copy = z.strictObject({
  heroHeadline: prose(COPY_LIMITS.heroHeadline),
  heroSubheadline: prose(COPY_LIMITS.heroSubheadline),
  /** Label for the quote button and the contact heading, e.g. "Get a free quote". */
  ctaText: prose(COPY_LIMITS.ctaText),
  about: prose(COPY_LIMITS.about).optional(),
  sectionIntros: SectionIntros.default({}),
  /** One entry per owner service, in facts.services order. */
  serviceDescriptions: z.array(ServiceDescription).max(12),
  faq: z.array(FaqItem).max(8).default([]),
});

export type Copy = z.infer<typeof Copy>;
export type FaqItem = z.infer<typeof FaqItem>;
```


- [ ] **Step 4: Run the test and the typecheck**

Run: `pnpm vitest run packages/site-schema/test/copy.test.ts && pnpm typecheck`
Expected: `Tests  24 passed (24)`; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/site-schema/src/copy.ts packages/site-schema/test/copy.test.ts
git commit -m "Add copy schema"
```

---
### Task 4: Layout, theme ids, claim checker and the SiteDocument

**Files:**
- Create: `packages/site-schema/src/layout.ts`, `packages/site-schema/src/theme.ts`, `packages/site-schema/src/claims.ts`, `packages/site-schema/src/document.ts`, `packages/site-schema/src/index.ts`
- Test: `packages/site-schema/test/document.test.ts`, `packages/site-schema/test/claims.test.ts`

**Interfaces:**
- Consumes: `Facts` (Task 2), `Copy` (Task 3), `isSafeUrl` (Task 1).
- Produces (all exported from `@asksite/site-schema`): `SECTION_VARIANTS` (`hero: centered|photo`, `trust: band|light`, `services: cards|compact`, `testimonials: grid|masonry`, `gallery: grid`, `about: plain`, `serviceArea: split`, `faq: accordion|open`, `contact: card`), `type SectionId`, `type VariantOf<Id>`, `LayoutSection` (discriminated union on `id`), `Layout` (hero first, no duplicates), `PALETTE_IDS` (`navy-orange`, `blue-yellow`, `green-amber`, `charcoal-red`), `FONT_IDS` (`clean`, `sturdy`, `friendly`), `Theme`, `type PaletteId`, `type FontId`, `SiteDocument` (schema and parsed type), `type SiteDocumentInput` (what callers may pass), `factSections(facts): SectionId[]`, and from `claims.ts` `NEVER_IN_COPY`, `NEEDS_A_FACT`, `unbackedClaims(text, facts): string[]`, `proseIn(copy): Array<[path, string]>`. `SiteDocument` adds three cross-checks: `copy.serviceDescriptions[i].service` equals `facts.services[i].name` for every entry (same count, same order); the layout lists every section in `factSections(facts)`; and no prose string in the copy states a claim the facts do not back (`unbackedClaims`).

- [ ] **Step 1: Write the failing test**

`packages/site-schema/test/document.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { factSections, Facts, SiteDocument, type SiteDocumentInput } from "../src/index.ts";

const doc: SiteDocumentInput = {
  facts: {
    businessName: "Mop",
    trade: "cleaning",
    phone: "+15125550142",
    email: "hello@example.com",
    location: { city: "Austin", state: "TX" },
    serviceArea: { places: ["Austin"] },
    services: [{ name: "House cleaning" }, { name: "Move-out cleaning" }],
  },
  copy: {
    heroHeadline: "A spotless home without lifting a finger",
    heroSubheadline: "Friendly, careful cleaners for homes across Austin.",
    ctaText: "Book a cleaning",
    serviceDescriptions: [
      { service: "House cleaning", description: "Weekly or one-off cleans." },
      { service: "Move-out cleaning", description: "Get your deposit back." },
    ],
  },
  layout: [
    { id: "hero", variant: "centered" },
    { id: "services", variant: "cards" },
    { id: "serviceArea", variant: "split" },
    { id: "contact", variant: "card" },
  ],
  theme: { palette: "green-amber", font: "clean" },
};

const issues = (input: unknown) => {
  const result = SiteDocument.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("SiteDocument", () => {
  it("parses a complete document", () => {
    expect(issues(doc)).toEqual([]);
  });

  it("rejects an unknown section or variant", () => {
    expect(issues({ ...doc, layout: [{ id: "hero", variant: "video" }] })).toHaveLength(1);
    expect(issues({ ...doc, layout: [...doc.layout, { id: "blog", variant: "grid" }] })).toHaveLength(1);
  });

  it("requires the hero first and forbids duplicates", () => {
    expect(issues({ ...doc, layout: doc.layout.slice(1) })).toEqual(["layout: The first section must be the hero"]);
    expect(issues({ ...doc, layout: [...doc.layout, { id: "contact", variant: "card" }] })).toEqual([
      "layout: Each section may appear only once",
    ]);
  });

  it("rejects an unknown palette or font", () => {
    expect(issues({ ...doc, theme: { palette: "hot-pink", font: "clean" } })).toHaveLength(1);
    expect(issues({ ...doc, theme: { palette: "navy-orange", font: "comic" } })).toHaveLength(1);
  });

  it("needs one service description per owner service, named and in order", () => {
    const [first, second] = doc.copy.serviceDescriptions;
    const message = "copy.serviceDescriptions: copy.serviceDescriptions must name every facts.services entry once, in the same order";
    expect(issues({ ...doc, copy: { ...doc.copy, serviceDescriptions: [first] } })).toEqual([message]);
    expect(issues({ ...doc, copy: { ...doc.copy, serviceDescriptions: [second, first] } })).toEqual([message]);
  });

  it("never lets the layout hide owner facts", () => {
    expect(issues({ ...doc, layout: [{ id: "hero", variant: "centered" }, { id: "services", variant: "cards" }] })).toEqual([
      "layout: The layout must include every section that shows owner facts; missing: serviceArea, contact",
    ]);
    const reviewed = { ...doc, facts: { ...doc.facts, testimonials: [{ quote: "Spotless.", name: "Ana" }] } };
    expect(issues(reviewed)).toEqual(["layout: The layout must include every section that shows owner facts; missing: testimonials"]);
  });

  it("lists the fact sections for the facts given", () => {
    expect(factSections(Facts.parse(doc.facts))).toEqual(["services", "serviceArea", "contact"]);
    expect(factSections(Facts.parse({ ...doc.facts, insured: true, photos: [] }))).toEqual([
      "services",
      "serviceArea",
      "contact",
      "trust",
    ]);
  });

  it("rejects copy that states a claim the facts do not back", () => {
    expect(issues({ ...doc, copy: { ...doc.copy, ctaText: "Get a free quote" } })).toEqual([
      'copy.ctaText: Copy states something the owner\'s facts do not back: "free"',
    ]);
    const free = { ...doc, facts: { ...doc.facts, freeEstimates: true }, copy: { ...doc.copy, ctaText: "Get a free quote" } };
    expect(issues(free)).toEqual([]);
  });

  it("keeps facts out of copy and copy out of facts", () => {
    expect(issues({ ...doc, copy: { ...doc.copy, phone: "+15125550142" } })).toHaveLength(1);
    expect(issues({ ...doc, facts: { ...doc.facts, heroHeadline: "x" } })).toHaveLength(1);
  });
});
```

`packages/site-schema/test/claims.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Facts, proseIn, SiteDocument, unbackedClaims, type SiteDocumentInput } from "../src/index.ts";

const base: SiteDocumentInput["facts"] = {
  businessName: "Mop",
  trade: "cleaning",
  phone: "+12085550107",
  email: "hi@example.com",
  location: { city: "Boise", state: "ID" },
  serviceArea: { places: ["Boise"] },
  services: [{ name: "House cleaning" }],
};

/** No licences, not insured, no 24/7, no free estimates, no founding year. */
const NONE = Facts.parse(base);
/** Every fact that can back a claim. */
const ALL = Facts.parse({
  ...base,
  licences: [{ label: "Idaho contractor", number: "RCE-1" }],
  insured: true,
  emergency247: true,
  freeEstimates: true,
});

describe("unbackedClaims", () => {
  it.each([
    "Licensed, bonded and fully insured",
    "Certified and BBB accredited",
    "Award-winning, top-rated, five-star service",
    "Highly rated by neighbors",
    "Real reviews from real neighbors",
    "“Best cleaners ever!” said Sarah",
    "Satisfaction guaranteed",
    "Every job comes with a warranty",
    "The lowest prices in town",
    "Only eighty-nine dollars",
    "Over twenty years of experience",
    "Serving Boise since the nineties",
    "A family business for three generations",
    "Same-day service",
    "Open weekends and Sundays",
    "Book online at mopboise.com",
  ])("never allows %j, whatever the facts", (text) => {
    expect(unbackedClaims(text, ALL)).not.toEqual([]);
  });

  it.each([
    ["Our licensed team", "licensed"],
    ["Fully insured for your peace of mind", "insured"],
    ["Emergency cleanups around the clock", "Emergency"],
    ["Call us any time, day or night", "any time"],
    ["Get a free quote", "free"],
    ["There is no charge for a visit", "no charge"],
    ["A complimentary walkthrough", "complimentary"],
  ])("allows %j only when the owner's facts back it", (text, word) => {
    expect(unbackedClaims(text, NONE)).toEqual([word]);
    expect(unbackedClaims(text, ALL)).toEqual([]);
  });

  it("leaves ordinary sales copy alone", () => {
    expect(unbackedClaims("Careful cleaners for busy households. Hassle-free booking, one-off or weekly.", NONE)).toEqual([]);
  });

  it("walks every prose string except the repeated service names", () => {
    const copy = SiteDocument.parse(MINIMAL_DOC).copy;
    expect(proseIn(copy).map(([path]) => path.join("."))).toEqual([
      "heroHeadline",
      "heroSubheadline",
      "ctaText",
      "sectionIntros.faq",
      "serviceDescriptions.0.description",
      "faq.0.question",
      "faq.0.answer",
    ]);
  });
});

const MINIMAL_DOC: SiteDocumentInput = {
  facts: base,
  copy: {
    heroHeadline: "Clean homes",
    heroSubheadline: "Careful cleaners for busy Boise households.",
    ctaText: "Book",
    sectionIntros: { faq: "Quick answers." },
    serviceDescriptions: [{ service: "House cleaning", description: "Weekly or one-off." }],
    faq: [{ question: "Do you bring supplies?", answer: "Yes, everything we need." }],
  },
  layout: [
    { id: "hero", variant: "centered" },
    { id: "services", variant: "cards" },
    { id: "serviceArea", variant: "split" },
    { id: "faq", variant: "accordion" },
    { id: "contact", variant: "card" },
  ],
  theme: { palette: "green-amber", font: "clean" },
};

describe("SiteDocument rejects AI copy that states facts the owner did not give", () => {
  it.each([
    "Licensed, bonded and fully insured",
    "Over twenty years",
    "Only eighty-nine dollars",
    "Call ２０８ ５５５ ０１０７",
    "Just ＄８９",
    "Visit mopboise.com",
    "Emergency cleaning around the clock",
    "Free estimates, no hidden fees",
    "Five-star rated, award-winning, BBB accredited",
    "“Best cleaners ever!” said Sarah",
    "Satisfaction guaranteed",
  ])("%j", (claim) => {
    const faq = [{ question: "Why us?", answer: claim }];
    const result = SiteDocument.safeParse({ ...MINIMAL_DOC, copy: { ...MINIMAL_DOC.copy, faq } });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join("."))).toEqual(["copy.faq.0.answer"]);
  });
});
```


- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/site-schema/test/document.test.ts packages/site-schema/test/claims.test.ts`
Expected: FAIL — `Error: Cannot find module '../src/index.ts'` in both files, `Test Files  2 failed (2)`.

- [ ] **Step 3: Write the implementation**

`packages/site-schema/src/layout.ts`:

```ts
import { z } from "zod";

// Closed set of sections and variants. Header and footer are always rendered and are not listed here.
export const SECTION_VARIANTS = {
  hero: ["centered", "photo"],
  trust: ["band", "light"],
  services: ["cards", "compact"],
  testimonials: ["grid", "masonry"],
  gallery: ["grid"],
  about: ["plain"],
  serviceArea: ["split"],
  faq: ["accordion", "open"],
  contact: ["card"],
} as const;

export type SectionId = keyof typeof SECTION_VARIANTS;
export type VariantOf<Id extends SectionId> = (typeof SECTION_VARIANTS)[Id][number];

const section = <Id extends SectionId>(id: Id) =>
  z.strictObject({ id: z.literal(id), variant: z.enum(SECTION_VARIANTS[id]) });

export const LayoutSection = z.discriminatedUnion("id", [
  section("hero"),
  section("trust"),
  section("services"),
  section("testimonials"),
  section("gallery"),
  section("about"),
  section("serviceArea"),
  section("faq"),
  section("contact"),
]);

export const Layout = z
  .array(LayoutSection)
  .min(1)
  .max(Object.keys(SECTION_VARIANTS).length)
  .refine((sections) => sections[0]?.id === "hero", { error: "The first section must be the hero" })
  .refine((sections) => new Set(sections.map((s) => s.id)).size === sections.length, {
    error: "Each section may appear only once",
  });

export type LayoutSection = z.infer<typeof LayoutSection>;
export type Layout = z.infer<typeof Layout>;
```

`packages/site-schema/src/theme.ts`:

```ts
import { z } from "zod";

// Only the ids live in the schema. The renderer owns the actual colours and font stacks.
export const PALETTE_IDS = ["navy-orange", "blue-yellow", "green-amber", "charcoal-red"] as const;
export const FONT_IDS = ["clean", "sturdy", "friendly"] as const;

export const Theme = z.strictObject({ palette: z.enum(PALETTE_IDS), font: z.enum(FONT_IDS) });

export type Theme = z.infer<typeof Theme>;
export type PaletteId = Theme["palette"];
export type FontId = Theme["font"];
```

`packages/site-schema/src/claims.ts`:

```ts
import type { Copy } from "./copy.ts";
import type { Facts } from "./facts.ts";

// Claim checker for AI copy. Credentials, insurance, time in business, hours, prices, reviews
// and contact details are owner facts that the renderer shows from `facts`. Copy may mention a
// claim only when the owner's facts back it, and never mentions a claim no fact can back.
// Word lists catch the usual phrasings, not every paraphrase: plan 4's approval screen still
// shows the owner every sentence before a page is published.

/** Claims no owner fact backs: rejected in copy whatever the facts say. */
export const NEVER_IN_COPY: readonly RegExp[] = [
  /\bbond(s|ed)?\b/i, // California B&P Code 7071.13 forbids mentioning the contractor bond in advertising
  /\b(certified|accredited|award[- ]winning|top[- ]rated|five[- ]star|rated|ratings?|bbb)\b/i,
  /\b(reviews?|says?|said)\b|[“”„«»]/i, // real reviews are owner facts; no quotes invented in copy
  /\b(guarantee[ds]?|warrant(y|ies|ied))\b/i,
  /\b(cheapest|lowest|dollars?|bucks|cents)\b/i,
  /\b((twen|thir|for|fif|six|seven|eigh|nine)ty|hundreds?|thousands?|millions?)\b/i, // spelled-out numbers
  /\b(since|years?|decades?|established|founded|generations?)\b/i, // time in business comes from yearFounded
  /\b(same[- ]day|next[- ]day|weekends?|(mon|tues|wednes|thurs|fri|satur|sun)days?)\b/i, // hours are facts
  /\b[a-z0-9-]+\.(com|net|org|us|biz|info|co|io)\b/i, // bare web addresses
];

/** Claims allowed only when the owner's facts back them. */
export const NEEDS_A_FACT: ReadonlyArray<{ readonly pattern: RegExp; readonly backedBy: (facts: Facts) => boolean }> = [
  { pattern: /\blicen[cs]\w*/i, backedBy: (facts) => facts.licences.length > 0 },
  { pattern: /\binsur\w*/i, backedBy: (facts) => facts.insured },
  { pattern: /\b(emergenc\w*|a?round[- ]the[- ]clock|day or night|any ?time)\b/i, backedBy: (facts) => facts.emergency247 },
  { pattern: /(?<![\w-])free\b|\bno[- ](charge|cost)\b|\bcomplimentary\b/i, backedBy: (facts) => facts.freeEstimates },
];

/** The words in `text` that state a claim the owner's facts do not back (empty when the text is fine). */
export function unbackedClaims(text: string, facts: Facts): string[] {
  const found: string[] = [];
  for (const pattern of NEVER_IN_COPY) {
    const match = pattern.exec(text);
    if (match) found.push(match[0]);
  }
  for (const { pattern, backedBy } of NEEDS_A_FACT) {
    const match = pattern.exec(text);
    if (match && !backedBy(facts)) found.push(match[0]);
  }
  return found;
}

type Path = Array<string | number>;

/**
 * Every prose string in the copy with its path, found by walking the object, so a copy field
 * added later is checked automatically. `service` keys are skipped: they repeat owner facts.
 */
export function proseIn(copy: Copy): Array<[Path, string]> {
  const out: Array<[Path, string]> = [];
  const walk = (value: unknown, path: Path): void => {
    if (typeof value === "string") out.push([path, value]);
    else if (Array.isArray(value)) value.forEach((item, i) => walk(item, [...path, i]));
    else if (typeof value === "object" && value !== null)
      for (const [key, item] of Object.entries(value)) if (key !== "service") walk(item, [...path, key]);
  };
  walk(copy, []);
  return out;
}
```

`packages/site-schema/src/document.ts`:

```ts
import { z } from "zod";
import { proseIn, unbackedClaims } from "./claims.ts";
import { Copy } from "./copy.ts";
import { Facts } from "./facts.ts";
import { Layout, type SectionId } from "./layout.ts";
import { Theme } from "./theme.ts";

/**
 * Sections whose content is owner facts, for the facts this owner gave. The layout must list
 * each of them: the AI chooses order and variants but can never hide an owner fact.
 */
export function factSections(facts: Facts): SectionId[] {
  const sections: SectionId[] = ["services", "serviceArea", "contact"];
  if (facts.licences.length > 0 || facts.insured || facts.yearFounded !== undefined || facts.emergency247) sections.push("trust");
  if (facts.testimonials.length > 0) sections.push("testimonials");
  if (facts.photos.length > 0) sections.push("gallery");
  return sections;
}

export const SiteDocument = z
  .strictObject({ facts: Facts, copy: Copy, layout: Layout, theme: Theme })
  .superRefine((doc, ctx) => {
    const names = doc.facts.services.map((s) => s.name);
    const described = doc.copy.serviceDescriptions.map((d) => d.service);
    if (described.length !== names.length || described.some((name, i) => name !== names[i])) {
      ctx.addIssue({
        code: "custom",
        path: ["copy", "serviceDescriptions"],
        message: "copy.serviceDescriptions must name every facts.services entry once, in the same order",
      });
    }

    const listed = new Set(doc.layout.map((s) => s.id));
    const missing = factSections(doc.facts).filter((id) => !listed.has(id));
    if (missing.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["layout"],
        message: `The layout must include every section that shows owner facts; missing: ${missing.join(", ")}`,
      });
    }

    for (const [path, text] of proseIn(doc.copy)) {
      const claims = unbackedClaims(text, doc.facts);
      if (claims.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["copy", ...path],
          message: `Copy states something the owner's facts do not back: ${claims.map((c) => JSON.stringify(c)).join(", ")}`,
        });
      }
    }
  });

/** Parsed document: defaults applied, every string trimmed and length-checked. */
export type SiteDocument = z.infer<typeof SiteDocument>;
/** What callers may pass in (optional arrays and flags may be omitted). */
export type SiteDocumentInput = z.input<typeof SiteDocument>;
```

`packages/site-schema/src/index.ts`:

```ts
export { NEEDS_A_FACT, NEVER_IN_COPY, proseIn, unbackedClaims } from "./claims.ts";
export { COPY_LIMITS, Copy, FaqItem, prose, SectionIntros, ServiceDescription } from "./copy.ts";
export { factSections, SiteDocument, type SiteDocumentInput } from "./document.ts";
export {
  DAYS,
  Facts,
  Licence,
  Location,
  OpeningHours,
  Photo,
  Service,
  ServiceArea,
  SOCIAL_HOSTS,
  SOCIAL_NETWORKS,
  SocialLink,
  Testimonial,
  TRADES,
  UsPhone,
  type Day,
  type Trade,
} from "./facts.ts";
export { Layout, LayoutSection, SECTION_VARIANTS, type SectionId, type VariantOf } from "./layout.ts";
export { FONT_IDS, PALETTE_IDS, Theme, type FontId, type PaletteId } from "./theme.ts";
export { isSafeUrl, LINK_SCHEMES, type UrlScheme } from "./url.ts";
```


- [ ] **Step 4: Run the whole suite and the typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: `Test Files  5 passed (5)`, `Tests  103 passed (103)`; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/site-schema/src/layout.ts packages/site-schema/src/theme.ts packages/site-schema/src/claims.ts packages/site-schema/src/document.ts packages/site-schema/src/index.ts packages/site-schema/test/document.test.ts packages/site-schema/test/claims.test.ts
git commit -m "Add site document"
```

---
### Task 5: Renderer package, escaping and the `html` template

**Files:**
- Create: `packages/renderer/package.json`, `packages/renderer/src/escape.ts`, `packages/renderer/src/html.ts`
- Test: `packages/renderer/test/escape.test.ts`, `packages/renderer/test/html.test.ts`

**Interfaces:**
- Consumes: `isSafeUrl`, `type UrlScheme` from `@asksite/site-schema`.
- Produces: `escapeText(value: string): string` (escapes `& < >`), `escapeAttr(value: string): string` (also `"` and `'`); class `SafeHtml` (`toString()` returns markup); class `SafeUrl` (`toString()` returns the URL); `type Value = string | number | SafeHtml | SafeUrl | false | null | undefined | readonly Value[]`; `html(strings, ...values): SafeHtml`; `trusted(markup: string): SafeHtml` (our own string literals only); `safeUrl(input: string, allowed?: readonly UrlScheme[]): SafeUrl` (throws `Unsafe URL rejected`); `fragment(id: string): SafeUrl` (`#id`, id must match `/^[a-z][a-z0-9-]*$/`).
- Rules the template enforces: text interpolation → `escapeText`; inside a double-quoted attribute → `escapeAttr`; inside a URL attribute (`href`, `src`, `action`, `formaction`, `poster`, `cite`, `data`, `ping`, `background`, `xlink:href`) → only `SafeUrl`; inside `on*`, `style`, `srcset`, `imagesrcset` or `srcdoc` → always throws (`never takes an interpolated value`); the attribute name is found even with spaces around `=`; between attributes → only `SafeHtml` (e.g. `trusted(" open")`) or nothing; markup inside an attribute throws.

- [ ] **Step 1: Create the package manifest and link it**

`packages/renderer/package.json`:

```json
{
  "name": "@asksite/renderer",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@asksite/site-schema": "workspace:*"
  }
}
```


Run: `pnpm install`
Expected: `Done in …s using pnpm v10.33.0`; `pnpm-lock.yaml` gains the `packages/renderer` importer.

- [ ] **Step 2: Write the failing tests**

`packages/renderer/test/escape.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { escapeAttr, escapeText } from "../src/escape.ts";

describe("escapeText", () => {
  it("neutralises markup", () => {
    expect(escapeText(`<script>alert("x")</script> & 'y'`)).toBe(`&lt;script&gt;alert("x")&lt;/script&gt; &amp; 'y'`);
  });
  it("escapes an existing entity so it renders literally", () => {
    expect(escapeText("&amp;")).toBe("&amp;amp;");
  });
});

describe("escapeAttr", () => {
  it("also escapes both quote characters", () => {
    expect(escapeAttr(`" onmouseover="alert(1)`)).toBe("&quot; onmouseover=&quot;alert(1)");
    expect(escapeAttr(`' onfocus='x`)).toBe("&#39; onfocus=&#39;x");
    expect(escapeAttr("<b>&")).toBe("&lt;b&gt;&amp;");
  });
});
```

`packages/renderer/test/html.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fragment, html, safeUrl, SafeHtml, trusted } from "../src/html.ts";

const PAYLOAD = `<img src=x onerror="alert(1)">'&`;

describe("html tagged template", () => {
  it("escapes text interpolations", () => {
    expect(String(html`<p>${PAYLOAD}</p>`)).toBe(`<p>&lt;img src=x onerror="alert(1)"&gt;'&amp;</p>`);
  });

  it("escapes attribute interpolations, including quotes", () => {
    expect(String(html`<p title="${PAYLOAD}">x</p>`)).toBe(
      `<p title="&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#39;&amp;">x</p>`,
    );
  });

  it("knows it is still inside a tag after an earlier interpolation", () => {
    const out = String(html`<a href="${safeUrl("https://example.com")}" title="${`"><script>`}">x</a>`);
    expect(out).toBe(`<a href="https://example.com" title="&quot;&gt;&lt;script&gt;">x</a>`);
  });

  it("renders numbers and skips false, null and undefined", () => {
    expect(String(html`<p>${3}${false}${null}${undefined}</p>`)).toBe("<p>3</p>");
  });

  it("joins arrays and passes nested templates through unescaped", () => {
    const items = ["a<", "b"].map((s) => html`<li>${s}</li>`);
    expect(String(html`<ul>${items}</ul>`)).toBe("<ul><li>a&lt;</li><li>b</li></ul>");
  });

  it("allows a trusted boolean attribute between attributes", () => {
    expect(String(html`<details name="faq"${trusted(" open")}>`)).toBe(`<details name="faq" open>`);
    expect(String(html`<details name="faq"${false}>`)).toBe(`<details name="faq">`);
  });

  it("refuses a plain string where an attribute name could be injected", () => {
    expect(() => html`<p ${"onclick=alert(1)"}>x</p>`).toThrow("double-quoted attribute value");
    expect(() => html`<p class=${"x"}>x</p>`).toThrow("double-quoted attribute value");
  });

  it("requires a SafeUrl in href, src and action", () => {
    expect(() => html`<a href="${"javascript:alert(1)"}">x</a>`).toThrow("needs a SafeUrl");
    expect(() => html`<img src="${"https://example.com/a.jpg"}" alt="">`).toThrow("needs a SafeUrl");
    expect(() => html`<form action="${undefined}"></form>`).toThrow("Missing URL");
  });

  it("finds the attribute name when there are spaces around =", () => {
    expect(() => html`<a href = "${"javascript:alert(1)"}">x</a>`).toThrow("needs a SafeUrl");
  });

  it("requires a SafeUrl in every other URL attribute", () => {
    expect(() => html`<button formaction="${"javascript:alert(1)"}">x</button>`).toThrow("needs a SafeUrl");
    expect(() => html`<video poster="${"javascript:alert(1)"}"></video>`).toThrow("needs a SafeUrl");
    expect(() => html`<object data="${"javascript:alert(1)"}"></object>`).toThrow("needs a SafeUrl");
  });

  it("never interpolates into event handlers, style, srcset or srcdoc", () => {
    expect(() => html`<p onclick="${"alert(1)"}">x</p>`).toThrow("never takes an interpolated value");
    expect(() => html`<p style="${"background:red"}">x</p>`).toThrow("never takes an interpolated value");
    expect(() => html`<img srcset="${safeUrl("https://example.com/a.jpg")}" alt="">`).toThrow("never takes an interpolated value");
    expect(() => html`<iframe srcdoc="${"<script>alert(1)</script>"}"></iframe>`).toThrow("never takes an interpolated value");
  });

  it("refuses markup inside an attribute", () => {
    expect(() => html`<p title="${html`<b>x</b>`}">x</p>`).toThrow("not allowed");
  });

  it("returns SafeHtml", () => {
    expect(html`<p></p>`).toBeInstanceOf(SafeHtml);
  });
});

describe("safeUrl", () => {
  it("accepts http, https, tel and mailto", () => {
    expect(String(safeUrl("tel:+15125550142"))).toBe("tel:+15125550142");
    expect(String(safeUrl("mailto:a@example.com"))).toBe("mailto:a@example.com");
  });
  it("throws on javascript: and friends", () => {
    expect(() => safeUrl("javascript:alert(1)")).toThrow("Unsafe URL rejected");
    expect(() => safeUrl(" JAVASCRIPT:alert(1)")).toThrow("Unsafe URL rejected");
    expect(() => safeUrl("http://example.com", ["https:"])).toThrow("Unsafe URL rejected");
  });
  it("escapes & in a URL attribute", () => {
    expect(String(html`<a href="${safeUrl("https://example.com/?a=1&b=2")}">x</a>`)).toBe(
      `<a href="https://example.com/?a=1&amp;b=2">x</a>`,
    );
  });
});

describe("fragment", () => {
  it("builds an in-page link to one of our ids", () => {
    expect(String(html`<a href="${fragment("service-area")}">x</a>`)).toBe(`<a href="#service-area">x</a>`);
  });
  it("rejects anything that is not a plain id", () => {
    expect(() => fragment(`x" onclick="y`)).toThrow("Invalid fragment id");
  });
});
```


- [ ] **Step 3: Run them and watch them fail**

Run: `pnpm vitest run packages/renderer/test/escape.test.ts packages/renderer/test/html.test.ts`
Expected: FAIL — `Cannot find module '../src/escape.ts'` and `Cannot find module '../src/html.ts'`, `Test Files  2 failed (2)`.

- [ ] **Step 4: Write the implementation**

`packages/renderer/src/escape.ts`:

```ts
// Text nodes only need &, < and > escaped. Attribute values (always double-quoted in our
// templates) also need both quote characters escaped.
const TEXT_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const ATTR_ESCAPES: Record<string, string> = { ...TEXT_ESCAPES, '"': "&quot;", "'": "&#39;" };

export function escapeText(value: string): string {
  return value.replace(/[&<>]/g, (c) => TEXT_ESCAPES[c] ?? c);
}

export function escapeAttr(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ATTR_ESCAPES[c] ?? c);
}
```

`packages/renderer/src/html.ts`:

```ts
import { isSafeUrl, type UrlScheme } from "@asksite/site-schema";
import { escapeAttr, escapeText } from "./escape.ts";

/** Markup that is already safe. Only `html` templates and `trusted()` literals create it. */
export class SafeHtml {
  readonly #markup: string;
  constructor(markup: string) {
    this.#markup = markup;
  }
  toString(): string {
    return this.#markup;
  }
}

/** A URL whose scheme has been checked. The only value `html` accepts in a URL attribute (href, src, action, …). */
export class SafeUrl {
  readonly #href: string;
  constructor(href: string) {
    this.#href = href;
  }
  toString(): string {
    return this.#href;
  }
}

export type Value = string | number | SafeHtml | SafeUrl | false | null | undefined | readonly Value[];

/** Wrap a string literal from our own source (icons, boolean attributes). Never pass user data. */
export function trusted(markup: string): SafeHtml {
  return new SafeHtml(markup);
}

/** Validate an absolute URL; throws on anything else, so an unsafe URL can never be rendered. */
export function safeUrl(input: string, allowed?: readonly UrlScheme[]): SafeUrl {
  if (!isSafeUrl(input, allowed)) throw new Error(`Unsafe URL rejected: ${JSON.stringify(input)}`);
  return new SafeUrl(input);
}

/** In-page link to one of our own element ids, e.g. "#services". */
export function fragment(id: string): SafeUrl {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`Invalid fragment id: ${JSON.stringify(id)}`);
  return new SafeUrl(`#${id}`);
}

type Context = { inTag: boolean; inQuote: boolean; attr: string };

// The attribute name just before `="`, allowing spaces around "=" as HTML does.
const ATTRIBUTE_NAME = /([^\s"'<>\/=]+)\s*=\s*$/;

// Tracks whether the end of the markup written so far is inside a tag and inside a
// double-quoted attribute value. Our literals never contain ">" inside attribute values.
function advance(context: Context, literal: string): Context {
  let { inTag, inQuote, attr } = context;
  for (let i = 0; i < literal.length; i++) {
    const c = literal[i];
    if (!inTag) {
      if (c === "<") inTag = true;
    } else if (inQuote) {
      if (c === '"') inQuote = false;
    } else if (c === '"') {
      inQuote = true;
      attr = ATTRIBUTE_NAME.exec(literal.slice(0, i))?.[1]?.toLowerCase() ?? "";
    } else if (c === ">") {
      inTag = false;
    }
  }
  return { inTag, inQuote, attr };
}

// Attributes a browser fetches or navigates to: only a SafeUrl may be interpolated.
const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "poster", "cite", "data", "ping", "background", "xlink:href"]);

// Attributes that run script, carry CSS, hold several URLs or hold a whole HTML document:
// no interpolation at all (a future srcset needs its own SafeSrcset type first).
const isNeverInterpolated = (attr: string) =>
  attr.startsWith("on") || attr === "style" || attr === "srcset" || attr === "imagesrcset" || attr === "srcdoc";

function interpolate(value: Value, context: Context): string {
  if (context.inQuote && isNeverInterpolated(context.attr)) {
    throw new Error(`The ${context.attr} attribute never takes an interpolated value`);
  }
  if (value === false || value === null || value === undefined) {
    if (context.inQuote && URL_ATTRIBUTES.has(context.attr)) throw new Error(`Missing URL for ${context.attr}`);
    return "";
  }
  if (!context.inTag) {
    if (value instanceof SafeHtml) return value.toString();
    if (Array.isArray(value)) return value.map((v: Value) => interpolate(v, context)).join("");
    return escapeText(String(value));
  }
  if (!context.inQuote) {
    // Between attributes only trusted literals (e.g. a boolean attribute) are allowed.
    if (value instanceof SafeHtml) return value.toString();
    throw new Error("Interpolation inside a tag must be a double-quoted attribute value");
  }
  if (URL_ATTRIBUTES.has(context.attr)) {
    if (!(value instanceof SafeUrl)) throw new Error(`The ${context.attr} attribute needs a SafeUrl`);
    return escapeAttr(value.toString());
  }
  if (value instanceof SafeHtml || Array.isArray(value)) throw new Error(`Markup is not allowed in the ${context.attr} attribute`);
  return escapeAttr(String(value));
}

/**
 * Tagged template that escapes every interpolation for where it lands:
 * text nodes -> escapeText, quoted attributes -> escapeAttr, URL attributes -> SafeUrl only,
 * event-handler/style/srcset/srcdoc attributes -> never.
 */
export function html(strings: TemplateStringsArray, ...values: Value[]): SafeHtml {
  let context: Context = advance({ inTag: false, inQuote: false, attr: "" }, strings[0] ?? "");
  let out = strings[0] ?? "";
  values.forEach((value, i) => {
    out += interpolate(value, context);
    const literal = strings[i + 1] ?? "";
    context = advance(context, literal);
    out += literal;
  });
  return new SafeHtml(out);
}
```


- [ ] **Step 5: Run the tests and the typecheck**

Run: `pnpm vitest run packages/renderer/test/escape.test.ts packages/renderer/test/html.test.ts && pnpm typecheck`
Expected: `Tests  21 passed (21)`; typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/renderer/package.json pnpm-lock.yaml packages/renderer/src/escape.ts packages/renderer/src/html.ts packages/renderer/test/escape.test.ts packages/renderer/test/html.test.ts
git commit -m "Add escaping template"
```

---
### Task 6: Safe JSON-LD (LocalBusiness and FAQPage)

**Files:**
- Create: `packages/renderer/src/json-ld.ts`
- Test: `packages/renderer/test/json-ld.test.ts`

**Interfaces:**
- Consumes: `SafeHtml` (Task 5); types `Facts`, `FaqItem`, `Trade` from `@asksite/site-schema`.
- Produces: `serializeJsonLd(data: unknown): string` (never contains `<`, `>`, `&`, U+2028, U+2029); `jsonLdScript(data: unknown): SafeHtml` (one `<script type="application/ld+json">`); `SCHEMA_TYPE: Record<Trade, string>` (Plumber, HVACBusiness, Electrician, RoofingContractor, HomeAndConstructionBusiness ×2); `localBusinessJsonLd(facts: Facts): Record<string, unknown>` (includes `areaServed` and, when hours exist, `openingHoursSpecification`); `faqPageJsonLd(items: readonly FaqItem[]): Record<string, unknown>`.

- [ ] **Step 1: Write the failing test**

`packages/renderer/test/json-ld.test.ts`:

```ts
import { Facts } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { faqPageJsonLd, jsonLdScript, localBusinessJsonLd, serializeJsonLd } from "../src/json-ld.ts";

const BREAKOUT = "Joe</script><script>alert(1)</script><!--";

const facts = Facts.parse({
  businessName: "Reliable Rooter",
  trade: "plumbing",
  phone: "+15125550142",
  email: "office@example.com",
  location: { streetAddress: "100 Congress Ave", city: "Austin", state: "TX", postalCode: "78701" },
  serviceArea: { places: ["Austin", "Round Rock", "78704"] },
  hours: [
    { days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], opens: "08:00", closes: "17:00" },
    { days: ["Saturday"], opens: "09:00", closes: "13:00" },
  ],
  services: [{ name: "Drain cleaning" }],
  yearFounded: 1998,
  socialLinks: [{ network: "facebook", url: "https://www.facebook.com/reliablerooter" }],
});

describe("serializeJsonLd", () => {
  it("never emits <, > or & and round-trips exactly", () => {
    const out = serializeJsonLd({ name: BREAKOUT, amp: "a&b", ls: "x\u2028y\u2029z" });
    expect(out).not.toMatch(/[<>&\u2028\u2029]/);
    expect(out).toContain("\\u003c/script\\u003e");
    expect(JSON.parse(out)).toEqual({ name: BREAKOUT, amp: "a&b", ls: "x\u2028y\u2029z" });
  });

  it("wraps the payload in one ld+json script", () => {
    const tag = String(jsonLdScript({ name: BREAKOUT }));
    expect(tag.startsWith('<script type="application/ld+json">')).toBe(true);
    expect(tag.match(/<\/script>/g)).toHaveLength(1);
    expect(tag.match(/<script/g)).toHaveLength(1);
  });
});

describe("localBusinessJsonLd", () => {
  it("uses the most specific type and owner facts only", () => {
    expect(localBusinessJsonLd(facts)).toEqual({
      "@context": "https://schema.org",
      "@type": "Plumber",
      name: "Reliable Rooter",
      telephone: "+15125550142",
      email: "office@example.com",
      address: {
        "@type": "PostalAddress",
        streetAddress: "100 Congress Ave",
        addressLocality: "Austin",
        addressRegion: "TX",
        postalCode: "78701",
        addressCountry: "US",
      },
      areaServed: ["Austin", "Round Rock", "78704"],
      openingHoursSpecification: [
        {
          "@type": "OpeningHoursSpecification",
          dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
          opens: "08:00",
          closes: "17:00",
        },
        { "@type": "OpeningHoursSpecification", dayOfWeek: ["Saturday"], opens: "09:00", closes: "13:00" },
      ],
      foundingDate: "1998",
      sameAs: ["https://www.facebook.com/reliablerooter"],
    });
  });

  it("falls back to HomeAndConstructionBusiness and omits missing optional facts", () => {
    const ld = localBusinessJsonLd(
      Facts.parse({
        businessName: "Mop",
        trade: "cleaning",
        phone: "+15125550142",
        email: "hi@example.com",
        location: { city: "Austin", state: "TX" },
        serviceArea: { places: ["Austin"] },
        services: [{ name: "Cleaning" }],
      }),
    );
    expect(ld["@type"]).toBe("HomeAndConstructionBusiness");
    expect(ld["address"]).toEqual({
      "@type": "PostalAddress",
      addressLocality: "Austin",
      addressRegion: "TX",
      addressCountry: "US",
    });
    expect(Object.keys(ld)).not.toContain("openingHoursSpecification");
    expect(Object.keys(ld)).not.toContain("sameAs");
  });
});

describe("faqPageJsonLd", () => {
  it("maps questions and answers", () => {
    expect(faqPageJsonLd([{ question: "Do you charge for estimates?", answer: "No, estimates are free." }])).toEqual({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: [
        {
          "@type": "Question",
          name: "Do you charge for estimates?",
          acceptedAnswer: { "@type": "Answer", text: "No, estimates are free." },
        },
      ],
    });
  });
});
```


- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/renderer/test/json-ld.test.ts`
Expected: FAIL — `Cannot find module '../src/json-ld.ts'`.

- [ ] **Step 3: Write the implementation**

`packages/renderer/src/json-ld.ts`:

```ts
import type { FaqItem, Facts, Trade } from "@asksite/site-schema";
import { SafeHtml } from "./html.ts";

// JSON has no "\x3C" escape, so "<", ">" and "&" become \u003c, \u003e and \u0026: the output
// can never contain "</script" or "<!--" (WHATWG "Restrictions for contents of script elements").
// U+2028/U+2029 are escaped for older parsers that treat them as line breaks.
const JSON_LD_ESCAPES: Record<string, string> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/[<>&\u2028\u2029]/g, (c) => JSON_LD_ESCAPES[c] ?? c);
}

export function jsonLdScript(data: unknown): SafeHtml {
  return new SafeHtml(`<script type="application/ld+json">${serializeJsonLd(data)}</script>`);
}

// Most specific schema.org type per trade. schema.org has no cleaning or landscaping type.
export const SCHEMA_TYPE: Record<Trade, string> = {
  plumbing: "Plumber",
  hvac: "HVACBusiness",
  electrical: "Electrician",
  roofing: "RoofingContractor",
  cleaning: "HomeAndConstructionBusiness",
  landscaping: "HomeAndConstructionBusiness",
};

export function localBusinessJsonLd(facts: Facts): Record<string, unknown> {
  const { location } = facts;
  return {
    "@context": "https://schema.org",
    "@type": SCHEMA_TYPE[facts.trade],
    name: facts.businessName,
    telephone: facts.phone,
    email: facts.email,
    address: {
      "@type": "PostalAddress",
      ...(location.streetAddress ? { streetAddress: location.streetAddress } : {}),
      addressLocality: location.city,
      addressRegion: location.state,
      ...(location.postalCode ? { postalCode: location.postalCode } : {}),
      addressCountry: "US",
    },
    areaServed: facts.serviceArea.places,
    ...(facts.hours.length > 0
      ? {
          openingHoursSpecification: facts.hours.map((h) => ({
            "@type": "OpeningHoursSpecification",
            dayOfWeek: h.days,
            opens: h.opens,
            closes: h.closes,
          })),
        }
      : {}),
    ...(facts.yearFounded ? { foundingDate: String(facts.yearFounded) } : {}),
    ...(facts.heroPhoto ? { image: facts.heroPhoto.url } : {}),
    ...(facts.socialLinks.length > 0 ? { sameAs: facts.socialLinks.map((s) => s.url) } : {}),
  };
}

export function faqPageJsonLd(items: readonly FaqItem[]): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: { "@type": "Answer", text: item.answer },
    })),
  };
}
```


- [ ] **Step 4: Run the test and the typecheck**

Run: `pnpm vitest run packages/renderer/test/json-ld.test.ts && pnpm typecheck`
Expected: `Tests  5 passed (5)`; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/renderer/src/json-ld.ts packages/renderer/test/json-ld.test.ts
git commit -m "Add JSON-LD builders"
```

---
### Task 7: WCAG contrast, palettes and font presets

**Files:**
- Create: `packages/renderer/src/contrast.ts`, `packages/renderer/src/theme.ts`
- Test: `packages/renderer/test/contrast.test.ts`, `packages/renderer/test/theme.test.ts`

**Interfaces:**
- Consumes: `SafeHtml` (Task 5); `PALETTE_IDS`, `FONT_IDS`, types `Theme`, `PaletteId`, `FontId` from `@asksite/site-schema`.
- Produces: `type Rgb`, `AA_NORMAL_TEXT = 4.5`, `AA_LARGE_TEXT = 3`, `hexToRgb(hex: string): Rgb`, `relativeLuminance(rgb: Rgb): number`, `contrastRatio(a: Rgb, b: Rgb): number`; `interface Palette` (primary, secondary, accent, textHeading, textDefault, textMuted, bgPage, bgPageDark, link), `interface FontPreset` (sans, serif, heading), `PALETTES: Record<PaletteId, Palette>`, `FONTS: Record<FontId, FontPreset>`, `themeVariables(theme: Theme): Record<string, string>` (exactly 12 `--aw-*` properties), `themeStyle(theme: Theme): SafeHtml` (`<style>:root{…}</style>`).
- The test lists every text/background pair the templates use (heading, body, muted, primary, secondary and link text on the page and on white cards; white on primary and secondary buttons; white on the dark band; heading text on the accent badge). A new pairing in a template must be added here first.

- [ ] **Step 1: Write the failing tests**

`packages/renderer/test/contrast.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { contrastRatio, hexToRgb, relativeLuminance } from "../src/contrast.ts";

describe("hexToRgb", () => {
  it("parses #RRGGBB in either case", () => {
    expect(hexToRgb("#1d4ED8")).toEqual([29, 78, 216]);
  });
  it("rejects anything else", () => {
    expect(() => hexToRgb("#fff")).toThrow("Expected #RRGGBB");
    expect(() => hexToRgb("rgb(0 0 0)")).toThrow("Expected #RRGGBB");
  });
});

describe("WCAG 2.2 contrast", () => {
  it("luminance endpoints are 0 and 1", () => {
    expect(relativeLuminance([0, 0, 0])).toBe(0);
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 10);
  });
  it("black on white is 21:1 in either order", () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 10);
    expect(contrastRatio([255, 255, 255], [0, 0, 0])).toBeCloseTo(21, 10);
  });
  it("a colour on itself is 1:1", () => {
    expect(contrastRatio([10, 20, 30], [10, 20, 30])).toBe(1);
  });
  it("#767676 on white passes AA at 4.54:1 and #777777 fails at 4.48:1", () => {
    expect(contrastRatio(hexToRgb("#767676"), hexToRgb("#FFFFFF"))).toBeCloseTo(4.54, 2);
    expect(contrastRatio(hexToRgb("#777777"), hexToRgb("#FFFFFF"))).toBeCloseTo(4.48, 2);
  });
});
```

`packages/renderer/test/theme.test.ts`:

```ts
import { FONT_IDS, PALETTE_IDS } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { AA_NORMAL_TEXT, contrastRatio, hexToRgb } from "../src/contrast.ts";
import { FONTS, PALETTES, themeStyle, themeVariables, type Palette } from "../src/theme.ts";

const WHITE = "#FFFFFF";

// Every text-on-background pair the section templates use. Adding a new pairing to a
// template means adding it here first.
function pairs(p: Palette): Array<[label: string, fg: string, bg: string]> {
  const onSurfaces = (["textHeading", "textDefault", "textMuted", "primary", "secondary", "link"] as const).flatMap(
    (key): Array<[string, string, string]> => [
      [`${key} on page`, p[key], p.bgPage],
      [`${key} on white card`, p[key], WHITE],
    ],
  );
  return [
    ...onSurfaces,
    ["white on primary button", WHITE, p.primary],
    ["white on secondary (button hover)", WHITE, p.secondary],
    ["white on dark band", WHITE, p.bgPageDark],
    ["heading text on accent badge", p.textHeading, p.accent],
  ];
}

describe("palette presets", () => {
  it("covers every palette id in the schema", () => {
    expect(Object.keys(PALETTES).sort()).toEqual([...PALETTE_IDS].sort());
  });

  describe.each(PALETTE_IDS)("%s", (id) => {
    it.each(pairs(PALETTES[id]))("%s passes AA (4.5:1)", (_label, fg, bg) => {
      expect(contrastRatio(hexToRgb(fg), hexToRgb(bg))).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    });
  });

  it("the check catches a failing pair (RED proof)", () => {
    const failing = { ...PALETTES["navy-orange"], textMuted: "#9CA3AF" };
    const muted = pairs(failing).find(([label]) => label === "textMuted on page");
    expect(muted).toBeDefined();
    const [, fg, bg] = muted ?? ["", WHITE, WHITE];
    expect(contrastRatio(hexToRgb(fg), hexToRgb(bg))).toBeLessThan(AA_NORMAL_TEXT);
  });
});

describe("font presets", () => {
  it("covers every font id in the schema", () => {
    expect(Object.keys(FONTS).sort()).toEqual([...FONT_IDS].sort());
  });
  it("uses system stacks only (no web-font URLs)", () => {
    for (const preset of Object.values(FONTS)) {
      expect(JSON.stringify(preset)).not.toMatch(/url\(|https?:|@import/);
      expect(preset.heading).toMatch(/sans-serif$/);
    }
  });
});

describe("theme output", () => {
  it("resolves to exactly 12 CSS custom properties", () => {
    const vars = themeVariables({ palette: "navy-orange", font: "clean" });
    expect(Object.keys(vars)).toHaveLength(12);
    expect(vars["--aw-color-primary"]).toBe("#1D4ED8");
    expect(vars["--aw-font-sans"]).toBe("system-ui, sans-serif");
  });
  it("renders one inline :root style block", () => {
    const css = String(themeStyle({ palette: "charcoal-red", font: "sturdy" }));
    expect(css.startsWith("<style>:root{--aw-font-sans:system-ui, sans-serif;")).toBe(true);
    expect(css).toContain("--aw-color-primary:#B91C1C;");
    expect(css.endsWith("}</style>")).toBe(true);
  });
});
```


- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run packages/renderer/test/contrast.test.ts packages/renderer/test/theme.test.ts`
Expected: FAIL — `Cannot find module '../src/contrast.ts'` in both files, `Test Files  2 failed (2)`.

- [ ] **Step 3: Write the implementation**

`packages/renderer/src/contrast.ts`:

```ts
// WCAG 2.2 relative luminance and contrast ratio.
// https://www.w3.org/TR/WCAG22/#dfn-relative-luminance and #dfn-contrast-ratio
export type Rgb = readonly [r: number, g: number, b: number];

export const AA_NORMAL_TEXT = 4.5;
export const AA_LARGE_TEXT = 3;

export function hexToRgb(hex: string): Rgb {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) throw new Error(`Expected #RRGGBB, got ${JSON.stringify(hex)}`);
  return [parseInt(match[1] ?? "", 16), parseInt(match[2] ?? "", 16), parseInt(match[3] ?? "", 16)];
}

function channel(c8: number): number {
  const c = c8 / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
```

`packages/renderer/src/theme.ts`:

```ts
import type { FontId, PaletteId, Theme } from "@asksite/site-schema";
import { SafeHtml } from "./html.ts";

export interface Palette {
  primary: string;
  secondary: string;
  accent: string;
  textHeading: string;
  textDefault: string;
  textMuted: string;
  bgPage: string;
  bgPageDark: string;
  link: string;
}

export interface FontPreset {
  sans: string;
  serif: string;
  heading: string;
}

// Solid hex only (no alpha), so contrast can be checked exactly. Every text/background pair
// the templates use is asserted to pass WCAG AA in test/theme.test.ts.
export const PALETTES: Record<PaletteId, Palette> = {
  "navy-orange": {
    primary: "#1D4ED8",
    secondary: "#1E3A8A",
    accent: "#F97316",
    textHeading: "#0B1220",
    textDefault: "#1F2937",
    textMuted: "#4B5563",
    bgPage: "#FFFFFF",
    bgPageDark: "#0B1F3A",
    link: "#1D4ED8",
  },
  "blue-yellow": {
    primary: "#0B5CAD",
    secondary: "#08467F",
    accent: "#FACC15",
    textHeading: "#0A1628",
    textDefault: "#1E293B",
    textMuted: "#475569",
    bgPage: "#FFFFFF",
    bgPageDark: "#0A1F33",
    link: "#0B5CAD",
  },
  "green-amber": {
    primary: "#15803D",
    secondary: "#166534",
    accent: "#F59E0B",
    textHeading: "#0C1A12",
    textDefault: "#1C2B22",
    textMuted: "#4A5A50",
    bgPage: "#FCFCF9",
    bgPageDark: "#0F2A1D",
    link: "#15803D",
  },
  "charcoal-red": {
    primary: "#B91C1C",
    secondary: "#991B1B",
    accent: "#FBBF24",
    textHeading: "#111111",
    textDefault: "#262626",
    textMuted: "#525252",
    bgPage: "#FFFFFF",
    bgPageDark: "#1C1C1E",
    link: "#B91C1C",
  },
};

// System font stacks from modern-font-stacks (CC0). No web-font download, no third-party request.
const SYSTEM_UI = "system-ui, sans-serif";
const TRANSITIONAL = "Charter, 'Bitstream Charter', 'Sitka Text', Cambria, serif";

export const FONTS: Record<FontId, FontPreset> = {
  clean: {
    sans: SYSTEM_UI,
    serif: TRANSITIONAL,
    heading: "Inter, Roboto, 'Helvetica Neue', 'Arial Nova', 'Nimbus Sans', Arial, sans-serif",
  },
  sturdy: {
    sans: SYSTEM_UI,
    serif: TRANSITIONAL,
    heading: "Bahnschrift, 'DIN Alternate', 'Franklin Gothic Medium', 'Nimbus Sans Narrow', sans-serif-condensed, sans-serif",
  },
  friendly: {
    sans: "Seravek, 'Gill Sans Nova', Ubuntu, Calibri, 'DejaVu Sans', source-sans-pro, sans-serif",
    serif: TRANSITIONAL,
    heading: "Avenir, Montserrat, Corbel, 'URW Gothic', source-sans-pro, sans-serif",
  },
};

/** The 12 per-site CSS custom properties (3 fonts + 9 colours) read by the shared stylesheet. */
export function themeVariables(theme: Theme): Record<string, string> {
  const p = PALETTES[theme.palette];
  const f = FONTS[theme.font];
  return {
    "--aw-font-sans": f.sans,
    "--aw-font-serif": f.serif,
    "--aw-font-heading": f.heading,
    "--aw-color-primary": p.primary,
    "--aw-color-secondary": p.secondary,
    "--aw-color-accent": p.accent,
    "--aw-color-text-heading": p.textHeading,
    "--aw-color-text-default": p.textDefault,
    "--aw-color-text-muted": p.textMuted,
    "--aw-color-bg-page": p.bgPage,
    "--aw-color-bg-page-dark": p.bgPageDark,
    "--aw-color-link": p.link,
  };
}

/** Inline <style> block for the page head. Values are our own constants, never user input. */
export function themeStyle(theme: Theme): SafeHtml {
  const declarations = Object.entries(themeVariables(theme))
    .map(([name, value]) => `${name}:${value};`)
    .join("");
  return new SafeHtml(`<style>:root{${declarations}}</style>`);
}
```


- [ ] **Step 4: Run the tests and the typecheck**

Run: `pnpm vitest run packages/renderer/test/contrast.test.ts packages/renderer/test/theme.test.ts && pnpm typecheck`
Expected: `Tests  76 passed (76)` (every palette pair passes 4.5:1); typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/renderer/src/contrast.ts packages/renderer/src/theme.ts packages/renderer/test/contrast.test.ts packages/renderer/test/theme.test.ts
git commit -m "Add theme presets"
```

---
### Task 8: Formatting helpers and icons

**Files:**
- Create: `packages/renderer/src/format.ts`, `packages/renderer/src/icons.ts`
- Test: `packages/renderer/test/format.test.ts`, `packages/renderer/test/icons.test.ts`

**Interfaces:**
- Consumes: `html`, `trusted`, `safeUrl`, `SafeUrl`, `SafeHtml` (Task 5); `DAYS`, types `Day`, `OpeningHours`, `Trade` from `@asksite/site-schema`.
- Produces: `TRADE_LABEL: Record<Trade, string>`, `formatPhone(e164: string): string` (`(512) 555-0142`), `telUrl(e164: string): SafeUrl` (`tel:+15125550142`), `mailtoUrl(email: string): SafeUrl`, `formatPrice(dollars: number): string` (`$1,250`), `formatTime(hhmm: string): string` (`8:00 AM`), `weeklyHours(hours): Array<{ day: Day; time: string }>` (Monday first, `Closed`, `Open 24 hours`); `type IconName` (`phone`, `menu-2`, `x`, `chevron-down`, `chevron-right`, `check`, `shield-check`, `certificate`, `clock`, `map-pin`, `circle-check`), `icon(name: IconName, className: string): SafeHtml` (decorative `<svg … aria-hidden="true">`).

- [ ] **Step 1: Write the failing tests**

`packages/renderer/test/format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatPhone, formatPrice, formatTime, mailtoUrl, telUrl, weeklyHours } from "../src/format.ts";

describe("format", () => {
  it("formats a US phone number for display and for tel: links", () => {
    expect(formatPhone("+15125550142")).toBe("(512) 555-0142");
    expect(String(telUrl("+15125550142"))).toBe("tel:+15125550142");
  });

  it("builds a mailto link", () => {
    expect(String(mailtoUrl("office@example.com"))).toBe("mailto:office@example.com");
  });

  it("formats whole-dollar prices", () => {
    expect(formatPrice(89)).toBe("$89");
    expect(formatPrice(1250)).toBe("$1,250");
    expect(formatPrice(100000)).toBe("$100,000");
  });

  it.each([
    ["00:00", "12:00 AM"],
    ["08:00", "8:00 AM"],
    ["12:00", "12:00 PM"],
    ["13:30", "1:30 PM"],
    ["23:59", "11:59 PM"],
  ])("formats %s as %s", (input, expected) => {
    expect(formatTime(input)).toBe(expected);
  });

  it("lists all seven days with Closed and Open 24 hours", () => {
    expect(
      weeklyHours([
        { days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], opens: "08:00", closes: "17:00" },
        { days: ["Saturday"], opens: "00:00", closes: "23:59" },
      ]),
    ).toEqual([
      { day: "Monday", time: "8:00 AM – 5:00 PM" },
      { day: "Tuesday", time: "8:00 AM – 5:00 PM" },
      { day: "Wednesday", time: "8:00 AM – 5:00 PM" },
      { day: "Thursday", time: "8:00 AM – 5:00 PM" },
      { day: "Friday", time: "8:00 AM – 5:00 PM" },
      { day: "Saturday", time: "Open 24 hours" },
      { day: "Sunday", time: "Closed" },
    ]);
  });
});
```

`packages/renderer/test/icons.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { icon } from "../src/icons.ts";

describe("icon", () => {
  it("renders a decorative, hidden inline SVG", () => {
    expect(String(icon("check", "h-5 w-5 text-primary"))).toBe(
      '<svg class="h-5 w-5 text-primary" viewBox="0 0 24 24" aria-hidden="true">' +
        '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m5 12l5 5L20 7"/></svg>',
    );
  });
});
```


- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run packages/renderer/test/format.test.ts packages/renderer/test/icons.test.ts`
Expected: FAIL — `Cannot find module '../src/format.ts'` and `Cannot find module '../src/icons.ts'`.

- [ ] **Step 3: Write the implementation**

`packages/renderer/src/format.ts`:

```ts
import { DAYS, type Day, type OpeningHours, type Trade } from "@asksite/site-schema";
import { safeUrl, type SafeUrl } from "./html.ts";

export const TRADE_LABEL: Record<Trade, string> = {
  plumbing: "Plumbing",
  hvac: "Heating & Cooling",
  electrical: "Electrical",
  roofing: "Roofing",
  cleaning: "Cleaning",
  landscaping: "Landscaping",
};

/** "+15125550142" -> "(512) 555-0142". Input is already validated as US E.164. */
export function formatPhone(e164: string): string {
  const d = e164.slice(2);
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

/** RFC 3966 global number: tel:+15125550142. */
export function telUrl(e164: string): SafeUrl {
  return safeUrl(`tel:${e164}`, ["tel:"]);
}

export function mailtoUrl(email: string): SafeUrl {
  return safeUrl(`mailto:${email}`, ["mailto:"]);
}

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** 1250 -> "$1,250". */
export function formatPrice(dollars: number): string {
  return USD.format(dollars);
}

/** "08:00" -> "8:00 AM", "13:30" -> "1:30 PM", "00:00" -> "12:00 AM". */
export function formatTime(hhmm: string): string {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  const suffix = h < 12 ? "AM" : "PM";
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** One row per day, Monday first. Days without an entry are "Closed". */
export function weeklyHours(hours: readonly OpeningHours[]): Array<{ day: Day; time: string }> {
  return DAYS.map((day) => {
    const entry = hours.find((h) => h.days.includes(day));
    if (!entry) return { day, time: "Closed" };
    if (entry.opens === "00:00" && entry.closes === "23:59") return { day, time: "Open 24 hours" };
    return { day, time: `${formatTime(entry.opens)} – ${formatTime(entry.closes)}` };
  });
}
```

`packages/renderer/src/icons.ts`:

```ts
import { html, trusted, type SafeHtml } from "./html.ts";

// Tabler Icons 3.48.0 (MIT, see THIRD_PARTY_NOTICES.md), SVG bodies copied from
// @iconify-json/tabler 1.2.40. All are 24x24, stroke-based and use currentColor.
const ICON_BODIES = {
  phone:
    '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 4h4l2 5l-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
  "menu-2":
    '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/>',
  x: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 6L6 18M6 6l12 12"/>',
  "chevron-down":
    '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m6 9l6 6l6-6"/>',
  "chevron-right":
    '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m9 6l6 6l-6 6"/>',
  check:
    '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m5 12l5 5L20 7"/>',
  "shield-check":
    '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11.46 20.846A12 12 0 0 1 3.5 6A12 12 0 0 0 12 3a12 12 0 0 0 8.5 3a12 12 0 0 1-.09 7.06M15 19l2 2l4-4"/>',
  certificate:
    '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M12 15a3 3 0 1 0 6 0a3 3 0 1 0-6 0"/><path d="M13 17.5V22l2-1.5l2 1.5v-4.5"/><path d="M10 19H5a2 2 0 0 1-2-2V7c0-1.1.9-2 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-1 1.73M6 9h12M6 12h3m-3 3h2"/></g>',
  clock:
    '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0-18 0"/><path d="M12 7v5l3 3"/></g>',
  "map-pin":
    '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M9 11a3 3 0 1 0 6 0a3 3 0 0 0-6 0"/><path d="M17.657 16.657L13.414 20.9a2 2 0 0 1-2.827 0l-4.244-4.243a8 8 0 1 1 11.314 0"/></g>',
  "circle-check":
    '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0"/><path d="m9 12l2 2l4-4"/></g>',
} as const;

export type IconName = keyof typeof ICON_BODIES;

/** Decorative inline SVG. `className` must be a whole literal class string from our source. */
export function icon(name: IconName, className: string): SafeHtml {
  return html`<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true">${trusted(ICON_BODIES[name])}</svg>`;
}
```


- [ ] **Step 4: Run the tests and the typecheck**

Run: `pnpm vitest run packages/renderer/test/format.test.ts packages/renderer/test/icons.test.ts && pnpm typecheck`
Expected: `Tests  10 passed (10)`; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/renderer/src/format.ts packages/renderer/src/icons.ts packages/renderer/test/format.test.ts packages/renderer/test/icons.test.ts
git commit -m "Add formatters icons"
```

---
### Task 9: Tailwind stylesheet, shared UI and the class-drift check

**Files:**
- Modify: `package.json` (adds `build:css`; `test` builds CSS first)
- Modify: `packages/renderer/package.json` (adds Tailwind and the `build:css` script)
- Create: `packages/renderer/styles/input.css`, `packages/renderer/src/ui.ts`, `THIRD_PARTY_NOTICES.md`
- Test: `packages/renderer/test/support/css-classes.ts`, `packages/renderer/test/ui.test.ts`

**Interfaces:**
- Consumes: `html`, `SafeHtml`, `Value` (Task 5).
- Produces: `type ContainerWidth = "6xl" | "7xl"`, `headline(domId: string, title: Value, subtitle?: string): SafeHtml` (h2 id `${domId}-title`), `sectionShell(domId: string, width: ContainerWidth, content: SafeHtml): SafeHtml` (`<section id aria-labelledby>`); CSS utilities `btn`, `btn-primary`, `btn-secondary`; the custom variant `focus-outside:` (applies while keyboard focus is anywhere outside the page's `<aside>`, used by the call bar in Task 10); Tailwind colour tokens `primary`, `secondary`, `accent`, `heading`, `default`, `muted`, `link`, `page`, `dark` and font tokens `sans`, `serif`, `heading`, all pointing at the `--aw-*` variables. Test helpers: `MARKER_CLASSES`, `loadCompiledCss(): string`, `cssEscape(value: string): string`, `hasClassSelector(css: string, className: string): boolean`, `classesIn(html: string): string[]`, `missingClasses(html: string, css: string): string[]`.
- `pnpm build:css` writes `packages/renderer/styles/site.css` (gitignored). Plan 2 must run it before publishing.

- [ ] **Step 1: Add Tailwind and the stylesheet input**

`package.json`:

```json
{
  "name": "asksite",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.33.0",
  "engines": {
    "node": ">=24.8.0"
  },
  "scripts": {
    "build:css": "pnpm --filter @asksite/renderer run build:css",
    "typecheck": "tsc -p .",
    "test": "pnpm build:css && vitest run"
  },
  "devDependencies": {
    "@types/node": "24.13.6",
    "typescript": "7.0.2",
    "vitest": "5.0.1"
  }
}
```

`packages/renderer/package.json`:

```json
{
  "name": "@asksite/renderer",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "build:css": "tailwindcss -i styles/input.css -o styles/site.css --minify"
  },
  "dependencies": {
    "@asksite/site-schema": "workspace:*"
  },
  "devDependencies": {
    "@tailwindcss/cli": "4.3.3",
    "tailwindcss": "4.3.3"
  }
}
```

`packages/renderer/styles/input.css`:

```css
/* Compiled ONCE into styles/site.css by `pnpm build:css`; every page inlines the same sheet.
   source(none) turns off automatic scanning so only our own templates are read. */
@import "tailwindcss" source(none);
@source "../src";

/* Design tokens point at the 12 per-site custom properties that each page sets in its own
   inline <style> (src/theme.ts). `inline` keeps the var() reference inside every utility. */
@theme inline {
  --color-primary: var(--aw-color-primary);
  --color-secondary: var(--aw-color-secondary);
  --color-accent: var(--aw-color-accent);
  --color-heading: var(--aw-color-text-heading);
  --color-default: var(--aw-color-text-default);
  --color-muted: var(--aw-color-text-muted);
  --color-link: var(--aw-color-link);
  --color-page: var(--aw-color-bg-page);
  --color-dark: var(--aw-color-bg-page-dark);
  --font-sans: var(--aw-font-sans);
  --font-serif: var(--aw-font-serif);
  --font-heading: var(--aw-font-heading);
}

/* WebKit ignores scroll-padding when it scrolls a focused element into view, so a focused field
   could end up under the sticky phone call bar (WCAG 2.4.11 Focus Not Obscured). While keyboard
   focus is on anything outside the bar (the page's only <aside>), the bar stops sticking. */
@custom-variant focus-outside (html:has(:focus-visible:not(aside *)) &);

/* Buttons ported from AstroWind's tailwind.css (MIT, see THIRD_PARTY_NOTICES.md). Changes:
   dark-mode and ring variants dropped, 48px minimum height for thumbs, brand-coloured focus
   outline, and a secondary style that meets WCAG AA on every palette. */
@utility btn {
  @apply inline-flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-full border-2 px-6 py-3 text-center text-base leading-snug font-semibold transition duration-200 ease-in focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary md:px-8;
}

@utility btn-primary {
  @apply btn border-primary bg-primary text-white hover:border-secondary hover:bg-secondary;
}

@utility btn-secondary {
  @apply btn border-primary bg-page text-primary hover:bg-primary hover:text-white;
}
```


Run: `pnpm install`
Expected: `Done in …s using pnpm v10.33.0`.

- [ ] **Step 2: Write the class-drift helpers and the failing test**

`packages/renderer/test/support/css-classes.ts`:

```ts
import { readFileSync } from "node:fs";

// Classes that intentionally produce no CSS rule of their own: `group` is only a marker for
// group-open:/group-hover: selectors on descendants.
export const MARKER_CLASSES: ReadonlySet<string> = new Set(["group"]);

export function loadCompiledCss(): string {
  return readFileSync(new URL("../../styles/site.css", import.meta.url), "utf8");
}

// Port of CSSOM CSS.escape() (https://drafts.csswg.org/cssom/#serialize-an-identifier),
// which is how Tailwind writes selectors such as .md\:px-6 or .w-1\/2.
export function cssEscape(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value.charAt(i);
    const code = value.charCodeAt(i);
    const isDigit = code >= 0x30 && code <= 0x39;
    if (code === 0) out += "�";
    else if ((code >= 0x1 && code <= 0x1f) || code === 0x7f || (i === 0 && isDigit) || (i === 1 && isDigit && value.charCodeAt(0) === 0x2d))
      out += `\\${code.toString(16)} `;
    else if (i === 0 && value.length === 1 && code === 0x2d) out += `\\${ch}`;
    else if (code >= 0x80 || code === 0x2d || code === 0x5f || isDigit || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a))
      out += ch;
    else out += `\\${ch}`;
  }
  return out;
}

/** True when the sheet has a selector for exactly this class (not merely a longer class starting with it). */
export function hasClassSelector(css: string, className: string): boolean {
  const needle = `.${cssEscape(className)}`;
  for (let i = css.indexOf(needle); i !== -1; i = css.indexOf(needle, i + 1)) {
    const next = css.charAt(i + needle.length);
    if (next === "" || !/[A-Za-z0-9_\\-]/.test(next)) return true;
  }
  return false;
}

/** Every class used in `html` class="" attributes. Our templates never use single-quoted attributes. */
export function classesIn(html: string): string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(/\sclass="([^"]*)"/g)) {
    for (const name of (match[1] ?? "").split(/\s+/)) if (name) found.add(name.replaceAll("&amp;", "&").replaceAll("&#39;", "'"));
  }
  return [...found].sort();
}

/** Classes used in `html` that the compiled stylesheet does not define. */
export function missingClasses(html: string, css: string): string[] {
  return classesIn(html).filter((name) => !MARKER_CLASSES.has(name) && !hasClassSelector(css, name));
}
```

`packages/renderer/test/ui.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { html } from "../src/html.ts";
import { headline, sectionShell } from "../src/ui.ts";
import { classesIn, hasClassSelector, loadCompiledCss, missingClasses } from "./support/css-classes.ts";

const css = loadCompiledCss();

describe("headline", () => {
  it("renders an escaped h2 with an id for aria-labelledby, and an optional subtitle", () => {
    const out = String(headline("services", "Pipes & <drains>", "We fix them"));
    expect(out).toContain('<h2 id="services-title"');
    expect(out).toContain(">Pipes &amp; &lt;drains&gt;</h2>");
    expect(out).toContain(">We fix them</p>");
    expect(String(headline("faq", "Questions"))).not.toContain("<p");
  });
});

describe("sectionShell", () => {
  it("wraps content in a labelled section with the chosen width", () => {
    const out = String(sectionShell("faq", "6xl", html`<p>x</p>`));
    expect(out).toMatch(/^<section id="faq" aria-labelledby="faq-title">/);
    expect(out).toContain("max-w-6xl");
  });
});

describe("compiled stylesheet", () => {
  it("defines every class the shared UI uses", () => {
    const markup = String(sectionShell("a", "7xl", headline("a", "T", "S"))) + String(sectionShell("b", "6xl", html``));
    expect(classesIn(markup).length).toBeGreaterThan(10);
    expect(missingClasses(markup, css)).toEqual([]);
  });

  it("points theme utilities at the per-site custom properties", () => {
    expect(css).toContain(".text-muted{color:var(--aw-color-text-muted)}");
    expect(css).toContain(".font-heading{font-family:var(--aw-font-heading)}");
    expect(css).toContain("--default-font-family:var(--aw-font-sans)");
  });

  it("detects a class that was built by string concatenation (RED proof)", () => {
    const shade = 700;
    expect(missingClasses(`<p class="text-red-${shade} text-muted"></p>`, css)).toEqual(["text-red-700"]);
  });

  it("does not accept a longer class as proof that a shorter one exists", () => {
    expect(hasClassSelector(css, "md:px-6")).toBe(true);
    expect(hasClassSelector(css, "md:px")).toBe(false);
  });
});
```


- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm build:css && pnpm vitest run packages/renderer/test/ui.test.ts`
Expected: the CSS build prints `≈ tailwindcss v4.3.3` and `Done in …ms`; the test FAILS with `Cannot find module '../src/ui.ts'`.

- [ ] **Step 4: Write the implementation and the licence notices**

`packages/renderer/src/ui.ts`:

```ts
// Shared building blocks ported from AstroWind (MIT, see THIRD_PARTY_NOTICES.md) at commit
// 14e1a69: src/components/ui/Headline.astro and WidgetWrapper.astro. Changes from the original:
// - tailwind-merge results are written out as literal class strings (no runtime merging);
// - set:html replaced by escaped text via the html template;
// - dark:, intersect-* and fade classes dropped (they only work with JavaScript);
// - leading-tighter (produces no CSS in Tailwind 4.3.3) replaced by leading-tight.
import { html, type SafeHtml, type Value } from "./html.ts";

export type ContainerWidth = "6xl" | "7xl";

const CONTAINER: Record<ContainerWidth, string> = {
  "7xl": "relative mx-auto max-w-7xl px-4 py-12 text-default md:px-6 md:py-16 lg:py-20",
  "6xl": "relative mx-auto max-w-6xl px-4 py-12 text-default md:px-6 md:py-16 lg:py-20",
};

/** Section heading block. The h2 id is `${domId}-title`, which sectionShell uses for aria-labelledby. */
export function headline(domId: string, title: Value, subtitle?: string): SafeHtml {
  return html`<div class="mb-8 max-w-3xl text-center md:mx-auto md:mb-12">
<h2 id="${domId}-title" class="font-heading text-3xl font-bold leading-tight tracking-tighter text-balance text-heading md:text-4xl">${title}</h2>
${subtitle && html`<p class="mt-4 text-xl text-pretty text-muted">${subtitle}</p>`}
</div>`;
}

/** A landmark section labelled by its headline, with AstroWind's container spacing. */
export function sectionShell(domId: string, width: ContainerWidth, content: SafeHtml): SafeHtml {
  return html`<section id="${domId}" aria-labelledby="${domId}-title">
<div class="${CONTAINER[width]}">
${content}
</div>
</section>`;
}
```

`THIRD_PARTY_NOTICES.md`:

````markdown
# Third-party notices

asksite includes code and assets adapted from the projects below. Each licence text is
copied from the project's own LICENSE file. Every rendered customer page also carries a one-line
HTML comment in its `<head>` with the AstroWind and Tabler Icons copyright notices
(`packages/renderer/src/render.ts`).

## AstroWind

- Source: https://github.com/arthelokyo/astrowind at commit 14e1a691f80548dcc36370847b1a02c0d0b12821
- Used in: `packages/renderer/src/ui.ts`, `packages/renderer/src/sections/{hero,services,gallery,testimonials,faq,contact,footer}.ts`
  and the button utilities in `packages/renderer/styles/input.css` (markup and class lists ported to TypeScript).

```
MIT License

Copyright (c) 2023 onWidget

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Tabler Icons

- Source: https://github.com/tabler/tabler-icons (version 3.48.0, SVG bodies taken from @iconify-json/tabler 1.2.40)
- Used in: `packages/renderer/src/icons.ts`

```
MIT License

Copyright (c) 2020-2026 Paweł Kuna

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Modern Font Stacks

- Source: https://github.com/system-fonts/modern-font-stacks
- Used in: the font stacks in `packages/renderer/src/theme.ts`
- Licence: CC0 1.0 Universal (public domain dedication; no attribution required, credited here anyway).
````


- [ ] **Step 5: Run the whole suite and the typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: `Test Files  13 passed (13)`, `Tests  221 passed (221)`; typecheck exits 0. `git status --short -- packages` does not list `styles/site.css` (it is ignored).

- [ ] **Step 6: Commit**

```bash
git add package.json packages/renderer/package.json pnpm-lock.yaml packages/renderer/styles/input.css packages/renderer/src/ui.ts THIRD_PARTY_NOTICES.md packages/renderer/test/support/css-classes.ts packages/renderer/test/ui.test.ts
git commit -m "Add stylesheet pipeline"
```

---
### Task 10: Render context, section visibility, header, footer and call bar

**Files:**
- Create: `packages/renderer/src/context.ts`, `packages/renderer/src/visibility.ts`, `packages/renderer/src/sections/ids.ts`, `packages/renderer/src/sections/header.ts`, `packages/renderer/src/sections/footer.ts`
- Test: `packages/renderer/test/support/doc.ts`, `packages/renderer/test/visibility.test.ts`, `packages/renderer/test/header-footer.test.ts`

**Interfaces:**
- Consumes: `html`, `fragment`, `safeUrl`, `SafeHtml`, `SafeUrl` (Task 5); `formatPhone`, `telUrl`, `mailtoUrl`, `TRADE_LABEL` (Task 8); `icon` (Task 8); `focus-outside:` variant (Task 9); `factSections`, `SiteDocument`, `LayoutSection`, `SectionId`, `SocialLink` from `@asksite/site-schema`.
- Produces: `interface RenderContext { readonly doc: SiteDocument; readonly sections: readonly LayoutSection[]; readonly formAction: SafeUrl }`, `isVisible(ctx: RenderContext, id: SectionId): boolean`; `hasContent(doc: SiteDocument, id: SectionId): boolean` (hero always; about/FAQ when their copy exists; every other section via `factSections` from Task 4), `visibleSections(doc: SiteDocument): LayoutSection[]`; `DOM_ID: Record<SectionId, string>` (`hero→top`, `trust→credentials`, `services`, `testimonials→reviews`, `gallery→our-work`, `about`, `serviceArea→service-area`, `faq`, `contact`), `NAV_LABEL: Partial<Record<SectionId, string>>`; `renderHeader(ctx): SafeHtml`, `renderFooter(ctx): SafeHtml` (column titles are `<h2>`; insured shows as "Insured"), `renderCallBar(ctx): SafeHtml` (`<aside aria-label="Call us">`, sticky except while focus is elsewhere). Test helpers: `FULL: SiteDocumentInput` (every optional field set), `MINIMAL: SiteDocumentInput` (only required fields), `makeContext(input: SiteDocumentInput): RenderContext`.
- Every `tel:` link carries `whitespace-nowrap` (html-validate's `tel-non-breaking` rule is configured to accept that in Task 15).

- [ ] **Step 1: Write the test documents and the failing tests**

`packages/renderer/test/support/doc.ts`:

```ts
import { SiteDocument, type SiteDocumentInput } from "@asksite/site-schema";
import type { RenderContext } from "../../src/context.ts";
import { safeUrl } from "../../src/html.ts";
import { visibleSections } from "../../src/visibility.ts";

/** A complete, valid plumber document with every optional fact filled in. */
export const FULL: SiteDocumentInput = {
  facts: {
    businessName: "Reliable Rooter",
    trade: "plumbing",
    phone: "+15125550142",
    email: "office@example.com",
    location: { streetAddress: "100 Congress Ave", city: "Austin", state: "TX", postalCode: "78701" },
    serviceArea: { places: ["Austin", "Round Rock", "78704"], note: "Within 25 miles of downtown Austin" },
    hours: [
      { days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], opens: "08:00", closes: "17:00" },
      { days: ["Saturday"], opens: "09:00", closes: "13:00" },
    ],
    services: [
      { name: "Drain cleaning", startingPrice: 89 },
      { name: "Water heaters", startingPrice: 1250 },
      { name: "Leak repair" },
    ],
    licences: [{ label: "Texas master plumber", number: "M-40123" }],
    insured: true,
    yearFounded: 1998,
    emergency247: true,
    freeEstimates: true,
    testimonials: [
      { quote: "Fixed our burst pipe the same night.", name: "Dana P.", location: "Round Rock, TX" },
      { quote: "Honest price and a tidy crew.", name: "Luis M." },
    ],
    heroPhoto: { url: "https://images.example.com/van.jpg", alt: "Our service van", width: 1600, height: 900 },
    photos: [
      { url: "https://images.example.com/p1.jpg", alt: "New water heater in a garage", width: 1200, height: 900, caption: "Water heater swap" },
      { url: "https://images.example.com/p2.jpg", alt: "Cleared kitchen drain", width: 1200, height: 900 },
    ],
    socialLinks: [{ network: "facebook", url: "https://www.facebook.com/reliablerooter" }],
  },
  copy: {
    heroHeadline: "Fast, friendly plumbing across Austin",
    heroSubheadline: "Leaks, clogs and water heaters fixed right the first time.",
    ctaText: "Get a free quote",
    about: "We are a family business that treats every home like our own.",
    sectionIntros: { services: "Everything from dripping taps to new water heaters.", faq: "Straight answers before you call." },
    serviceDescriptions: [
      { service: "Drain cleaning", description: "We clear stubborn drains without tearing up your yard." },
      { service: "Water heaters", description: "Tank and tankless units installed the same week." },
      { service: "Leak repair", description: "We find hidden leaks before they ruin your floors." },
    ],
    faq: [
      { question: "Do you charge for estimates?", answer: "No. Estimates are always free." },
      { question: "Can you come out for an emergency?", answer: "Yes, we answer emergencies around the clock." },
    ],
  },
  layout: [
    { id: "hero", variant: "photo" },
    { id: "trust", variant: "band" },
    { id: "services", variant: "cards" },
    { id: "testimonials", variant: "grid" },
    { id: "gallery", variant: "grid" },
    { id: "about", variant: "plain" },
    { id: "serviceArea", variant: "split" },
    { id: "faq", variant: "accordion" },
    { id: "contact", variant: "card" },
  ],
  theme: { palette: "navy-orange", font: "clean" },
};

/** FULL with every optional fact and copy field removed. */
export const MINIMAL: SiteDocumentInput = {
  facts: {
    businessName: "Mop",
    trade: "cleaning",
    phone: "+15125550199",
    email: "hi@example.com",
    location: { city: "Austin", state: "TX" },
    serviceArea: { places: ["Austin"] },
    services: [{ name: "House cleaning" }],
  },
  copy: {
    heroHeadline: "A spotless home",
    heroSubheadline: "Careful cleaners for busy households.",
    ctaText: "Book a clean",
    serviceDescriptions: [{ service: "House cleaning", description: "Weekly or one-off cleans." }],
  },
  layout: FULL.layout,
  theme: { palette: "green-amber", font: "friendly" },
};

export function makeContext(input: SiteDocumentInput): RenderContext {
  const doc = SiteDocument.parse(input);
  return { doc, sections: visibleSections(doc), formAction: safeUrl("https://forms.example.com/submit") };
}
```

`packages/renderer/test/visibility.test.ts`:

```ts
import { SiteDocument } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { visibleSections } from "../src/visibility.ts";
import { FULL, MINIMAL } from "./support/doc.ts";

describe("visibleSections", () => {
  it("keeps every section that has content, in layout order", () => {
    expect(visibleSections(SiteDocument.parse(FULL)).map((s) => s.id)).toEqual([
      "hero",
      "trust",
      "services",
      "testimonials",
      "gallery",
      "about",
      "serviceArea",
      "faq",
      "contact",
    ]);
  });

  it("hides sections whose optional facts or copy are missing", () => {
    expect(visibleSections(SiteDocument.parse(MINIMAL)).map((s) => s.id)).toEqual([
      "hero",
      "services",
      "serviceArea",
      "contact",
    ]);
  });

  it("shows the trust strip for any single credential", () => {
    const withInsured = { ...MINIMAL, facts: { ...MINIMAL.facts, insured: true } };
    expect(visibleSections(SiteDocument.parse(withInsured)).map((s) => s.id)).toContain("trust");
  });
});
```

`packages/renderer/test/header-footer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderHeader } from "../src/sections/header.ts";
import { renderCallBar, renderFooter } from "../src/sections/footer.ts";
import { FULL, makeContext, MINIMAL } from "./support/doc.ts";

describe("header", () => {
  const out = String(renderHeader(makeContext(FULL)));

  it("shows the business name and a tel: link from facts", () => {
    expect(out).toContain(">Reliable Rooter</a>");
    expect(out).toContain('href="tel:+15125550142" aria-label="Call (512) 555-0142"');
  });

  it("links only to visible sections, in page order", () => {
    const hrefs = [...out.matchAll(/<li><a class="inline-flex[^"]*" href="(#[a-z-]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(["#services", "#reviews", "#our-work", "#about", "#service-area", "#faq", "#contact"]);
    const minimal = String(renderHeader(makeContext(MINIMAL)));
    const minimalHrefs = [...minimal.matchAll(/<li><a class="inline-flex[^"]*" href="(#[a-z-]+)"/g)].map((m) => m[1]);
    expect(minimalHrefs).toEqual(["#services", "#service-area", "#contact"]);
  });

  it("uses a native <details> menu, not JavaScript", () => {
    expect(out).toContain('<details class="group relative lg:hidden">');
    expect(out).toContain('<span class="sr-only">Menu</span>');
    expect(out).not.toContain("<script");
    expect(out).not.toMatch(/\son[a-z]+=/);
  });
});

describe("footer", () => {
  it("repeats contact details and credentials from facts", () => {
    const out = String(renderFooter(makeContext(FULL)));
    expect(out).toContain(">(512) 555-0142</a>");
    expect(out).toContain('href="mailto:office@example.com"');
    expect(out).toContain("100 Congress Ave, Austin, TX 78701");
    expect(out).toContain("Texas master plumber: M-40123");
    expect(out).toContain('<li class="mb-2">Insured</li>');
    expect(out).toContain('href="https://www.facebook.com/reliablerooter">Facebook</a>');
  });

  it("marks the column titles up as headings", () => {
    const out = String(renderFooter(makeContext(FULL)));
    expect(out).toContain('<h2 class="mb-2 font-medium text-heading">Contact</h2>');
    expect(out).toContain('<h2 class="mb-2 font-medium text-heading">Credentials</h2>');
  });

  it("omits credentials, street address and social links when the owner gave none", () => {
    const out = String(renderFooter(makeContext(MINIMAL)));
    expect(out).not.toContain("Credentials");
    expect(out).not.toContain("Insured");
    expect(out).not.toContain("border-t border-gray-200 py-6");
    expect(out).toContain("Cleaning · Austin, TX");
  });
});

describe("call bar", () => {
  it("is a phone-only sticky tel: button in its own landmark", () => {
    const out = String(renderCallBar(makeContext(FULL)));
    expect(out).toMatch(/^<aside aria-label="Call us" class="sticky bottom-0 /);
    expect(out).toContain("sticky bottom-0");
    expect(out).toContain("md:hidden");
    expect(out).toContain("focus-outside:static");
    expect(out).toContain('href="tel:+15125550142"');
    expect(out).toContain("Call (512) 555-0142</a>");
  });
});
```


- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run packages/renderer/test/visibility.test.ts packages/renderer/test/header-footer.test.ts`
Expected: FAIL — `Cannot find module '../src/visibility.ts'` and `Cannot find module '../src/sections/header.ts'`.

- [ ] **Step 3: Write the implementation**

`packages/renderer/src/context.ts`:

```ts
import type { LayoutSection, SectionId, SiteDocument } from "@asksite/site-schema";
import type { SafeUrl } from "./html.ts";

/** Everything a section needs. Built once per render by render.ts. */
export interface RenderContext {
  readonly doc: SiteDocument;
  /** Sections that will actually render, in page order (layout minus sections with no content). */
  readonly sections: readonly LayoutSection[];
  readonly formAction: SafeUrl;
}

export function isVisible(ctx: RenderContext, id: SectionId): boolean {
  return ctx.sections.some((s) => s.id === id);
}
```

`packages/renderer/src/visibility.ts`:

```ts
import { factSections, type LayoutSection, type SectionId, type SiteDocument } from "@asksite/site-schema";

/** A section with no owner facts or copy to show is left out instead of rendering empty. */
export function hasContent(doc: SiteDocument, id: SectionId): boolean {
  switch (id) {
    case "hero":
      return true;
    case "about":
      return doc.copy.about !== undefined;
    case "faq":
      return doc.copy.faq.length > 0;
    default:
      return factSections(doc.facts).includes(id);
  }
}

export function visibleSections(doc: SiteDocument): LayoutSection[] {
  return doc.layout.filter((section) => hasContent(doc, section.id));
}
```

`packages/renderer/src/sections/ids.ts`:

```ts
import type { SectionId } from "@asksite/site-schema";

/** Element id of each section, used for in-page links and aria-labelledby. */
export const DOM_ID: Record<SectionId, string> = {
  hero: "top",
  trust: "credentials",
  services: "services",
  testimonials: "reviews",
  gallery: "our-work",
  about: "about",
  serviceArea: "service-area",
  faq: "faq",
  contact: "contact",
};

/** Header navigation label; sections without one are not linked from the menu. */
export const NAV_LABEL: Partial<Record<SectionId, string>> = {
  services: "Services",
  testimonials: "Reviews",
  gallery: "Our work",
  about: "About",
  serviceArea: "Service area",
  faq: "FAQ",
  contact: "Contact",
};
```

`packages/renderer/src/sections/header.ts`:

```ts
// Our own header (AstroWind's Header.astro is 309 lines of features we do not need).
// Zero JavaScript: the phone menu is a native <details> disclosure.
import type { RenderContext } from "../context.ts";
import { formatPhone, telUrl } from "../format.ts";
import { fragment, html, type SafeHtml } from "../html.ts";
import { icon } from "../icons.ts";
import { DOM_ID, NAV_LABEL } from "./ids.ts";

export function renderHeader(ctx: RenderContext): SafeHtml {
  const { facts } = ctx.doc;
  const phone = formatPhone(facts.phone);
  const links = ctx.sections.flatMap((section) => {
    const label = NAV_LABEL[section.id];
    return label ? [{ href: fragment(DOM_ID[section.id]), label }] : [];
  });

  return html`<header class="border-b border-gray-200 bg-page">
<div class="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:px-6">
<a class="mr-auto min-w-0 font-heading text-lg font-bold leading-tight text-heading sm:text-xl" href="${fragment(DOM_ID.hero)}">${facts.businessName}</a>
${links.length > 0 && html`<nav aria-label="Main" class="order-last lg:order-none">
<ul class="hidden items-center gap-1 lg:flex">
${links.map((l) => html`<li><a class="inline-flex min-h-11 items-center rounded-md px-3 font-medium text-default hover:text-primary" href="${l.href}">${l.label}</a></li>`)}
</ul>
<details class="group relative lg:hidden">
<summary class="flex h-11 w-11 cursor-pointer list-none items-center justify-center rounded-md text-heading hover:bg-gray-100 [&::-webkit-details-marker]:hidden">
<span class="sr-only">Menu</span>
${icon("menu-2", "h-6 w-6 group-open:hidden")}
${icon("x", "hidden h-6 w-6 group-open:block")}
</summary>
<ul class="absolute right-0 z-20 mt-2 w-60 rounded-lg border border-gray-200 bg-page p-2 shadow-lg">
${links.map((l) => html`<li><a class="flex min-h-11 items-center rounded-md px-3 font-medium text-default hover:bg-gray-100" href="${l.href}">${l.label}</a></li>`)}
</ul>
</details>
</nav>`}
<a class="btn-primary shrink-0 whitespace-nowrap" href="${telUrl(facts.phone)}" aria-label="Call ${phone}">${icon("phone", "h-5 w-5")}<span class="sm:hidden">Call</span><span class="hidden sm:inline">${phone}</span></a>
</div>
</header>`;
}
```

`packages/renderer/src/sections/footer.ts`:

```ts
// Ported from AstroWind (MIT, see THIRD_PARTY_NOTICES.md) src/components/widgets/Footer.astro
// at commit 14e1a69. Changes: the astrowind:config coupling (SITE.name, getHomePermalink) is
// replaced by owner facts; link columns are replaced by contact details and credentials
// (licence numbers repeated here because several states require them in all advertising);
// social links are text links; column titles are real <h2> headings; dark:, intersect-* and
// fade classes dropped.
import type { SocialLink } from "@asksite/site-schema";
import type { RenderContext } from "../context.ts";
import { formatPhone, mailtoUrl, telUrl, TRADE_LABEL } from "../format.ts";
import { html, safeUrl, type SafeHtml } from "../html.ts";
import { icon } from "../icons.ts";

const SOCIAL_LABEL: Record<SocialLink["network"], string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  google: "Google",
  yelp: "Yelp",
  nextdoor: "Nextdoor",
  youtube: "YouTube",
  linkedin: "LinkedIn",
};

export function renderFooter(ctx: RenderContext): SafeHtml {
  const { facts } = ctx.doc;
  const { location } = facts;
  const hasCredentials = facts.licences.length > 0 || facts.insured;

  return html`<footer class="border-t border-gray-200">
<div class="mx-auto max-w-7xl px-4 sm:px-6">
<div class="grid grid-cols-12 gap-4 gap-y-8 py-8 sm:gap-8 md:py-12">
<div class="col-span-12 lg:col-span-4">
<p class="mb-2 font-heading text-xl font-bold text-heading">${facts.businessName}</p>
<p class="text-sm text-muted">${TRADE_LABEL[facts.trade]} · ${location.city}, ${location.state}</p>
</div>
<div class="col-span-12 sm:col-span-6 lg:col-span-4">
<h2 class="mb-2 font-medium text-heading">Contact</h2>
<ul class="text-sm">
<li class="mb-2"><a class="inline-block whitespace-nowrap py-1 text-muted hover:text-heading hover:underline" href="${telUrl(facts.phone)}">${formatPhone(facts.phone)}</a></li>
<li class="mb-2"><a class="inline-block break-all py-1 text-muted hover:text-heading hover:underline" href="${mailtoUrl(facts.email)}">${facts.email}</a></li>
${location.streetAddress && html`<li class="mb-2 text-muted">${location.streetAddress}, ${location.city}, ${location.state}${location.postalCode && html` ${location.postalCode}`}</li>`}
</ul>
</div>
${hasCredentials && html`<div class="col-span-12 sm:col-span-6 lg:col-span-4">
<h2 class="mb-2 font-medium text-heading">Credentials</h2>
<ul class="text-sm text-muted">
${facts.licences.map((l) => html`<li class="mb-2">${l.label}: ${l.number}</li>`)}
${facts.insured && html`<li class="mb-2">Insured</li>`}
</ul>
</div>`}
</div>
${facts.socialLinks.length > 0 && html`<div class="border-t border-gray-200 py-6 md:py-8">
<ul class="flex flex-wrap gap-x-6 gap-y-2 text-sm">
${facts.socialLinks.map((s) => html`<li><a class="inline-block py-1 text-muted hover:text-heading hover:underline" href="${safeUrl(s.url, ["https:"])}">${SOCIAL_LABEL[s.network]}</a></li>`)}
</ul>
</div>`}
</div>
</footer>`;
}

/**
 * Phone-only call bar that stays at the bottom of the screen. position: sticky needs no JavaScript.
 * An <aside> landmark, so screen-reader users can find it and no content sits outside a landmark.
 * It stops sticking while keyboard focus is elsewhere, so it never hides the focused element.
 */
export function renderCallBar(ctx: RenderContext): SafeHtml {
  const { phone } = ctx.doc.facts;
  return html`<aside aria-label="Call us" class="sticky bottom-0 z-10 border-t border-gray-200 bg-page px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] focus-outside:static md:hidden">
<a class="btn-primary w-full whitespace-nowrap" href="${telUrl(phone)}">${icon("phone", "h-5 w-5")}Call ${formatPhone(phone)}</a>
</aside>`;
}
```


- [ ] **Step 4: Run the whole suite and the typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: `Test Files  15 passed (15)`, `Tests  231 passed (231)`; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/renderer/src/context.ts packages/renderer/src/visibility.ts packages/renderer/src/sections/ids.ts packages/renderer/src/sections/header.ts packages/renderer/src/sections/footer.ts packages/renderer/test/support/doc.ts packages/renderer/test/visibility.test.ts packages/renderer/test/header-footer.test.ts
git commit -m "Add header footer"
```

---
### Task 11: Hero and trust strip

**Files:**
- Create: `packages/renderer/src/sections/hero.ts`, `packages/renderer/src/sections/trust.ts`
- Test: `packages/renderer/test/hero-trust.test.ts`

**Interfaces:**
- Consumes: `RenderContext`, `isVisible` (Task 10); `DOM_ID` (Task 10); `html`, `fragment`, `safeUrl` (Task 5); `formatPhone`, `telUrl`, `TRADE_LABEL`, `icon`, `type IconName` (Task 8); `type VariantOf` from `@asksite/site-schema`; test helpers `FULL`, `MINIMAL`, `makeContext` (Task 10).
- Produces: `renderHero(ctx: RenderContext, variant: VariantOf<"hero">): SafeHtml` (the page's only `<h1>`, id `top-title`; the "photo" variant falls back to text-only when `facts.heroPhoto` is absent; the quote button shows only when the contact section renders); `renderTrust(ctx: RenderContext, variant: VariantOf<"trust">): SafeHtml` (licences as entered, "Insured", "In business since …", "24/7 emergency service").

- [ ] **Step 1: Write the failing test**

`packages/renderer/test/hero-trust.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderHero } from "../src/sections/hero.ts";
import { renderTrust } from "../src/sections/trust.ts";
import { FULL, makeContext, MINIMAL } from "./support/doc.ts";

describe("hero", () => {
  const full = makeContext(FULL);

  it("builds the tagline and badge from facts, and the h1 from copy", () => {
    const out = String(renderHero(full, "photo"));
    expect(out).toContain(">Plumbing · Austin, TX · Since 1998</p>");
    expect(out).toContain(">24/7 emergency service</p>");
    expect(out).toContain(">Fast, friendly plumbing across Austin</h1>");
    expect(out.match(/<h1/g)).toHaveLength(1);
  });

  it("offers a call button from facts and a quote button to #contact", () => {
    const out = String(renderHero(full, "centered"));
    expect(out).toContain('href="tel:+15125550142"');
    expect(out).toContain("Call (512) 555-0142</a>");
    expect(out).toContain('href="#contact">Get a free quote</a>');
  });

  it("drops the quote button when there is no contact section", () => {
    const noContact = { ...full, sections: full.sections.filter((s) => s.id !== "contact") };
    expect(String(renderHero(noContact, "centered"))).not.toContain('href="#contact"');
  });

  it("shows the hero photo only in the photo variant", () => {
    expect(String(renderHero(full, "photo"))).toContain(
      'src="https://images.example.com/van.jpg" width="1600" height="900" alt="Our service van"',
    );
    expect(String(renderHero(full, "centered"))).not.toContain("<img");
  });

  it("falls back to text only when the photo variant has no photo", () => {
    const out = String(renderHero(makeContext(MINIMAL), "photo"));
    expect(out).not.toContain("<img");
    expect(out).not.toContain("emergency");
    expect(out).toContain(">Cleaning · Austin, TX</p>");
  });
});

describe("trust strip", () => {
  it("lists only owner facts, licences exactly as entered", () => {
    const out = String(renderTrust(makeContext(FULL), "band"));
    expect(out).toContain(">Texas master plumber: M-40123</span>");
    expect(out).toContain(">Insured</span>");
    expect(out).toContain(">In business since 1998</span>");
    expect(out).toContain(">24/7 emergency service</span>");
    expect(out).toContain('class="bg-dark text-white"');
    expect(out).not.toMatch(/bonded/i);
  });

  it("has a light variant", () => {
    expect(String(renderTrust(makeContext(FULL), "light"))).toContain('class="border-y border-gray-200 bg-page text-heading"');
  });

  it("shows a single item when only one credential exists", () => {
    const ctx = makeContext({ ...MINIMAL, facts: { ...MINIMAL.facts, insured: true } });
    expect(String(renderTrust(ctx, "band")).match(/<li /g)).toHaveLength(1);
  });
});
```


- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/renderer/test/hero-trust.test.ts`
Expected: FAIL — `Cannot find module '../src/sections/hero.ts'`.

- [ ] **Step 3: Write the implementation**

`packages/renderer/src/sections/hero.ts`:

```ts
// Ported from AstroWind (MIT, see THIRD_PARTY_NOTICES.md) src/components/widgets/Hero.astro
// at commit 14e1a69. Changes: the 76px fixed-header offsets are removed (our header is not
// fixed); the badge and tagline are built from owner facts; actions are capped at a call
// button plus one quote button; the image is a plain <img> (no Astro image pipeline);
// set:html, dark:, intersect-* and fade classes removed; text-balance added to the h1.
import type { VariantOf } from "@asksite/site-schema";
import { isVisible, type RenderContext } from "../context.ts";
import { formatPhone, telUrl, TRADE_LABEL } from "../format.ts";
import { fragment, html, safeUrl, type SafeHtml } from "../html.ts";
import { icon } from "../icons.ts";
import { DOM_ID } from "./ids.ts";

const TEXT_BLOCK = {
  withPhoto: "mx-auto max-w-5xl pb-10 text-center md:pb-16",
  textOnly: "mx-auto max-w-5xl text-center",
} as const;

export function renderHero(ctx: RenderContext, variant: VariantOf<"hero">): SafeHtml {
  const { facts, copy } = ctx.doc;
  const photo = variant === "photo" ? facts.heroPhoto : undefined;
  const tagline = [
    TRADE_LABEL[facts.trade],
    `${facts.location.city}, ${facts.location.state}`,
    facts.yearFounded === undefined ? undefined : `Since ${facts.yearFounded}`,
  ]
    .filter((part) => part !== undefined)
    .join(" · ");

  return html`<section id="${DOM_ID.hero}" aria-labelledby="${DOM_ID.hero}-title">
<div class="mx-auto max-w-7xl px-4 sm:px-6">
<div class="py-12 md:py-20">
<div class="${photo ? TEXT_BLOCK.withPhoto : TEXT_BLOCK.textOnly}">
${facts.emergency247 && html`<p class="mb-4 inline-block rounded-full bg-accent px-3 py-1 text-xs font-semibold tracking-wide text-heading uppercase">24/7 emergency service</p>`}
<p class="text-base font-bold tracking-wide text-secondary uppercase">${tagline}</p>
<h1 id="${DOM_ID.hero}-title" class="mb-4 font-heading text-4xl font-bold leading-tight tracking-tighter text-balance text-heading sm:text-5xl md:text-6xl">${copy.heroHeadline}</h1>
<div class="mx-auto max-w-3xl">
<p class="mb-6 text-xl text-pretty text-muted">${copy.heroSubheadline}</p>
<div class="m-auto flex max-w-xs flex-col flex-nowrap gap-4 sm:max-w-2xl sm:flex-row sm:justify-center">
<div class="flex w-full sm:w-auto"><a class="btn-primary w-full whitespace-nowrap" href="${telUrl(facts.phone)}">${icon("phone", "h-5 w-5")}Call ${formatPhone(facts.phone)}</a></div>
${isVisible(ctx, "contact") && html`<div class="flex w-full sm:w-auto"><a class="btn-secondary w-full" href="${fragment(DOM_ID.contact)}">${copy.ctaText}</a></div>`}
</div>
</div>
</div>
${photo && html`<div class="relative m-auto max-w-5xl">
<img class="mx-auto aspect-video w-full rounded-md object-cover" src="${safeUrl(photo.url, ["https:"])}" width="${photo.width}" height="${photo.height}" alt="${photo.alt}" loading="eager" fetchpriority="high" decoding="async">
</div>`}
</div>
</div>
</section>`;
}
```

`packages/renderer/src/sections/trust.ts`:

```ts
// Trust strip (new; AstroWind has no credentials section). Every item is an owner fact:
// licence numbers exactly as entered, insured flag ("Insured", not "Fully insured": the owner
// only ticked a box), founding year and 24/7 flag. There is deliberately no "bonded" item:
// California B&P Code 7071.13 forbids referring to the contractor bond in advertising.
import type { VariantOf } from "@asksite/site-schema";
import type { RenderContext } from "../context.ts";
import { html, type SafeHtml } from "../html.ts";
import { icon, type IconName } from "../icons.ts";
import { DOM_ID } from "./ids.ts";

const STYLE: Record<VariantOf<"trust">, { section: string; icon: string }> = {
  band: { section: "bg-dark text-white", icon: "h-6 w-6 shrink-0" },
  light: { section: "border-y border-gray-200 bg-page text-heading", icon: "h-6 w-6 shrink-0 text-primary" },
};

export function renderTrust(ctx: RenderContext, variant: VariantOf<"trust">): SafeHtml {
  const { facts } = ctx.doc;
  const items: Array<[IconName, string]> = facts.licences.map((l) => ["certificate", `${l.label}: ${l.number}`]);
  if (facts.insured) items.push(["shield-check", "Insured"]);
  if (facts.yearFounded !== undefined) items.push(["circle-check", `In business since ${facts.yearFounded}`]);
  if (facts.emergency247) items.push(["clock", "24/7 emergency service"]);
  const style = STYLE[variant];

  return html`<section id="${DOM_ID.trust}" aria-label="Credentials" class="${style.section}">
<div class="mx-auto max-w-7xl px-4 py-6 md:px-6">
<ul class="flex flex-wrap items-center justify-center gap-x-8 gap-y-3 font-semibold">
${items.map(([name, text]) => html`<li class="flex min-w-0 items-center gap-2">${icon(name, style.icon)}<span class="min-w-0">${text}</span></li>`)}
</ul>
</div>
</section>`;
}
```


- [ ] **Step 4: Run the whole suite and the typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: `Test Files  16 passed (16)`, `Tests  239 passed (239)`; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/renderer/src/sections/hero.ts packages/renderer/src/sections/trust.ts packages/renderer/test/hero-trust.test.ts
git commit -m "Add hero trust"
```

---
### Task 12: Services, testimonials and gallery

**Files:**
- Create: `packages/renderer/src/sections/services.ts`, `packages/renderer/src/sections/testimonials.ts`, `packages/renderer/src/sections/gallery.ts`
- Test: `packages/renderer/test/services-reviews-gallery.test.ts`

**Interfaces:**
- Consumes: `RenderContext` (Task 10), `DOM_ID` (Task 10), `headline`, `sectionShell` (Task 9), `html`, `safeUrl` (Task 5), `formatPrice`, `icon` (Task 8); test helpers (Task 10).
- Produces: `renderServices(ctx, variant: VariantOf<"services">): SafeHtml` (name and price from facts, `description` from the matching `copy.serviceDescriptions` entry), `renderTestimonials(ctx, variant: VariantOf<"testimonials">): SafeHtml` (fixed heading, no AI subtitle), `renderGallery(ctx, variant: VariantOf<"gallery">): SafeHtml`. Grid classes come from lookup tables keyed by item count (1 / 2 or 4 / many), and every grid has an explicit `grid-cols-1` base so a long word cannot widen the track.

- [ ] **Step 1: Write the failing test**

`packages/renderer/test/services-reviews-gallery.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderGallery } from "../src/sections/gallery.ts";
import { renderServices } from "../src/sections/services.ts";
import { renderTestimonials } from "../src/sections/testimonials.ts";
import { FULL, makeContext, MINIMAL } from "./support/doc.ts";

const services = (count: number) => Array.from({ length: count }, (_, i) => ({ name: `Service ${String.fromCharCode(65 + i)}` }));
const withServices = (count: number) =>
  makeContext({
    ...FULL,
    facts: { ...FULL.facts, services: services(count) },
    copy: { ...FULL.copy, serviceDescriptions: services(count).map((s) => ({ service: s.name, description: "A careful job." })) },
  });

describe("services", () => {
  it("takes names and prices from facts and descriptions from copy", () => {
    const out = String(renderServices(makeContext(FULL), "cards"));
    expect(out).toContain(">Drain cleaning</h3>");
    expect(out).toContain(">From $89</p>");
    expect(out).toContain(">From $1,250</p>");
    expect(out).toContain(">We clear stubborn drains without tearing up your yard.</p>");
    expect(out.match(/From \$/g)).toHaveLength(2);
    expect(out).toContain('<h2 id="services-title"');
    expect(out).toContain(">Everything from dripping taps to new water heaters.</p>");
  });

  it.each([
    [1, "mx-auto grid max-w-xl grid-cols-1 gap-6"],
    [2, "grid grid-cols-1 gap-6 sm:grid-cols-2"],
    [3, "grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3"],
    [4, "grid grid-cols-1 gap-6 sm:grid-cols-2"],
    [12, "grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3"],
  ])("lays out %i services with %j", (count, grid) => {
    const out = String(renderServices(withServices(count), "cards"));
    expect(out).toContain(`<ul class="${grid}">`);
    expect(out.match(/<li /g)).toHaveLength(count);
  });

  it("has a compact two-column list variant", () => {
    const out = String(renderServices(withServices(12), "compact"));
    expect(out).toContain('<ul class="mx-auto grid max-w-5xl grid-cols-1 gap-x-12 gap-y-8 sm:grid-cols-2">');
    expect(out.match(/<h3 /g)).toHaveLength(12);
  });
});

describe("testimonials", () => {
  it("renders owner quotes with names as escaped text, under a heading with no AI subtitle", () => {
    const out = String(renderTestimonials(makeContext(FULL), "grid"));
    expect(out).toContain(">What customers say</h2>\n\n</div>");
    expect(out).toContain(">Fixed our burst pipe the same night.</p></blockquote>");
    expect(out).toContain(">Dana P.</p>");
    expect(out).toContain(">Round Rock, TX</p>");
    expect(out).toContain('<ul class="grid grid-cols-1 gap-6 sm:grid-cols-2">');
  });

  it("uses CSS columns for the masonry variant once there are 3+ reviews", () => {
    const three = [
      { quote: "Fixed our burst pipe the same night.", name: "Dana P." },
      { quote: "Honest price and a tidy crew.", name: "Luis M." },
      { quote: "Great.", name: "Kim" },
    ];
    const out = String(renderTestimonials(makeContext({ ...FULL, facts: { ...FULL.facts, testimonials: three } }), "masonry"));
    expect(out).toContain('<ul class="columns-1 gap-6 sm:columns-2 lg:columns-3">');
    expect(out).toContain('<li class="mb-6 flex break-inside-avoid">');
  });
});

describe("gallery", () => {
  it("is a zero-JS grid of lazy-loaded owner photos", () => {
    const out = String(renderGallery(makeContext(FULL), "grid"));
    expect(out).toContain('src="https://images.example.com/p1.jpg" width="1200" height="900" alt="New water heater in a garage" loading="lazy"');
    expect(out).toContain(">Water heater swap</figcaption>");
    expect(out.match(/<figcaption/g)).toHaveLength(1);
    for (const forbidden of ["<script", "<dialog", "<button", "aw-gallery"]) expect(out).not.toContain(forbidden);
  });

  it("adapts the grid to one photo", () => {
    const photo = { url: "https://images.example.com/one.jpg", alt: "Finished patio", width: 1200, height: 900 };
    const one = makeContext({ ...MINIMAL, facts: { ...MINIMAL.facts, photos: [photo] } });
    expect(String(renderGallery(one, "grid"))).toContain('<ul class="mx-auto grid max-w-3xl grid-cols-1 gap-4">');
  });
});
```


- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/renderer/test/services-reviews-gallery.test.ts`
Expected: FAIL — `Cannot find module '../src/sections/gallery.ts'`.

- [ ] **Step 3: Write the implementation**

`packages/renderer/src/sections/services.ts`:

```ts
// Ported from AstroWind (MIT, see THIRD_PARTY_NOTICES.md) src/components/widgets/Features2.astro
// at commit 14e1a69. Changes: service names and prices come from owner facts, descriptions from
// copy; the column count follows the number of services (lookup table, whole class strings);
// the invisible white border and no-op backdrop-blur are replaced by a visible gray border;
// a compact list variant is added for long service lists; dark:, intersect-* and fade removed.
import type { VariantOf } from "@asksite/site-schema";
import type { RenderContext } from "../context.ts";
import { formatPrice } from "../format.ts";
import { html, type SafeHtml } from "../html.ts";
import { icon } from "../icons.ts";
import { headline, sectionShell } from "../ui.ts";
import { DOM_ID } from "./ids.ts";

const CARD_GRID = {
  one: "mx-auto grid max-w-xl grid-cols-1 gap-6",
  two: "grid grid-cols-1 gap-6 sm:grid-cols-2",
  many: "grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3",
} as const;

function cardGrid(count: number): string {
  if (count === 1) return CARD_GRID.one;
  if (count === 2 || count === 4) return CARD_GRID.two;
  return CARD_GRID.many;
}

export function renderServices(ctx: RenderContext, variant: VariantOf<"services">): SafeHtml {
  const { facts, copy } = ctx.doc;
  // SiteDocument guarantees serviceDescriptions[i] names facts.services[i].
  const items = facts.services.map((service, i) => ({ ...service, description: copy.serviceDescriptions[i]?.description }));
  const price = (dollars: number | undefined) =>
    dollars !== undefined && html`<p class="mt-1 font-semibold text-primary">From ${formatPrice(dollars)}</p>`;

  const list =
    variant === "cards"
      ? html`<ul class="${cardGrid(items.length)}">
${items.map((s) => html`<li class="flex flex-col rounded-lg border border-gray-200 bg-white p-6 shadow-[0_4px_30px_rgba(0,0,0,0.1)]">
${icon("circle-check", "mb-4 h-10 w-10 text-primary")}
<h3 class="text-xl font-bold text-heading">${s.name}</h3>
${price(s.startingPrice)}
${s.description && html`<p class="mt-2 text-pretty text-muted">${s.description}</p>`}
</li>`)}
</ul>`
      : html`<ul class="mx-auto grid max-w-5xl grid-cols-1 gap-x-12 gap-y-8 sm:grid-cols-2">
${items.map((s) => html`<li class="flex gap-4">
${icon("check", "mt-1 h-6 w-6 shrink-0 text-primary")}
<div class="min-w-0">
<h3 class="text-lg font-bold text-heading">${s.name}</h3>
${price(s.startingPrice)}
${s.description && html`<p class="mt-1 text-pretty text-muted">${s.description}</p>`}
</div>
</li>`)}
</ul>`;

  return sectionShell(DOM_ID.services, "7xl", html`${headline(DOM_ID.services, "Our services", copy.sectionIntros.services)}
${list}`);
}
```

`packages/renderer/src/sections/testimonials.ts`:

```ts
// Ported from AstroWind (MIT, see THIRD_PARTY_NOTICES.md) src/components/widgets/Testimonials.astro
// at commit 14e1a69. Changes: quotes are owner-pasted facts (never AI) shown as escaped text in
// <figure>/<blockquote>/<figcaption> under a fixed heading with no AI subtitle, so AI prose never
// frames real reviews; star ratings, logos, avatars and call-to-action dropped;
// one or two reviews use a narrower grid instead of leaving empty columns; dark:, intersect-*
// and fade classes removed.
import type { VariantOf } from "@asksite/site-schema";
import type { RenderContext } from "../context.ts";
import { html, type SafeHtml } from "../html.ts";
import { headline, sectionShell } from "../ui.ts";
import { DOM_ID } from "./ids.ts";

const LAYOUT = {
  one: { list: "mx-auto grid max-w-xl grid-cols-1 gap-6", item: "flex" },
  two: { list: "grid grid-cols-1 gap-6 sm:grid-cols-2", item: "flex" },
  grid: { list: "grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3", item: "flex" },
  masonry: { list: "columns-1 gap-6 sm:columns-2 lg:columns-3", item: "mb-6 flex break-inside-avoid" },
} as const;

export function renderTestimonials(ctx: RenderContext, variant: VariantOf<"testimonials">): SafeHtml {
  const { facts } = ctx.doc;
  const count = facts.testimonials.length;
  const layout = count === 1 ? LAYOUT.one : count === 2 ? LAYOUT.two : LAYOUT[variant];

  return sectionShell(DOM_ID.testimonials, "6xl", html`${headline(DOM_ID.testimonials, "What customers say")}
<ul class="${layout.list}">
${facts.testimonials.map((t) => html`<li class="${layout.item}">
<figure class="flex w-full flex-col rounded-md bg-white p-4 shadow-xl md:p-6">
<blockquote class="flex-auto"><p class="text-muted before:content-['“'] after:content-['”']">${t.quote}</p></blockquote>
<hr class="my-4 border-slate-200">
<figcaption>
<p class="font-semibold text-heading">${t.name}</p>
${t.location && html`<p class="text-sm text-muted">${t.location}</p>`}
</figcaption>
</figure>
</li>`)}
</ul>`);
}
```

`packages/renderer/src/sections/gallery.ts`:

```ts
// Ported from AstroWind (MIT, see THIRD_PARTY_NOTICES.md) src/components/widgets/Gallery.astro
// at commit 14e1a69. The JavaScript lightbox (<aw-gallery>, <dialog>, <script>) is NOT ported:
// this is a plain zero-JS grid of owner photos with lazy loading and optional captions.
// Column count follows the number of photos (lookup table, whole class strings).
import type { VariantOf } from "@asksite/site-schema";
import type { RenderContext } from "../context.ts";
import { html, safeUrl, type SafeHtml } from "../html.ts";
import { headline, sectionShell } from "../ui.ts";
import { DOM_ID } from "./ids.ts";

const GRID = {
  one: "mx-auto grid max-w-3xl grid-cols-1 gap-4",
  two: "grid grid-cols-1 gap-4 sm:grid-cols-2 md:gap-6",
  many: "grid grid-cols-1 gap-4 sm:grid-cols-2 md:gap-6 lg:grid-cols-3",
} as const;

export function renderGallery(ctx: RenderContext, _variant: VariantOf<"gallery">): SafeHtml {
  const { facts, copy } = ctx.doc;
  const count = facts.photos.length;
  const grid = count === 1 ? GRID.one : count === 2 || count === 4 ? GRID.two : GRID.many;

  return sectionShell(DOM_ID.gallery, "6xl", html`${headline(DOM_ID.gallery, "Our work", copy.sectionIntros.gallery)}
<ul class="${grid}">
${facts.photos.map((p) => html`<li>
<figure>
<img class="aspect-[4/3] w-full rounded-lg bg-gray-100 object-cover" src="${safeUrl(p.url, ["https:"])}" width="${p.width}" height="${p.height}" alt="${p.alt}" loading="lazy" decoding="async">
${p.caption && html`<figcaption class="mt-2 text-sm text-muted">${p.caption}</figcaption>`}
</figure>
</li>`)}
</ul>`);
}
```


- [ ] **Step 4: Run the whole suite and the typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: `Test Files  17 passed (17)`, `Tests  250 passed (250)`; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/renderer/src/sections/services.ts packages/renderer/src/sections/testimonials.ts packages/renderer/src/sections/gallery.ts packages/renderer/test/services-reviews-gallery.test.ts
git commit -m "Add content sections"
```

---
### Task 13: About, service area and hours, FAQ, contact form

**Files:**
- Create: `packages/renderer/src/sections/about.ts`, `packages/renderer/src/sections/service-area.ts`, `packages/renderer/src/sections/faq.ts`, `packages/renderer/src/sections/contact.ts`
- Test: `packages/renderer/test/area-faq-contact.test.ts`

**Interfaces:**
- Consumes: `RenderContext` (Task 10), `DOM_ID` (Task 10), `headline`, `sectionShell` (Task 9), `html`, `trusted` (Task 5), `weeklyHours`, `formatPhone`, `telUrl`, `mailtoUrl`, `icon` (Task 8); test helpers (Task 10).
- Produces: `renderAbout(ctx, variant: VariantOf<"about">)`, `renderServiceArea(ctx, variant: VariantOf<"serviceArea">)` (heading "Service area & hours", or "Service area" when the owner gave no hours; subtitle = the owner's `serviceArea.note`, never AI copy; place chips `max-w-full wrap-anywhere`), `renderFaq(ctx, variant: VariantOf<"faq">)` (accordion = `<details name="faq">`, first item open), `renderContact(ctx, variant: VariantOf<"contact">)` (`<form action="{ctx.formAction}" method="post">`, fields `name` (required), `phone` (required), `email`, `service`, `message` (the last three labelled "(optional)"), honeypot `website`); all return `SafeHtml`.

- [ ] **Step 1: Write the failing test**

`packages/renderer/test/area-faq-contact.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderAbout } from "../src/sections/about.ts";
import { renderContact } from "../src/sections/contact.ts";
import { renderFaq } from "../src/sections/faq.ts";
import { renderServiceArea } from "../src/sections/service-area.ts";
import { FULL, makeContext, MINIMAL } from "./support/doc.ts";

describe("about", () => {
  it("uses the owner's name in the heading and the AI paragraph as text", () => {
    const out = String(renderAbout(makeContext(FULL), "plain"));
    expect(out).toContain(">About Reliable Rooter</h2>");
    expect(out).toContain(">We are a family business that treats every home like our own.</p>");
  });
});

describe("service area and hours", () => {
  it("lists places, the street address and a full week of hours from facts", () => {
    const out = String(renderServiceArea(makeContext(FULL), "split"));
    expect(out).toContain(">Service area &amp; hours</h2>");
    expect(out).toContain('<p class="mt-4 text-xl text-pretty text-muted">Within 25 miles of downtown Austin</p>');
    expect(out).toContain(">Round Rock</li>");
    expect(out).toContain(">100 Congress Ave<br>Austin, TX 78701</address>");
    expect(out).toContain('<th scope="row" class="py-2 pr-4 font-medium text-heading">Monday</th><td class="py-2 text-default">8:00 AM – 5:00 PM</td>');
    expect(out).toContain(">Sunday</th><td class=\"py-2 text-default\">Closed</td>");
    expect(out).toContain("24/7 emergency service available");
  });

  it("drops the hours column and the word hours when the owner gave no hours", () => {
    const out = String(renderServiceArea(makeContext(MINIMAL), "split"));
    expect(out).toContain(">Service area</h2>");
    expect(out).not.toMatch(/hours/i);
    expect(out).not.toContain("<table");
    expect(out).toContain('<div class="mx-auto max-w-3xl">');
    expect(out).toContain(">Based in Austin, TX</p>");
  });
});

describe("faq", () => {
  it("is a native exclusive accordion with the first item open", () => {
    const out = String(renderFaq(makeContext(FULL), "accordion"));
    expect(out.match(/<details class="group" name="faq"/g)).toHaveLength(2);
    expect(out).toContain('<details class="group" name="faq" open>');
    expect(out.match(/ open>/g)).toHaveLength(1);
    expect(out).toContain(">Do you charge for estimates?</h3>");
    expect(out).not.toContain("<script");
  });

  it("has an always-open two-column variant", () => {
    const out = String(renderFaq(makeContext(FULL), "open"));
    expect(out).not.toContain("<details");
    expect(out).toContain('<div class="mx-auto grid max-w-4xl grid-cols-1 gap-8 sm:grid-cols-2 md:gap-y-8">');
  });
});

describe("contact", () => {
  const out = String(renderContact(makeContext(FULL), "card"));

  it("posts to the configured https action", () => {
    expect(out).toContain('<form action="https://forms.example.com/submit" method="post">');
  });

  it("labels every field, marks the optional ones and requires name and phone", () => {
    expect(out).toContain(">Email (optional)</label>");
    expect(out).toContain(">Service needed (optional)</label>");
    expect(out).toContain(">How can we help? (optional)</label>");
    for (const id of ["contact-name", "contact-phone", "contact-email", "contact-service", "contact-message", "contact-website"]) {
      expect(out).toContain(`<label for="${id}"`);
      expect(out).toContain(`id="${id}"`);
    }
    expect(out).toMatch(/id="contact-name" name="name" type="text" autocomplete="name" required/);
    expect(out).toMatch(/id="contact-phone" name="phone" type="tel" autocomplete="tel" required/);
    expect(out).not.toMatch(/id="contact-email"[^>]*required/);
  });

  it("offers the owner's services in the select", () => {
    expect(out).toContain("<option>Drain cleaning</option>");
    expect(out).toContain("<option>Something else</option>");
  });

  it("has a hidden, unfocusable honeypot", () => {
    expect(out).toContain('aria-hidden="true"><label for="contact-website">Leave this field empty</label><input id="contact-website" name="website" type="text" tabindex="-1" autocomplete="off">');
  });

  it("uses the AI call-to-action as the heading", () => {
    expect(out).toContain(">Get a free quote</h2>");
    expect(String(renderContact(makeContext(MINIMAL), "card"))).toContain(">Book a clean</h2>");
  });
});
```


- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/renderer/test/area-faq-contact.test.ts`
Expected: FAIL — `Cannot find module '../src/sections/about.ts'`.

- [ ] **Step 3: Write the implementation**

`packages/renderer/src/sections/about.ts`:

```ts
// About: the owner's business name as the heading and the AI-written paragraph as text.
import type { VariantOf } from "@asksite/site-schema";
import type { RenderContext } from "../context.ts";
import { html, type SafeHtml } from "../html.ts";
import { headline, sectionShell } from "../ui.ts";
import { DOM_ID } from "./ids.ts";

export function renderAbout(ctx: RenderContext, _variant: VariantOf<"about">): SafeHtml {
  const { facts, copy } = ctx.doc;
  return sectionShell(DOM_ID.about, "7xl", html`${headline(DOM_ID.about, `About ${facts.businessName}`)}
<p class="mx-auto max-w-3xl text-center text-lg text-pretty">${copy.about}</p>`);
}
```

`packages/renderer/src/sections/service-area.ts`:

```ts
// Service area and hours (new; AstroWind has no such section). Everything here is an owner fact:
// the subtitle is the owner's service-area note, never AI prose. Place chips may wrap anywhere,
// so one long unbroken place name cannot push the page sideways at 320 px. The matching
// LocalBusiness JSON-LD (areaServed, openingHoursSpecification) is emitted once by render.ts.
import type { VariantOf } from "@asksite/site-schema";
import type { RenderContext } from "../context.ts";
import { weeklyHours } from "../format.ts";
import { html, type SafeHtml } from "../html.ts";
import { icon } from "../icons.ts";
import { headline, sectionShell } from "../ui.ts";
import { DOM_ID } from "./ids.ts";

const COLUMNS = {
  withHours: "mx-auto grid max-w-5xl grid-cols-1 gap-10 md:grid-cols-2",
  placesOnly: "mx-auto max-w-3xl",
} as const;

const TITLE = { withHours: "Service area & hours", placesOnly: "Service area" } as const;

export function renderServiceArea(ctx: RenderContext, _variant: VariantOf<"serviceArea">): SafeHtml {
  const { facts } = ctx.doc;
  const { location, serviceArea } = facts;
  const hasHours = facts.hours.length > 0;
  const cityLine = `${location.city}, ${location.state}${location.postalCode ? ` ${location.postalCode}` : ""}`;

  return sectionShell(DOM_ID.serviceArea, "7xl", html`${headline(DOM_ID.serviceArea, hasHours ? TITLE.withHours : TITLE.placesOnly, serviceArea.note)}
<div class="${hasHours ? COLUMNS.withHours : COLUMNS.placesOnly}">
<div>
<h3 class="flex items-center gap-2 text-xl font-bold text-heading">${icon("map-pin", "h-6 w-6 shrink-0 text-primary")}Areas we serve</h3>
<ul class="mt-4 flex flex-wrap gap-2">
${serviceArea.places.map((place) => html`<li class="max-w-full rounded-full border border-gray-300 px-3 py-1 text-sm text-default wrap-anywhere">${place}</li>`)}
</ul>
${location.streetAddress
  ? html`<address class="mt-6 text-default not-italic">${location.streetAddress}<br>${cityLine}</address>`
  : html`<p class="mt-6 text-default">Based in ${cityLine}</p>`}
</div>
${hasHours && html`<div>
<h3 class="flex items-center gap-2 text-xl font-bold text-heading">${icon("clock", "h-6 w-6 shrink-0 text-primary")}Hours</h3>
<table class="mt-4 w-full text-left">
<tbody>
${weeklyHours(facts.hours).map((row) => html`<tr class="border-b border-gray-200"><th scope="row" class="py-2 pr-4 font-medium text-heading">${row.day}</th><td class="py-2 text-default">${row.time}</td></tr>`)}
</tbody>
</table>
${facts.emergency247 && html`<p class="mt-4 font-semibold text-heading">24/7 emergency service available</p>`}
</div>`}
</div>`);
}
```

`packages/renderer/src/sections/faq.ts`:

```ts
// Ported from AstroWind (MIT, see THIRD_PARTY_NOTICES.md) src/components/widgets/FAQs.astro
// at commit 14e1a69. Changes: the random <details name> group (Math.random, line 31) is the
// fixed name "faq"; questions and answers are escaped text, not set:html; the FAQPage JSON-LD
// is built from data and serialised safely in render.ts (the original only stripped tags);
// rtl:, dark:, intersect-* and fade classes removed; flex-shrink-0 written as shrink-0.
import type { VariantOf } from "@asksite/site-schema";
import type { RenderContext } from "../context.ts";
import { html, trusted, type SafeHtml } from "../html.ts";
import { icon } from "../icons.ts";
import { headline, sectionShell } from "../ui.ts";
import { DOM_ID } from "./ids.ts";

export function renderFaq(ctx: RenderContext, variant: VariantOf<"faq">): SafeHtml {
  const { copy } = ctx.doc;

  const list =
    variant === "accordion"
      ? html`<div class="mx-auto max-w-3xl divide-y divide-gray-200">
${copy.faq.map((item, i) => html`<details class="group" name="faq"${i === 0 && trusted(" open")}>
<summary class="flex cursor-pointer list-none items-center justify-between gap-4 py-5 outline-offset-4 [&::-webkit-details-marker]:hidden">
<h3 class="min-w-0 text-lg font-semibold text-heading md:text-xl">${item.question}</h3>
${icon("chevron-down", "h-6 w-6 shrink-0 text-primary transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none")}
</summary>
<div class="pr-10 pb-5"><p class="text-muted">${item.answer}</p></div>
</details>`)}
</div>`
      : html`<div class="mx-auto grid max-w-4xl grid-cols-1 gap-8 sm:grid-cols-2 md:gap-y-8">
${copy.faq.map((item) => html`<div class="flex flex-row">
<div class="flex justify-center">${icon("chevron-right", "mt-1 mr-2 h-6 w-6 shrink-0 text-primary")}</div>
<div class="mt-0.5 min-w-0">
<h3 class="text-xl font-bold text-heading">${item.question}</h3>
<p class="mt-3 text-muted">${item.answer}</p>
</div>
</div>`)}
</div>`;

  return sectionShell(DOM_ID.faq, "7xl", html`${headline(DOM_ID.faq, "Questions & answers", copy.sectionIntros.faq)}
${list}`);
}
```

`packages/renderer/src/sections/contact.ts`:

```ts
// Ported from AstroWind (MIT, see THIRD_PARTY_NOTICES.md) src/components/widgets/Contact.astro
// and src/components/ui/Form.astro at commit 14e1a69. Fixes over the original: a real
// <form method="post"> to a configurable https action (the original had no action or method,
// so it sent a GET to the same page); required name and phone; every field has a label and a
// unique id; autocomplete tokens (WCAG 1.3.5); an off-screen honeypot field; text-md (no CSS in
// Tailwind 4.3.3) replaced by text-base; 48px inputs; borders that meet 3:1 non-text contrast.
import type { VariantOf } from "@asksite/site-schema";
import type { RenderContext } from "../context.ts";
import { formatPhone, mailtoUrl, telUrl } from "../format.ts";
import { html, type SafeHtml } from "../html.ts";
import { headline, sectionShell } from "../ui.ts";
import { DOM_ID } from "./ids.ts";

const LABEL = "block text-sm font-medium text-heading";
const FIELD = "mt-1 block min-h-12 w-full rounded-lg border border-muted bg-white px-4 py-3 text-base text-default";

export function renderContact(ctx: RenderContext, _variant: VariantOf<"contact">): SafeHtml {
  const { facts, copy } = ctx.doc;

  return sectionShell(DOM_ID.contact, "7xl", html`${headline(DOM_ID.contact, copy.ctaText, copy.sectionIntros.contact)}
<div class="relative mx-auto flex w-full max-w-xl flex-col rounded-lg border border-gray-200 bg-white p-4 shadow sm:p-6 lg:p-8">
<p class="mb-6 text-default">Prefer to talk? Call <a class="font-semibold whitespace-nowrap text-link underline" href="${telUrl(facts.phone)}">${formatPhone(facts.phone)}</a> or email <a class="font-semibold break-all text-link underline" href="${mailtoUrl(facts.email)}">${facts.email}</a>.</p>
<form action="${ctx.formAction}" method="post">
<div class="mb-6"><label for="contact-name" class="${LABEL}">Name</label><input id="contact-name" name="name" type="text" autocomplete="name" required maxlength="80" class="${FIELD}"></div>
<div class="mb-6"><label for="contact-phone" class="${LABEL}">Phone</label><input id="contact-phone" name="phone" type="tel" autocomplete="tel" required maxlength="30" class="${FIELD}"></div>
<div class="mb-6"><label for="contact-email" class="${LABEL}">Email (optional)</label><input id="contact-email" name="email" type="email" autocomplete="email" maxlength="254" class="${FIELD}"></div>
<div class="mb-6"><label for="contact-service" class="${LABEL}">Service needed (optional)</label><select id="contact-service" name="service" class="${FIELD}">
<option value="">Choose a service</option>
${facts.services.map((s) => html`<option>${s.name}</option>`)}
<option>Something else</option>
</select></div>
<div class="mb-6"><label for="contact-message" class="${LABEL}">How can we help? (optional)</label><textarea id="contact-message" name="message" rows="4" maxlength="2000" class="${FIELD}"></textarea></div>
<div class="absolute -left-[9999px] h-px w-px overflow-hidden" aria-hidden="true"><label for="contact-website">Leave this field empty</label><input id="contact-website" name="website" type="text" tabindex="-1" autocomplete="off"></div>
<div class="mt-8 grid"><button type="submit" class="btn-primary">Send request</button></div>
</form>
</div>`);
}
```


- [ ] **Step 4: Run the whole suite and the typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: `Test Files  18 passed (18)`, `Tests  260 passed (260)`; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/renderer/src/sections/about.ts packages/renderer/src/sections/service-area.ts packages/renderer/src/sections/faq.ts packages/renderer/src/sections/contact.ts packages/renderer/test/area-faq-contact.test.ts
git commit -m "Add remaining sections"
```

---
### Task 14: Page assembly — `render()`

**Files:**
- Create: `packages/renderer/src/render.ts`, `packages/renderer/src/index.ts`
- Test: `packages/renderer/test/render.test.ts`, `packages/renderer/test/class-drift.test.ts`

**Interfaces:**
- Consumes: every section renderer (Tasks 10–13), `visibleSections` and `isVisible` (Task 10), `themeStyle` (Task 7), `jsonLdScript`, `localBusinessJsonLd`, `faqPageJsonLd` (Task 6), `escapeText`, `html`, `fragment`, `safeUrl`, `trusted`, `SafeHtml` (Task 5), `TRADE_LABEL` (Task 8); `SiteDocument`, `SECTION_VARIANTS` from `@asksite/site-schema`; `missingClasses`, `loadCompiledCss` (Task 9); `FULL`, `MINIMAL` (Task 10).
- Produces (exported from `@asksite/renderer`): `interface RenderOptions { readonly stylesheet: string; readonly formAction: string }`, `render(input: SiteDocumentInput, options: RenderOptions): string`, `pageTitle(doc: SiteDocument): string`, plus `contrastRatio`, `hexToRgb`, `relativeLuminance`, `type Rgb`, `escapeAttr`, `escapeText`, `serializeJsonLd`, `FONTS`, `PALETTES`, `themeVariables`, `type FontPreset`, `type Palette`.
- `render` parses the input with `SiteDocument.parse` (throws on invalid input), requires an `https:` form action, and refuses a stylesheet containing `</style`. The `<head>` carries one fixed attribution comment with the AstroWind and Tabler Icons copyright notices.

- [ ] **Step 1: Write the failing tests**

`packages/renderer/test/render.test.ts`:

```ts
import { SiteDocument, type SiteDocumentInput } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { pageTitle, render } from "../src/index.ts";
import { FULL, MINIMAL } from "./support/doc.ts";

const OPTIONS = { stylesheet: "/* compiled css */", formAction: "https://forms.example.com/submit" };
const scriptTags = (html: string) => [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);

describe("render", () => {
  const page = render(FULL, OPTIONS);

  it("returns one complete HTML document", () => {
    expect(page.startsWith("<!DOCTYPE html>\n<html lang=\"en\"")).toBe(true);
    expect(page.trimEnd().endsWith("</html>")).toBe(true);
    expect(page.match(/<h1/g)).toHaveLength(1);
    expect(page).toContain("<title>Reliable Rooter | Plumbing in Austin, TX</title>");
    expect(page).toContain('<meta name="description" content="Leaks, clogs and water heaters fixed right the first time.">');
  });

  it("inlines the shared stylesheet and the 12 theme variables", () => {
    expect(page).toContain("<style>/* compiled css */</style>");
    expect(page.match(/--aw-[a-z-]+:/g)).toHaveLength(12);
  });

  it("ships zero JavaScript: the only scripts are JSON-LD", () => {
    const scripts = scriptTags(page);
    expect(scripts).toEqual(['<script type="application/ld+json">', '<script type="application/ld+json">']);
    expect(page).not.toMatch(/\son[a-z]+=/i);
    expect(page).not.toMatch(/javascript:/i);
    expect(page).not.toMatch(/http-equiv/i);
  });

  it("carries the MIT copyright notices in one comment", () => {
    expect(page.match(/<!--/g)).toHaveLength(1);
    expect(page).toContain("<!-- Portions adapted from AstroWind, Copyright (c) 2023 onWidget, and Tabler Icons");
  });

  it("emits FAQPage JSON-LD only when the FAQ section renders", () => {
    expect(page).toContain('"@type":"FAQPage"');
    const minimal = render(MINIMAL, OPTIONS);
    expect(minimal).not.toContain("FAQPage");
    expect(scriptTags(minimal)).toHaveLength(1);
  });

  it("renders sections in layout order, hiding empty ones", () => {
    const ids = [...page.matchAll(/<section id="([a-z-]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["top", "credentials", "services", "reviews", "our-work", "about", "service-area", "faq", "contact"]);
    const minimalIds = [...render(MINIMAL, OPTIONS).matchAll(/<section id="([a-z-]+)"/g)].map((m) => m[1]);
    expect(minimalIds).toEqual(["top", "services", "service-area", "contact"]);
  });

  it("is deterministic", () => {
    expect(render(FULL, OPTIONS)).toBe(page);
  });

  it("re-validates input and refuses bad options", () => {
    expect(() => render({ ...FULL, copy: { ...FULL.copy, heroHeadline: "Call 512-555-0142" } }, OPTIONS)).toThrow();
    expect(() => render(FULL, { ...OPTIONS, formAction: "http://forms.example.com" })).toThrow("Unsafe URL");
    expect(() => render(FULL, { ...OPTIONS, stylesheet: "</style><script>alert(1)</script>" })).toThrow("</style");
  });

  it("falls back to the business name when the title would be too long", () => {
    const long = SiteDocument.parse({ ...FULL, facts: { ...FULL.facts, businessName: "B".repeat(60) } });
    expect(pageTitle(long)).toBe("B".repeat(60));
  });
});

describe("facts and copy stay separate", () => {
  const page = render(FULL, OPTIONS);

  it("takes phone, prices, licences, hours and reviews only from facts", () => {
    const changed: SiteDocumentInput = {
      ...FULL,
      facts: {
        ...FULL.facts,
        phone: "+12125550100",
        services: [{ name: "Drain cleaning", startingPrice: 95 }, { name: "Water heaters" }, { name: "Leak repair" }],
        licences: [{ label: "NYC master plumber", number: "MP-7" }],
        hours: [{ days: ["Monday"], opens: "07:00", closes: "15:00" }],
        testimonials: [{ quote: "Changed quote.", name: "Pat" }],
      },
    };
    const out = render(changed, OPTIONS);
    expect(page).toContain("(512) 555-0142");
    expect(out).not.toContain("(512) 555-0142");
    expect(out).toContain("(212) 555-0100");
    expect(out).toContain("From $95");
    expect(out).not.toContain("From $89");
    expect(out).toContain("NYC master plumber: MP-7");
    expect(out).toContain("7:00 AM – 3:00 PM");
    expect(out).toContain("Changed quote.");
    expect(out).not.toContain("Fixed our burst pipe");
  });

  it("renders the same facts no matter what the copy says", () => {
    const otherCopy = render({ ...FULL, copy: { ...FULL.copy, heroHeadline: "Different words entirely" } }, OPTIONS);
    const facts = (html: string) => [...html.matchAll(/tel:\+\d+|From \$[\d,]+|M-40123/g)].map((m) => m[0]);
    expect(facts(otherCopy)).toEqual(facts(page));
  });
});
```

`packages/renderer/test/class-drift.test.ts`:

```ts
import { SECTION_VARIANTS, type SiteDocumentInput } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { render } from "../src/index.ts";
import { loadCompiledCss, missingClasses } from "./support/css-classes.ts";
import { FULL, MINIMAL } from "./support/doc.ts";

// Renders every section variant with 1, 2, 3, 4 and 12 items, so every branch of every class
// lookup table is exercised, then checks each class against the compiled stylesheet.
const css = loadCompiledCss();
const COUNTS = [1, 2, 3, 4, 12];

function layoutUsingVariant(index: number): SiteDocumentInput["layout"] {
  return Object.entries(SECTION_VARIANTS).map(([id, variants]) => ({ id, variant: variants[Math.min(index, variants.length - 1)] })) as SiteDocumentInput["layout"];
}

function withCount(count: number, variantIndex: number): SiteDocumentInput {
  const photo = { url: "https://images.example.com/p.jpg", alt: "A finished job", width: 1200, height: 900, caption: "Caption" };
  const services = Array.from({ length: count }, (_, i) => ({ name: `Service ${String.fromCharCode(65 + i)}`, startingPrice: 50 + i }));
  return {
    ...FULL,
    facts: {
      ...FULL.facts,
      services,
      testimonials: Array.from({ length: count }, (_, i) => ({ quote: "Great work.", name: `Customer ${String.fromCharCode(65 + i)}` })),
      photos: Array.from({ length: count }, () => photo),
    },
    copy: { ...FULL.copy, serviceDescriptions: services.map((s) => ({ service: s.name, description: "A careful job." })) },
    layout: layoutUsingVariant(variantIndex),
  };
}

describe("class drift", () => {
  it("every class in every variant and item count exists in the compiled CSS", () => {
    const pages = [render(MINIMAL, { stylesheet: "", formAction: "https://forms.example.com/submit" })];
    for (const variantIndex of [0, 1]) {
      for (const count of COUNTS) pages.push(render(withCount(count, variantIndex), { stylesheet: "", formAction: "https://forms.example.com/submit" }));
    }
    expect(pages.flatMap((page) => missingClasses(page, css))).toEqual([]);
  });
});
```


- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm build:css && pnpm vitest run packages/renderer/test/render.test.ts packages/renderer/test/class-drift.test.ts`
Expected: FAIL — `Cannot find module '../src/index.ts'` in both files.

- [ ] **Step 3: Write the implementation**

`packages/renderer/src/render.ts`:

```ts
import { SiteDocument, type LayoutSection, type SiteDocumentInput } from "@asksite/site-schema";
import { isVisible, type RenderContext } from "./context.ts";
import { escapeText } from "./escape.ts";
import { TRADE_LABEL } from "./format.ts";
import { fragment, html, safeUrl, SafeHtml, trusted } from "./html.ts";
import { faqPageJsonLd, jsonLdScript, localBusinessJsonLd } from "./json-ld.ts";
import { renderAbout } from "./sections/about.ts";
import { renderContact } from "./sections/contact.ts";
import { renderFaq } from "./sections/faq.ts";
import { renderCallBar, renderFooter } from "./sections/footer.ts";
import { renderGallery } from "./sections/gallery.ts";
import { renderHeader } from "./sections/header.ts";
import { renderHero } from "./sections/hero.ts";
import { renderServiceArea } from "./sections/service-area.ts";
import { renderServices } from "./sections/services.ts";
import { renderTestimonials } from "./sections/testimonials.ts";
import { renderTrust } from "./sections/trust.ts";
import { themeStyle } from "./theme.ts";
import { visibleSections } from "./visibility.ts";

export interface RenderOptions {
  /** The shared compiled stylesheet (packages/renderer/styles/site.css). Inlined into every page. */
  readonly stylesheet: string;
  /** Absolute https URL the contact form posts to. */
  readonly formAction: string;
}

// The MIT licences of the code these pages are built from ask for the copyright notice to travel
// with copies; one fixed comment per page does that (full texts: THIRD_PARTY_NOTICES.md).
const ATTRIBUTION =
  "<!-- Portions adapted from AstroWind, Copyright (c) 2023 onWidget, and Tabler Icons, Copyright (c) 2020-2026 Paweł Kuna. MIT License. -->";

// Search results truncate long titles. Measured on the escaped text ("&" counts as "&amp;"),
// which is how html-validate's long-title rule counts, so this is never more lenient.
const MAX_TITLE_LENGTH = 70;

/** "Name | Plumbing in Austin, TX", or just the name when that would be too long. */
export function pageTitle(doc: SiteDocument): string {
  const { businessName, trade, location } = doc.facts;
  const full = `${businessName} | ${TRADE_LABEL[trade]} in ${location.city}, ${location.state}`;
  return escapeText(full).length <= MAX_TITLE_LENGTH ? full : businessName;
}

function styleTag(css: string): SafeHtml {
  if (/<\/style/i.test(css)) throw new Error("Stylesheet must not contain </style");
  return new SafeHtml(`<style>${css}</style>`);
}

function renderSection(ctx: RenderContext, section: LayoutSection): SafeHtml {
  switch (section.id) {
    case "hero":
      return renderHero(ctx, section.variant);
    case "trust":
      return renderTrust(ctx, section.variant);
    case "services":
      return renderServices(ctx, section.variant);
    case "testimonials":
      return renderTestimonials(ctx, section.variant);
    case "gallery":
      return renderGallery(ctx, section.variant);
    case "about":
      return renderAbout(ctx, section.variant);
    case "serviceArea":
      return renderServiceArea(ctx, section.variant);
    case "faq":
      return renderFaq(ctx, section.variant);
    case "contact":
      return renderContact(ctx, section.variant);
  }
}

/**
 * Render one complete, self-contained static HTML page. Pure: no network, no clock, no randomness.
 * The input is re-validated, so an unvalidated or tampered document throws instead of rendering.
 */
export function render(input: SiteDocumentInput, options: RenderOptions): string {
  const doc = SiteDocument.parse(input);
  const ctx: RenderContext = {
    doc,
    sections: visibleSections(doc),
    formAction: safeUrl(options.formAction, ["https:"]),
  };

  const page = html`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
${trusted(ATTRIBUTION)}
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="format-detection" content="telephone=no">
<title>${pageTitle(doc)}</title>
<meta name="description" content="${doc.copy.heroSubheadline}">
${styleTag(options.stylesheet)}
${themeStyle(doc.theme)}
${jsonLdScript(localBusinessJsonLd(doc.facts))}
${isVisible(ctx, "faq") && jsonLdScript(faqPageJsonLd(doc.copy.faq))}
</head>
<body class="min-h-screen bg-page font-sans break-words text-default antialiased">
<a class="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:bg-page focus:px-4 focus:py-2 focus:text-heading focus:shadow-lg" href="${fragment("main")}">Skip to content</a>
${renderHeader(ctx)}
<main id="main">
${ctx.sections.map((section) => renderSection(ctx, section))}
</main>
${renderFooter(ctx)}
${renderCallBar(ctx)}
</body>
</html>
`;
  return String(page);
}
```

`packages/renderer/src/index.ts`:

```ts
export { contrastRatio, hexToRgb, relativeLuminance, type Rgb } from "./contrast.ts";
export { escapeAttr, escapeText } from "./escape.ts";
export { serializeJsonLd } from "./json-ld.ts";
export { pageTitle, render, type RenderOptions } from "./render.ts";
export { FONTS, PALETTES, themeVariables, type FontPreset, type Palette } from "./theme.ts";
```


- [ ] **Step 4: Run the whole suite and the typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: `Test Files  20 passed (20)`, `Tests  272 passed (272)`; typecheck exits 0. `pnpm test` rebuilt `site.css` first, so the class-drift test checked every variant against the fresh sheet.

- [ ] **Step 5: Commit**

```bash
git add packages/renderer/src/render.ts packages/renderer/src/index.ts packages/renderer/test/render.test.ts packages/renderer/test/class-drift.test.ts
git commit -m "Add page renderer"
```

---
### Task 15: Fixtures, golden files, html-validate and the XSS proof

**Files:**
- Modify: `package.json` (adds `html-validate` and the two workspace packages as root dev dependencies)
- Create: `fixtures/plumber-austin.json`, `fixtures/hvac-phoenix.json`, `fixtures/cleaning-minimal.json`, `fixtures/electrical-xss.json`, `fixtures/index.ts`, `scripts/make-extreme-fixture.ts`
- Generate: `fixtures/roofing-extreme.json` (by the script), `fixtures/golden/*.html` (by the golden test)
- Test: `packages/renderer/test/fixtures.test.ts`, `packages/renderer/test/xss.test.ts`

**Interfaces:**
- Consumes: `render` (Task 14), `SiteDocument`, `SiteDocumentInput` from `@asksite/site-schema`; `loadCompiledCss`, `missingClasses` (Task 9).
- Produces: `FIXTURES` (`plumber-austin`, `hvac-phoenix`, `roofing-extreme`, `cleaning-minimal`, `electrical-xss`), `type FixtureName`, `FIXTURE_FORM_ACTION = "https://forms.example.com/submit"`, `loadFixture(name: FixtureName): SiteDocumentInput`, `loadStylesheet(): string` (reads the compiled `site.css`), `renderFixture(name: FixtureName, stylesheet?: string): string`.
- Fixture roles: `plumber-austin` and `hvac-phoenix` are typical businesses covering every variant; `roofing-extreme` puts every text field at its schema maximum and every list at its maximum count, with a 40-character unbroken word in the headline and upper-case unbroken words as the first place (40), service (40), reviewer (40) and licence number (30); `cleaning-minimal` has a 3-character name, 2 services and nothing optional; `electrical-xss` holds an XSS payload in every free-text field. Every fixture passes the claim checker, and social links use the networks' real hosts (tests never load them). Phone numbers use the NANPA fictional range 555-0100…0199.
- The XSS test reads tags the way the HTML tokenizer does (double-quoted, single-quoted and unquoted attribute values), so a payload such as `<img src=x onerror=alert(1)>` that escaped escaping is seen as a tag with an `onerror` attribute.

- [ ] **Step 1: Add the dev dependencies**

`package.json`:

```json
{
  "name": "asksite",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.33.0",
  "engines": {
    "node": ">=24.8.0"
  },
  "scripts": {
    "build:css": "pnpm --filter @asksite/renderer run build:css",
    "typecheck": "tsc -p .",
    "test": "pnpm build:css && vitest run"
  },
  "devDependencies": {
    "@asksite/renderer": "workspace:*",
    "@asksite/site-schema": "workspace:*",
    "@types/node": "24.13.6",
    "html-validate": "11.16.0",
    "typescript": "7.0.2",
    "vitest": "5.0.1"
  }
}
```


Run: `pnpm install`
Expected: `Done in …s using pnpm v10.33.0`; `node_modules/@asksite/renderer` and `node_modules/@asksite/site-schema` are symlinks into `packages/`.

- [ ] **Step 2: Write the failing tests**

`packages/renderer/test/fixtures.test.ts`:

```ts
import { SiteDocument } from "@asksite/site-schema";
import { formatterFactory, HtmlValidate, StaticConfigLoader } from "html-validate";
import { describe, expect, it } from "vitest";
import { FIXTURES, loadFixture, renderFixture } from "../../../fixtures/index.ts";
import { loadCompiledCss, missingClasses } from "./support/css-classes.ts";

// Golden files hold markup only; the real stylesheet would add ~30 KB of noise to every diff.
const STUB_CSS = "/* site.css */";

// html-validate's recommended rules. tel-non-breaking is satisfied with CSS instead of
// &nbsp;/&#8209; entities: every tel: link carries whitespace-nowrap, so it cannot wrap.
const htmlValidate = new HtmlValidate(
  new StaticConfigLoader({
    extends: ["html-validate:recommended"],
    rules: { "tel-non-breaking": ["error", { ignoreClasses: ["whitespace-nowrap"] }] },
  }),
);

const sectionIds = (html: string) => [...html.matchAll(/<section id="([a-z-]+)"/g)].map((m) => m[1]);

describe.each(FIXTURES)("fixture %s", (name) => {
  it("is a valid SiteDocument", () => {
    expect(SiteDocument.safeParse(loadFixture(name)).success).toBe(true);
  });

  it("matches its golden HTML", async () => {
    await expect(renderFixture(name, STUB_CSS)).toMatchFileSnapshot(`../../../fixtures/golden/${name}.html`);
  });

  it("passes html-validate (recommended)", async () => {
    const report = await htmlValidate.validateString(renderFixture(name, STUB_CSS));
    if (!report.valid) console.log(formatterFactory("text")(report.results));
    expect(report.valid).toBe(true);
  });

  it("uses only classes that exist in the compiled stylesheet", () => {
    const css = loadCompiledCss();
    expect(missingClasses(renderFixture(name, css), css)).toEqual([]);
  });
});

describe("html-validate catches broken markup (RED proof)", () => {
  it("rejects a mis-nested page", async () => {
    const report = await htmlValidate.validateString(
      "<!DOCTYPE html><html lang=\"en\"><head><title>x</title></head><body><div><p>x</span></body></html>",
    );
    expect(report.valid).toBe(false);
  });
});

describe("content resilience", () => {
  it("minimal: hides every section that has no owner content", () => {
    const html = renderFixture("cleaning-minimal", STUB_CSS);
    expect(sectionIds(html)).toEqual(["top", "services", "service-area", "contact"]);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("FAQPage");
    expect(html).not.toContain("Credentials");
  });

  it("extreme: renders every item at maximum length and count", () => {
    const html = renderFixture("roofing-extreme", STUB_CSS);
    expect(sectionIds(html)).toEqual(["top", "credentials", "services", "reviews", "our-work", "about", "service-area", "faq", "contact"]);
    expect(html.match(/From \$100,000/g)).toHaveLength(12);
    expect(html.match(/<figure class="flex w-full flex-col/g)).toHaveLength(12);
    expect(html.match(/loading="lazy"/g)).toHaveLength(12);
    expect(html.match(/<details class="group" name="faq"/g)).toHaveLength(8);
    expect(html.match(/<li class="max-w-full rounded-full border/g)).toHaveLength(30);
    expect(html).toContain(">NORTHRICHLANDHILLSWATAUGAHALTOMCITYAREAS</li>");
    expect(html).toContain(">Unbelievablyweathertightroofreplacements for every hailstorm across North Texas!</h1>");
    expect(html).toContain("<title>Longhorn Storm Restoration Roofing, Gutters, Siding &amp; Window</title>");
  });
});
```

`packages/renderer/test/xss.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadFixture, renderFixture } from "../../../fixtures/index.ts";
import { render } from "../src/index.ts";
import { FULL } from "./support/doc.ts";

// Every free-text field of this fixture holds an XSS payload (script tags, event handlers,
// attribute breakouts, javascript: URLs, </script> and </style> breakouts).
const page = renderFixture("electrical-xss", "/* css */");

const ALLOWED_TAGS = new Set(
  (
    "html head meta title style script body a header div nav ul li details summary span svg path g main section " +
    "p h1 h2 h3 img figure figcaption blockquote hr table tbody tr th td address br form label input select option " +
    "textarea button aside footer"
  ).split(" "),
);

// Attributes the browser fetches or navigates to.
const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "poster", "cite", "data", "ping", "background", "xlink:href", "srcset"]);

// Start tags and attributes as the HTML tokenizer reads them: attribute values may be
// double-quoted, single-quoted or unquoted. Our templates only write double quotes, so any
// other form can only come from a payload that escaped escaping.
const ATTRIBUTE_SOURCE = String.raw`\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>\x60]+))?`;
const START_TAG = new RegExp(String.raw`<([a-zA-Z][\w-]*)((?:${ATTRIBUTE_SOURCE})*)\s*\/?>`, "g");
const ATTRIBUTE = /\s+([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const startTags = [...page.matchAll(START_TAG)].map((m) => ({
  name: (m[1] ?? "").toLowerCase(),
  attributes: [...(m[2] ?? "").matchAll(ATTRIBUTE)].map((a) => ({
    name: (a[1] ?? "").toLowerCase(),
    value: a[2] ?? a[3] ?? a[4] ?? "",
  })),
  raw: m[0],
}));

describe("XSS payloads are neutralised", () => {
  it("every raw '<' in the page starts one of our own tags or our one comment", () => {
    const endTags = page.match(/<\/[a-zA-Z][\w-]*>/g) ?? [];
    const doctype = page.match(/<!DOCTYPE html>/g) ?? [];
    const comments = page.match(/<!--/g) ?? [];
    expect(comments).toHaveLength(1);
    expect((page.match(/</g) ?? []).length).toBe(startTags.length + endTags.length + doctype.length + comments.length);
  });

  it("creates no unexpected elements", () => {
    expect(startTags.map((t) => t.name).filter((n) => !ALLOWED_TAGS.has(n))).toEqual([]);
  });

  it("creates no event-handler attributes, quoted or not", () => {
    const names = startTags.flatMap((t) => t.attributes.map((a) => a.name));
    expect(names.length).toBeGreaterThan(100);
    expect(names.filter((n) => n.startsWith("on"))).toEqual([]);
  });

  it("has only the two JSON-LD scripts and the two style blocks we emit", () => {
    expect(startTags.filter((t) => t.name === "script").map((t) => t.raw)).toEqual([
      '<script type="application/ld+json">',
      '<script type="application/ld+json">',
    ]);
    expect(startTags.filter((t) => t.name === "style")).toHaveLength(2);
  });

  it("never renders a script URL in any attribute", () => {
    const attributes = startTags.flatMap((t) => t.attributes);
    const urls = attributes.filter((a) => URL_ATTRIBUTES.has(a.name)).map((a) => a.value);
    expect(urls.length).toBeGreaterThan(10);
    for (const url of urls) expect(url).toMatch(/^(https:|tel:|mailto:|#)/);
    expect(attributes.filter((a) => /^\s*(javascript|vbscript|data):/i.test(a.value))).toEqual([]);
  });

  it("shows payloads as text", () => {
    expect(page).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(page).toContain('alt="&quot; onerror=&quot;alert(1)"');
    expect(page).toContain("&lt;script&gt;alert(document.domain)&lt;/script&gt;</h1>");
  });

  it("keeps JSON-LD intact: payloads round-trip without breaking out", () => {
    const blocks = [...page.matchAll(/<script type="application\/ld\+json">([^<]*)<\/script>/g)].map((m) =>
      JSON.parse(m[1] ?? "null"),
    );
    const doc = loadFixture("electrical-xss");
    expect(blocks[0].name).toBe(doc.facts.businessName);
    expect(blocks[1].mainEntity[0].acceptedAnswer.text).toBe(doc.copy.faq?.[0]?.answer);
  });

  it("refuses a theme payload at the render boundary", () => {
    const options = { stylesheet: "", formAction: "https://forms.example.com/submit" };
    const payload = "red;}</style><script>alert(1)</script>";
    expect(() => render({ ...FULL, theme: { palette: payload, font: "clean" } } as never, options)).toThrow('"palette"');
    expect(() => render({ ...FULL, theme: { palette: "navy-orange", font: payload } } as never, options)).toThrow('"font"');
  });
});
```


- [ ] **Step 3: Run them and watch them fail**

Run: `pnpm vitest run packages/renderer/test/fixtures.test.ts packages/renderer/test/xss.test.ts`
Expected: FAIL — `Cannot find module '../../../fixtures/index.ts'` in both files.

- [ ] **Step 4: Write the four hand-written fixtures**

The photo URLs point at picsum.photos so `pnpm render` output looks real in a browser. Tests never load them: Playwright serves every image from memory.

`fixtures/plumber-austin.json`:

```json
{
  "facts": {
    "businessName": "Reliable Rooter Plumbing",
    "trade": "plumbing",
    "phone": "+15125550142",
    "email": "office@reliablerooter.example.com",
    "location": { "streetAddress": "4100 S Congress Ave", "city": "Austin", "state": "TX", "postalCode": "78745" },
    "serviceArea": {
      "places": ["Austin", "Round Rock", "Pflugerville", "Cedar Park", "Georgetown", "Kyle", "Buda"],
      "note": "Within 30 miles of downtown Austin"
    },
    "hours": [
      { "days": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], "opens": "07:30", "closes": "18:00" },
      { "days": ["Saturday"], "opens": "08:00", "closes": "14:00" }
    ],
    "services": [
      { "name": "Drain cleaning", "startingPrice": 89 },
      { "name": "Water heater repair & install", "startingPrice": 149 },
      { "name": "Leak detection" },
      { "name": "Sewer line repair" },
      { "name": "Fixture installation", "startingPrice": 120 }
    ],
    "licences": [{ "label": "Texas master plumber", "number": "M-40123" }],
    "insured": true,
    "yearFounded": 1998,
    "emergency247": true,
    "freeEstimates": true,
    "testimonials": [
      { "quote": "Our water heater died on a Sunday night and they had a new one in by Monday lunch. Fair price, clean work, and they hauled the old tank away.", "name": "Dana P.", "location": "Round Rock, TX" },
      { "quote": "Found a slab leak two other companies missed. Explained everything before starting.", "name": "Luis M.", "location": "Austin, TX" },
      { "quote": "On time, polite, and the kitchen drain has been perfect since.", "name": "Priya S." }
    ],
    "heroPhoto": { "url": "https://picsum.photos/seed/rooter-van/1600/900", "alt": "Reliable Rooter service van parked outside a home", "width": 1600, "height": 900 },
    "photos": [
      { "url": "https://picsum.photos/seed/rooter-1/1200/900", "alt": "New tankless water heater mounted on a garage wall", "width": 1200, "height": 900, "caption": "Tankless water heater, Round Rock" },
      { "url": "https://picsum.photos/seed/rooter-2/1200/900", "alt": "Replaced copper pipes under a kitchen sink", "width": 1200, "height": 900, "caption": "Kitchen repipe" },
      { "url": "https://picsum.photos/seed/rooter-3/1200/900", "alt": "Camera inspection screen showing a clear sewer line", "width": 1200, "height": 900 },
      { "url": "https://picsum.photos/seed/rooter-4/1200/900", "alt": "New bathroom vanity and faucet", "width": 1200, "height": 900, "caption": "Bathroom fixture swap" },
      { "url": "https://picsum.photos/seed/rooter-5/1200/900", "alt": "Excavated yard with new sewer pipe", "width": 1200, "height": 900 },
      { "url": "https://picsum.photos/seed/rooter-6/1200/900", "alt": "Technician checking a water pressure gauge", "width": 1200, "height": 900 }
    ],
    "socialLinks": [
      { "network": "google", "url": "https://www.google.com/maps/search/?api=1&query=Reliable+Rooter+Plumbing+Austin" },
      { "network": "facebook", "url": "https://www.facebook.com/reliablerooterplumbing" },
      { "network": "yelp", "url": "https://www.yelp.com/biz/reliable-rooter-plumbing-austin" }
    ]
  },
  "copy": {
    "heroHeadline": "Austin plumbers who show up and fix it right",
    "heroSubheadline": "From clogged drains to burst pipes, our licensed team gets your water flowing again without the runaround.",
    "ctaText": "Get a free quote",
    "about": "Reliable Rooter is a family plumbing company. We explain the problem, give you a clear price before any work starts, and clean up after ourselves. Most of our work comes from neighbors who told their neighbors.",
    "sectionIntros": {
      "services": "Repairs and installs for homes across the Austin area.",
      "gallery": "A few recent jobs.",
      "faq": "Straight answers before you call.",
      "contact": "Tell us what is going on and we will call you back."
    },
    "serviceDescriptions": [
      { "service": "Drain cleaning", "description": "We clear kitchen, bath and main line clogs and tell you what caused them." },
      { "service": "Water heater repair & install", "description": "Tank and tankless water heaters repaired or replaced, old unit hauled away." },
      { "service": "Leak detection", "description": "Electronic leak detection finds hidden leaks before they ruin floors and walls." },
      { "service": "Sewer line repair", "description": "Camera inspection first, then the least disruptive repair for your yard." },
      { "service": "Fixture installation", "description": "Faucets, toilets, disposals and showers installed properly the first time." }
    ],
    "faq": [
      { "question": "Do you charge for estimates?", "answer": "No. We give you a clear written price before any work starts, and there is no charge if you decide not to go ahead." },
      { "question": "Can you come out for an emergency?", "answer": "Yes. Call us any time, day or night, and a plumber will call you back right away to help you shut off the water and get someone out." },
      { "question": "Do you clean up after the job?", "answer": "Always. We use floor covers, take away old parts and leave your home the way we found it." },
      { "question": "Which areas do you cover?", "answer": "Austin and the surrounding towns listed below. If you are just outside that area, call and ask." }
    ]
  },
  "layout": [
    { "id": "hero", "variant": "photo" },
    { "id": "trust", "variant": "band" },
    { "id": "services", "variant": "cards" },
    { "id": "testimonials", "variant": "grid" },
    { "id": "gallery", "variant": "grid" },
    { "id": "about", "variant": "plain" },
    { "id": "serviceArea", "variant": "split" },
    { "id": "faq", "variant": "accordion" },
    { "id": "contact", "variant": "card" }
  ],
  "theme": { "palette": "navy-orange", "font": "clean" }
}
```

`fixtures/hvac-phoenix.json`:

```json
{
  "facts": {
    "businessName": "Desert Air Heating & Cooling",
    "trade": "hvac",
    "phone": "+16025550118",
    "email": "service@desertair.example.com",
    "location": { "city": "Phoenix", "state": "AZ", "postalCode": "85016" },
    "serviceArea": { "places": ["Phoenix", "Scottsdale", "Tempe", "Mesa", "Chandler", "Glendale"] },
    "hours": [
      { "days": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], "opens": "07:00", "closes": "19:00" },
      { "days": ["Saturday", "Sunday"], "opens": "00:00", "closes": "23:59" }
    ],
    "services": [
      { "name": "AC repair", "startingPrice": 79 },
      { "name": "AC replacement" },
      { "name": "Heat pump service" },
      { "name": "Furnace repair" },
      { "name": "Duct cleaning", "startingPrice": 299 },
      { "name": "Thermostat installation" },
      { "name": "Maintenance plans", "startingPrice": 15 },
      { "name": "Indoor air quality" }
    ],
    "licences": [
      { "label": "Arizona ROC", "number": "ROC 999001" },
      { "label": "Arizona ROC (dual)", "number": "ROC 999002" }
    ],
    "insured": true,
    "yearFounded": 2011,
    "emergency247": true,
    "testimonials": [
      { "quote": "AC quit in July. They were here in two hours and had it running before dinner.", "name": "Marco R.", "location": "Tempe, AZ" },
      { "quote": "They talked us out of a full replacement we did not need. Rare honesty.", "name": "Jen W.", "location": "Scottsdale, AZ" },
      { "quote": "Fast, friendly, fair.", "name": "Al K." },
      { "quote": "The maintenance plan has paid for itself. They catch small problems before the summer heat turns them into big ones, and the techs always explain what they found and show us photos.", "name": "Rosa T.", "location": "Mesa, AZ" },
      { "quote": "Clean install, great crew, and they registered the warranty for us.", "name": "Dev P.", "location": "Chandler, AZ" }
    ],
    "photos": [
      { "url": "https://picsum.photos/seed/desert-1/1200/900", "alt": "New condenser unit on a concrete pad", "width": 1200, "height": 900, "caption": "Condenser replacement" },
      { "url": "https://picsum.photos/seed/desert-2/1200/900", "alt": "Technician checking refrigerant pressure", "width": 1200, "height": 900 },
      { "url": "https://picsum.photos/seed/desert-3/1200/900", "alt": "Smart thermostat on a hallway wall", "width": 1200, "height": 900, "caption": "Smart thermostat" },
      { "url": "https://picsum.photos/seed/desert-4/1200/900", "alt": "Clean air ducts after service", "width": 1200, "height": 900 }
    ]
  },
  "copy": {
    "heroHeadline": "Cool again today, not next week",
    "heroSubheadline": "Fast AC and heating repair across the Valley from a local, licensed team.",
    "ctaText": "Book a visit",
    "sectionIntros": {
      "services": "Heating, cooling and air quality for Valley homes.",
      "faq": "Answers to the questions we hear most."
    },
    "serviceDescriptions": [
      { "service": "AC repair", "description": "Diagnosis and repair for all major AC brands." },
      { "service": "AC replacement", "description": "Right-sized systems with clear options and no pressure." },
      { "service": "Heat pump service", "description": "Tune-ups and repairs that keep heat pumps efficient." },
      { "service": "Furnace repair", "description": "Safe, fast furnace fixes for cold desert nights." },
      { "service": "Duct cleaning", "description": "Cleaner ducts for better airflow and less dust." },
      { "service": "Thermostat installation", "description": "Smart and programmable thermostats set up for you." },
      { "service": "Maintenance plans", "description": "Seasonal check-ups with priority booking." },
      { "service": "Indoor air quality", "description": "Filters, purifiers and humidity control." }
    ],
    "faq": [
      { "question": "Can you come out for an emergency?", "answer": "Yes. Call any time, day or night, and we will get a technician on the way." },
      { "question": "Can you service any brand?", "answer": "We repair and maintain all major brands of air conditioners, heat pumps and furnaces." },
      { "question": "Should I repair or replace?", "answer": "We will show you both options with honest pros and cons, then you decide." }
    ]
  },
  "layout": [
    { "id": "hero", "variant": "centered" },
    { "id": "services", "variant": "compact" },
    { "id": "trust", "variant": "light" },
    { "id": "testimonials", "variant": "masonry" },
    { "id": "gallery", "variant": "grid" },
    { "id": "serviceArea", "variant": "split" },
    { "id": "faq", "variant": "open" },
    { "id": "contact", "variant": "card" }
  ],
  "theme": { "palette": "blue-yellow", "font": "sturdy" }
}
```

`fixtures/cleaning-minimal.json`:

```json
{
  "facts": {
    "businessName": "Mop",
    "trade": "cleaning",
    "phone": "+12085550107",
    "email": "hi@mop.example.com",
    "location": { "city": "Boise", "state": "ID" },
    "serviceArea": { "places": ["Boise"] },
    "services": [{ "name": "House cleaning" }, { "name": "Move-out cleaning" }]
  },
  "copy": {
    "heroHeadline": "Clean homes",
    "heroSubheadline": "Careful cleaners for busy Boise households.",
    "ctaText": "Book",
    "serviceDescriptions": [
      { "service": "House cleaning", "description": "Weekly or one-off." },
      { "service": "Move-out cleaning", "description": "Get your deposit back." }
    ]
  },
  "layout": [
    { "id": "hero", "variant": "photo" },
    { "id": "trust", "variant": "light" },
    { "id": "services", "variant": "cards" },
    { "id": "testimonials", "variant": "grid" },
    { "id": "gallery", "variant": "grid" },
    { "id": "about", "variant": "plain" },
    { "id": "serviceArea", "variant": "split" },
    { "id": "faq", "variant": "accordion" },
    { "id": "contact", "variant": "card" }
  ],
  "theme": { "palette": "green-amber", "font": "clean" }
}
```

`fixtures/electrical-xss.json`:

```json
{
  "facts": {
    "businessName": "<img src=x onerror=alert(1)>",
    "trade": "electrical",
    "phone": "+13035550126",
    "email": "owner@example.com",
    "location": {
      "streetAddress": "<svg onload=alert(1)>",
      "city": "\"><script>alert(1)</script>",
      "state": "CO",
      "postalCode": "80202"
    },
    "serviceArea": {
      "places": ["</li><script>alert(1)</script>", "' onmouseover='alert(1)"],
      "note": "<a href=\"javascript:alert(1)\">x</a>"
    },
    "hours": [{ "days": ["Monday"], "opens": "08:00", "closes": "17:00" }],
    "services": [
      { "name": "<script>alert(1)</script>", "startingPrice": 99 },
      { "name": "\" autofocus onfocus=\"alert(1)" }
    ],
    "licences": [{ "label": "\"><iframe src=javascript:alert(1)>", "number": "</style><script>x</script>" }],
    "insured": true,
    "yearFounded": 2005,
    "emergency247": false,
    "testimonials": [
      { "quote": "</script><script>alert(1)</script><!--", "name": "<b onclick=alert(1)>Bo</b>", "location": "<!-- -->" }
    ],
    "heroPhoto": { "url": "https://images.example.com/hero.jpg?a=1&b=\"x\"", "alt": "\" onerror=\"alert(1)", "width": 1600, "height": 900 },
    "photos": [
      { "url": "https://images.example.com/p.jpg", "alt": "<script>alert(1)</script>", "width": 1200, "height": 900, "caption": "<img src=x onerror=alert(1)>" }
    ],
    "socialLinks": [{ "network": "facebook", "url": "https://www.facebook.com/?q=<script>" }]
  },
  "copy": {
    "heroHeadline": "<script>alert(document.domain)</script>",
    "heroSubheadline": "\" autofocus onfocus=\"alert(document.cookie)",
    "ctaText": "<a href=javascript:x>",
    "about": "</p><img src=x onerror=alert(document.cookie)>",
    "sectionIntros": { "services": "<style>body{display:none}</style>", "faq": "]]><!--<script>alert(document.domain)</script>" },
    "serviceDescriptions": [
      { "service": "<script>alert(1)</script>", "description": "<iframe srcdoc=\"<script>alert(document.domain)</script>\"></iframe>" },
      { "service": "\" autofocus onfocus=\"alert(1)", "description": "{{constructor.constructor('alert(document.domain)')()}}" }
    ],
    "faq": [
      { "question": "</summary><script>alert(document.domain)</script>", "answer": "</script><script>alert(document.domain)</script>" }
    ]
  },
  "layout": [
    { "id": "hero", "variant": "photo" },
    { "id": "trust", "variant": "band" },
    { "id": "services", "variant": "compact" },
    { "id": "testimonials", "variant": "grid" },
    { "id": "gallery", "variant": "grid" },
    { "id": "about", "variant": "plain" },
    { "id": "serviceArea", "variant": "split" },
    { "id": "faq", "variant": "accordion" },
    { "id": "contact", "variant": "card" }
  ],
  "theme": { "palette": "blue-yellow", "font": "sturdy" }
}
```


- [ ] **Step 5: Write the extreme-fixture generator and run it**

`scripts/make-extreme-fixture.ts`:

```ts
// Writes fixtures/roofing-extreme.json: every owner and AI text field at its schema maximum,
// every list at its maximum count, plus long unbroken words (the headline, and upper-case ones as
// the first place, service, reviewer and licence number: capitals are the widest letters).
// Deterministic: same bytes every run.
// Run: node scripts/make-extreme-fixture.ts
import { writeFileSync } from "node:fs";

// No claim words (see packages/site-schema/src/claims.ts): "insurance" is backed by insured and
// "free" by freeEstimates, both true below.
const WORDS = (
  "storm hail wind shingle metal tile slate flashing gutter downspout underlayment ridge vent decking " +
  "inspection estimate insurance claim replacement repair leak attic ventilation siding skylight chimney " +
  "valley drip edge fascia soffit crew careful honest neighborly thorough reliable"
).split(" ");

/** Exactly `length` characters of words (no digits), starting with `start`, never ending in a space. */
function fill(length: number, start = "", seed = 0): string {
  const words = [...WORDS.slice(seed % WORDS.length), ...WORDS.slice(0, seed % WORDS.length)];
  let out = start;
  for (let i = 0; out.length < length; i++) {
    const word = words[i % words.length] ?? "x";
    out = out ? `${out} ${word}` : word.charAt(0).toUpperCase() + word.slice(1);
  }
  out = out.slice(0, length);
  return out.endsWith(" ") ? `${out.slice(0, -1)}x` : out;
}

function exact(value: string, length: number): string {
  if (value.length !== length) throw new Error(`${JSON.stringify(value)} is ${value.length} chars, expected ${length}`);
  return value;
}

const letter = (i: number) => String.fromCharCode(65 + i);
const times = <T>(n: number, make: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => make(i));
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const NETWORKS = ["facebook", "instagram", "google", "yelp", "nextdoor", "youtube", "linkedin"];

const services = times(12, (i) => ({
  name: i === 0 ? exact("HAILSTORMDAMAGEINSPECTIONANDREROOFINGJOB", 40) : fill(40, `Service ${letter(i)}`, i),
  startingPrice: 100000,
}));

const doc = {
  facts: {
    businessName: exact("Longhorn Storm Restoration Roofing, Gutters, Siding & Window", 60),
    trade: "roofing",
    phone: "+12145550163",
    email: "estimates.and.insurance.claims.department@longhornstormrestoration.example.com",
    location: {
      streetAddress: fill(80, "Suite Four Hundred, Longhorn Storm Restoration Plaza,", 3),
      city: fill(40, "North Richland Hills", 5),
      state: "TX",
      postalCode: "76180",
    },
    serviceArea: {
      places: times(30, (i) => (i === 0 ? exact("NORTHRICHLANDHILLSWATAUGAHALTOMCITYAREAS", 40) : fill(40, `Place ${letter(i)}`, i))),
      note: fill(80, "Within two hours of Dallas", 7),
    },
    hours: DAYS.map((day) => ({ days: [day], opens: "06:00", closes: "21:30" })),
    services,
    licences: times(5, (i) => ({
      label: fill(40, `Licence ${letter(i)}`, i),
      number: i === 0 ? exact("RCATREGISTRATIONNUMBER00000001", 30) : `RCAT-${"X".repeat(25)}`,
    })),
    insured: true,
    yearFounded: 1850,
    emergency247: true,
    freeEstimates: true,
    testimonials: times(12, (i) => ({
      quote: fill(320, "", i),
      name: i === 0 ? exact("MAXIMILIANALEXANDERVONHOHENZOLLERNSMITHS", 40) : fill(40, `Reviewer ${letter(i)}`, i),
      location: fill(40, "Fort Worth", i),
    })),
    heroPhoto: { url: "https://picsum.photos/seed/longhorn-hero/2400/1350", alt: fill(125, "Crew installing", 1), width: 2400, height: 1350 },
    photos: times(12, (i) => ({
      url: `https://picsum.photos/seed/longhorn-${i + 1}/1200/900`,
      alt: fill(125, "Photo of", i),
      width: 1200,
      height: 900,
      caption: fill(80, "Caption", i),
    })),
    socialLinks: NETWORKS.map((network) => ({
      network,
      url: `https://www.${network}.com/longhorn-storm-restoration-roofing-gutters-siding-and-windows`,
    })),
  },
  copy: {
    heroHeadline: exact("Unbelievablyweathertightroofreplacements for every hailstorm across North Texas!", 80),
    heroSubheadline: fill(160, "", 2),
    ctaText: exact("Schedule a free estimate", 24),
    about: fill(480, "", 4),
    sectionIntros: Object.fromEntries(["services", "gallery", "faq", "contact"].map((key, i) => [key, fill(140, "", i)])),
    serviceDescriptions: services.map((service, i) => ({ service: service.name, description: fill(160, "", i) })),
    faq: times(8, (i) => ({ question: `${fill(79, "", i)}?`, answer: fill(320, "", i + 3) })),
  },
  layout: [
    { id: "hero", variant: "photo" },
    { id: "trust", variant: "band" },
    { id: "services", variant: "cards" },
    { id: "testimonials", variant: "masonry" },
    { id: "gallery", variant: "grid" },
    { id: "about", variant: "plain" },
    { id: "serviceArea", variant: "split" },
    { id: "faq", variant: "accordion" },
    { id: "contact", variant: "card" },
  ],
  theme: { palette: "charcoal-red", font: "friendly" },
};

writeFileSync(new URL("../fixtures/roofing-extreme.json", import.meta.url), `${JSON.stringify(doc, null, 2)}\n`);
console.log("wrote fixtures/roofing-extreme.json");
```


Run: `node scripts/make-extreme-fixture.ts && shasum -a 256 fixtures/roofing-extreme.json`
Expected: `wrote fixtures/roofing-extreme.json` and `2ee668d2d6a52c25dddcfc2460c097c9b8e83a828274d487deaebc3a70f9b83f  fixtures/roofing-extreme.json` (498 lines). A different hash means the script was copied wrongly.

- [ ] **Step 6: Write the fixture loader**

`fixtures/index.ts`:

```ts
import { readFileSync } from "node:fs";
import type { SiteDocumentInput } from "@asksite/site-schema";
import { render } from "@asksite/renderer";

/** Sample trades businesses. Each is a SiteDocument JSON file in this folder. */
export const FIXTURES = ["plumber-austin", "hvac-phoenix", "roofing-extreme", "cleaning-minimal", "electrical-xss"] as const;
export type FixtureName = (typeof FIXTURES)[number];

/** Placeholder form endpoint for fixtures; the real one arrives with plan 2. */
export const FIXTURE_FORM_ACTION = "https://forms.example.com/submit";

export function loadFixture(name: FixtureName): SiteDocumentInput {
  return JSON.parse(readFileSync(new URL(`./${name}.json`, import.meta.url), "utf8")) as SiteDocumentInput;
}

/** The shared stylesheet compiled by `pnpm build:css`. */
export function loadStylesheet(): string {
  return readFileSync(new URL("../packages/renderer/styles/site.css", import.meta.url), "utf8");
}

export function renderFixture(name: FixtureName, stylesheet: string = loadStylesheet()): string {
  return render(loadFixture(name), { stylesheet, formAction: FIXTURE_FORM_ACTION });
}
```


- [ ] **Step 7: Run the whole suite and the typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: `Snapshots  5 written`, `Test Files  22 passed (22)`, `Tests  303 passed (303)`; typecheck exits 0. The first run writes `fixtures/golden/<name>.html` (5 files). Open two of them and read the markup before committing: they are the reference every later change is diffed against. A second `pnpm test` must pass without writing snapshots.

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml fixtures/index.ts fixtures/plumber-austin.json fixtures/hvac-phoenix.json fixtures/cleaning-minimal.json fixtures/electrical-xss.json fixtures/roofing-extreme.json fixtures/golden scripts/make-extreme-fixture.ts packages/renderer/test/fixtures.test.ts packages/renderer/test/xss.test.ts
git commit -m "Add golden fixtures"
```

---
### Task 16: Render-a-fixture script

**Files:**
- Modify: `package.json` (adds the `render` script)
- Create: `scripts/render-fixture.ts`
- Test: `scripts/render-fixture.test.ts`

**Interfaces:**
- Consumes: `FIXTURES`, `renderFixture`, `type FixtureName` (Task 15).
- Produces: `renderFixturesToDir(names: readonly string[], outDir: URL): string[]` (throws `Unknown fixture: …`); CLI `pnpm render [name …]` → `out/<name>.html` with the real stylesheet inlined (all fixtures when no name is given). `out/` is gitignored. The test writes into `mkdtemp` folders and deletes every one of them in `afterAll`, so `pnpm test` leaves nothing in the system temp folder.

- [ ] **Step 1: Add the script entry**

`package.json`:

```json
{
  "name": "asksite",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.33.0",
  "engines": {
    "node": ">=24.8.0"
  },
  "scripts": {
    "build:css": "pnpm --filter @asksite/renderer run build:css",
    "typecheck": "tsc -p .",
    "test": "pnpm build:css && vitest run",
    "render": "pnpm build:css && node scripts/render-fixture.ts"
  },
  "devDependencies": {
    "@asksite/renderer": "workspace:*",
    "@asksite/site-schema": "workspace:*",
    "@types/node": "24.13.6",
    "html-validate": "11.16.0",
    "typescript": "7.0.2",
    "vitest": "5.0.1"
  }
}
```


- [ ] **Step 2: Write the failing test**

`scripts/render-fixture.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { renderFixturesToDir } from "./render-fixture.ts";

// Every folder this test creates is removed afterwards, so runs leave nothing in the temp folder.
const made: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "asksite-render-"));
  made.push(dir);
  return pathToFileURL(`${dir}/`);
};
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe("renderFixturesToDir", () => {
  it("writes a complete page with the real stylesheet inlined", () => {
    const [file] = renderFixturesToDir(["cleaning-minimal"], tempDir());
    const html = readFileSync(file ?? "", "utf8");
    expect(file).toMatch(/cleaning-minimal\.html$/);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("tailwindcss v4.3.3");
  });

  it("renders every fixture when no names are given", () => {
    expect(renderFixturesToDir([], tempDir())).toHaveLength(5);
  });

  it("rejects an unknown fixture name", () => {
    expect(() => renderFixturesToDir(["nope"], tempDir())).toThrow("Unknown fixture: nope");
  });
});
```


- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm vitest run scripts/render-fixture.test.ts`
Expected: FAIL — `Cannot find module './render-fixture.ts'`.

- [ ] **Step 4: Write the implementation**

`scripts/render-fixture.ts`:

```ts
// Render fixtures to standalone .html files for eyeballing in a browser.
// Usage: pnpm render                    (all fixtures)
//        pnpm render plumber-austin     (one or more by name)
// Output: out/<name>.html (gitignored). Run `pnpm build:css` first; `pnpm render` does it for you.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FIXTURES, renderFixture, type FixtureName } from "../fixtures/index.ts";

const isFixture = (name: string): name is FixtureName => (FIXTURES as readonly string[]).includes(name);

/** Writes one .html file per fixture into `outDir` and returns the file paths. */
export function renderFixturesToDir(names: readonly string[], outDir: URL): string[] {
  const unknown = names.filter((name) => !isFixture(name));
  if (unknown.length > 0) throw new Error(`Unknown fixture: ${unknown.join(", ")}. Known: ${FIXTURES.join(", ")}`);
  const selected = names.length > 0 ? names.filter(isFixture) : [...FIXTURES];
  mkdirSync(outDir, { recursive: true });
  return selected.map((name) => {
    const file = new URL(`${name}.html`, outDir);
    writeFileSync(file, renderFixture(name));
    return fileURLToPath(file);
  });
}

if (import.meta.main) {
  const files = renderFixturesToDir(process.argv.slice(2), new URL("../out/", import.meta.url));
  for (const file of files) console.log(`wrote ${file}`);
}
```


- [ ] **Step 5: Run the suite, the typecheck and the script**

Run: `pnpm test && pnpm typecheck && pnpm render plumber-austin`
Expected: `Test Files  23 passed (23)`, `Tests  306 passed (306)`; typecheck exits 0; `find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'asksite-render-*' -newer package.json` prints nothing (the test removed its temp folders); the script prints `wrote /Users/ashir/Documents/workk2/web_maker/out/plumber-austin.html`. Open it with `open out/plumber-austin.html` and check it looks like a finished trades website.

- [ ] **Step 6: Commit**

```bash
git add package.json scripts/render-fixture.ts scripts/render-fixture.test.ts
git commit -m "Add render script"
```

---
### Task 17: Browser tests — axe, overflow, focus, zero JS, screenshots

**Files:**
- Modify: `package.json` (adds Playwright and axe; scripts `typecheck` (now also `e2e`), `test:e2e`, `e2e:install`, `check`)
- Create: `playwright.config.ts`, `e2e/tsconfig.json`, `e2e/screenshot.css`, `e2e/fixtures.spec.ts`
- Generate: `e2e/fixtures.spec.ts-snapshots/*.png` (20 baselines)

**Interfaces:**
- Consumes: `FIXTURES`, `loadStylesheet`, `renderFixture`, `type FixtureName` (Task 15).
- Produces: Playwright projects `chromium-390`, `chromium-1200`, `chromium-1920` (height 900) and `webkit-390` (height 844). For every fixture and project: zero serious/critical axe violations with tags `wcag2a wcag2aa wcag21a wcag21aa wcag22aa` (this turns on axe's WCAG 2.2 `target-size` rule, which is off by default) plus zero violations of any impact from the structure rules `region`, `heading-order` and the non-deprecated `landmark-*` rules, scanned twice: as loaded, and again with every `<details>` opened (axe skips closed `<details>` content); no sideways scrolling; only JSON-LD scripts and no `on*` attributes; and a full-page screenshot baseline. On the two phone projects also: no sideways scrolling at 320 px (WCAG 1.4.10), and Tabbing through the page never leaves the focused element entirely under the call bar (WCAG 2.4.11). Also: the FAQ accordion and the phone menu work with JavaScript disabled, XSS payloads never open a dialog, and four RED-proof tests show the contrast, overflow, landmark and focus gates can fail.
- Screenshot baselines are named `<fixture>-<project>-darwin.png`, so they are macOS-only; a Linux CI needs its own set. `e2e/screenshot.css` makes the sticky call bar static during full-page screenshots so it does not hide content in the baseline.

- [ ] **Step 1: Add the dependencies and install the browsers**

`package.json`:

```json
{
  "name": "asksite",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.33.0",
  "engines": {
    "node": ">=24.8.0"
  },
  "scripts": {
    "build:css": "pnpm --filter @asksite/renderer run build:css",
    "typecheck": "tsc -p . && tsc -p e2e",
    "test": "pnpm build:css && vitest run",
    "test:e2e": "pnpm build:css && playwright test",
    "e2e:install": "playwright install --only-shell chromium webkit",
    "render": "pnpm build:css && node scripts/render-fixture.ts",
    "check": "pnpm typecheck && pnpm test && pnpm test:e2e"
  },
  "devDependencies": {
    "@asksite/renderer": "workspace:*",
    "@asksite/site-schema": "workspace:*",
    "@axe-core/playwright": "4.13.0",
    "@playwright/test": "1.63.0",
    "@types/node": "24.13.6",
    "html-validate": "11.16.0",
    "typescript": "7.0.2",
    "vitest": "5.0.1"
  }
}
```


Run: `pnpm install && pnpm e2e:install`
Expected: `pnpm install` ends with `Done in …s`; `playwright install --only-shell chromium webkit` downloads Chrome Headless Shell 153.0.8010.12 (playwright chromium-headless-shell v1243), FFmpeg (v1011) and WebKit 26.6 (v2359) into `~/Library/Caches/ms-playwright` (about 45 s and 511 MB in the replay).

- [ ] **Step 2: Write the Playwright config, the screenshot style and the specs**

`playwright.config.ts`:

```ts
import { defineConfig, devices } from "@playwright/test";

// Phone, laptop and large desktop in Chromium, plus the phone width in WebKit (Safari's engine;
// iOS is most US mobile traffic). Screenshot baselines are per project and per OS.
const CHROMIUM_WIDTHS = [390, 1200, 1920] as const;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  reporter: "list",
  expect: { toHaveScreenshot: { animations: "disabled" } },
  projects: [
    ...CHROMIUM_WIDTHS.map((width) => ({
      name: `chromium-${width}`,
      use: { ...devices["Desktop Chrome"], viewport: { width, height: 900 } },
    })),
    { name: "webkit-390", use: { ...devices["Desktop Safari"], viewport: { width: 390, height: 844 } } },
  ],
});
```

`e2e/tsconfig.json`:

```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": { "lib": ["es2023", "dom", "dom.iterable"] },
  "include": [".", "../playwright.config.ts"]
}
```

`e2e/screenshot.css`:

```css
/* Applied only while taking full-page screenshots: the phone call bar is position:sticky,
   which would paint it over whatever sits at the bottom of the first screen. Static puts it
   at its natural place at the end of the page, so no content is hidden in the baseline. */
.sticky {
  position: static !important;
}
```

`e2e/fixtures.spec.ts`:

```ts
import { AxeBuilder } from "@axe-core/playwright";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { FIXTURES, loadStylesheet, renderFixture, type FixtureName } from "../fixtures/index.ts";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
// Best-practice rules for page structure: all content inside landmarks, headings in order,
// one main, no duplicate or nested landmarks. Any violation of these fails, whatever its impact.
const STRUCTURE_RULES = [
  "region",
  "heading-order",
  "landmark-one-main",
  "landmark-unique",
  "landmark-no-duplicate-banner",
  "landmark-no-duplicate-contentinfo",
  "landmark-no-duplicate-main",
  "landmark-banner-is-top-level",
  "landmark-contentinfo-is-top-level",
  "landmark-main-is-top-level",
];
const stylesheet = loadStylesheet();
const SCREENSHOT_CSS = fileURLToPath(new URL("./screenshot.css", import.meta.url));

// A 4x3 light-gray PNG. Every remote image is served from memory, so screenshots never
// depend on the network (a live image gave a steady pixel diff in earlier research).
const GRAY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEUlEQVR42mM4ffUhHDHg5AAASSceDT8mdlEAAAAASUVORK5CYII=", "base64");

async function open(page: Page, name: FixtureName): Promise<void> {
  await page.route(/^https?:\/\//, (route) =>
    route.request().resourceType() === "image"
      ? route.fulfill({ body: GRAY_PNG, contentType: "image/png" })
      : route.abort(),
  );
  await page.setContent(renderFixture(name, stylesheet), { waitUntil: "load" });
}

/** Serious/critical WCAG violations plus any structure-rule violation, as "rule: selectors" lines. */
async function axeProblems(page: Page): Promise<string[]> {
  const wcag = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const structure = await new AxeBuilder({ page }).withRules(STRUCTURE_RULES).analyze();
  return [...wcag.violations.filter((v) => v.impact === "serious" || v.impact === "critical"), ...structure.violations].map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`,
  );
}

const sidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

const isPhoneProject = (page: Page) => (page.viewportSize()?.width ?? 0) < 768;

/** Tabs through the whole page and lists every focused element that sits entirely under the call bar. */
async function focusHiddenByCallBar(page: Page): Promise<string[]> {
  const hidden: string[] = [];
  for (let step = 0; step < 60; step++) {
    await page.keyboard.press("Tab");
    const covered = await page.evaluate(() => {
      const focused = document.activeElement;
      const bar = document.querySelector('aside[aria-label="Call us"]');
      if (!(focused instanceof HTMLElement) || focused === document.body || !bar || bar.contains(focused)) return null;
      const covers = focused.getBoundingClientRect().top >= bar.getBoundingClientRect().top;
      return covers ? focused.id || (focused.textContent ?? "").trim().slice(0, 40) || focused.tagName : null;
    });
    if (covered) hidden.push(covered);
  }
  return hidden;
}

for (const name of FIXTURES) {
  test.describe(name, () => {
    test.beforeEach(async ({ page }) => {
      await open(page, name);
    });

    test("passes axe (WCAG 2.2 AA serious/critical, landmarks, heading order) with every <details> closed, then open", async ({ page }) => {
      const closed = await axeProblems(page);
      // Content inside a closed <details> is not rendered, so axe skips it: open them all and scan again.
      await page.evaluate(() => {
        for (const details of document.querySelectorAll("details")) {
          details.removeAttribute("name");
          details.open = true;
        }
      });
      expect({ closed, open: await axeProblems(page) }).toEqual({ closed: [], open: [] });
    });

    test("never scrolls sideways", async ({ page }) => {
      expect(await sidewaysScroll(page)).toBe(0);
    });

    test("reflows at 320 px without sideways scrolling (WCAG 1.4.10)", async ({ page }) => {
      test.skip(!isPhoneProject(page), "checked once per engine, in the phone projects");
      await page.setViewportSize({ width: 320, height: 800 });
      expect(await sidewaysScroll(page)).toBe(0);
    });

    test("keyboard focus is never hidden under the call bar (WCAG 2.4.11)", async ({ page }) => {
      test.skip(!isPhoneProject(page), "the call bar only shows below 768 px");
      expect(await focusHiddenByCallBar(page)).toEqual([]);
    });

    test("ships no JavaScript: only JSON-LD scripts, no event handlers", async ({ page }) => {
      const scriptTypes = await page.locator("script").evaluateAll((els) => els.map((el) => el.getAttribute("type")));
      expect(scriptTypes.every((type) => type === "application/ld+json")).toBe(true);
      const handlers = await page.evaluate(() =>
        [...document.querySelectorAll("*")].flatMap((el) => el.getAttributeNames().filter((n) => n.startsWith("on"))),
      );
      expect(handlers).toEqual([]);
    });

    test("matches the screenshot baseline", async ({ page }) => {
      await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: true, stylePath: SCREENSHOT_CSS });
    });
  });
}

test.describe("the gates can fail (RED proof)", () => {
  test("axe reports low-contrast text as serious", async ({ page }) => {
    await open(page, "plumber-austin");
    await page.addStyleTag({ content: ":root{--aw-color-text-muted:#BBBBBB}" });
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations.filter((v) => v.impact === "serious").map((v) => v.id)).toContain("color-contrast");
  });

  test("the sideways-scroll check sees a word that cannot wrap", async ({ page }) => {
    await open(page, "plumber-austin");
    await page.addStyleTag({ content: "body{overflow-wrap:normal!important}" });
    await page.locator("h1").evaluate((h1) => {
      h1.textContent = "W".repeat(300);
    });
    expect(await sidewaysScroll(page)).toBeGreaterThan(0);
  });

  test("axe reports content outside a landmark", async ({ page }) => {
    await open(page, "plumber-austin");
    await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", "<p>Outside every landmark</p>"));
    expect((await axeProblems(page)).map((line) => line.split(":")[0])).toContain("region");
  });

  test("the focus check sees a field hidden under a call bar that always sticks", async ({ page }) => {
    test.skip(!isPhoneProject(page), "the call bar only shows below 768 px");
    await open(page, "plumber-austin");
    await page.addStyleTag({ content: "aside{position:sticky!important}" });
    expect(await focusHiddenByCallBar(page)).not.toEqual([]);
  });
});

test.describe("with JavaScript disabled", () => {
  test.use({ javaScriptEnabled: false });

  test("the FAQ accordion is exclusive", async ({ page }) => {
    await open(page, "plumber-austin");
    const items = page.locator('details[name="faq"]');
    await expect(items.nth(0)).toHaveAttribute("open", "");
    await items.nth(1).locator("summary").click();
    await expect(items.nth(1)).toHaveAttribute("open", "");
    await expect(items.nth(0)).not.toHaveAttribute("open", "");
  });

  test("the phone menu opens and its links work", async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) >= 1024, "the menu is replaced by inline links on wide screens");
    await open(page, "plumber-austin");
    const menu = page.locator("header details");
    await menu.locator("summary").click();
    await expect(menu).toHaveAttribute("open", "");
    await menu.getByRole("link", { name: "FAQ" }).click();
    await expect(page).toHaveURL(/#faq$/);
  });
});

test("XSS payloads never execute", async ({ page }) => {
  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await open(page, "electrical-xss");
  for (const field of await page.locator("input:not([tabindex='-1']), select, textarea").all()) await field.focus();
  await page.mouse.move(10, 10);
  await page.locator("h1").hover();
  expect(dialogs).toEqual([]);
  expect(await page.title()).toBe("<img src=x onerror=alert(1)>");
  const ld = await page.locator('script[type="application/ld+json"]').first().textContent();
  expect(JSON.parse(ld ?? "{}").name).toBe("<img src=x onerror=alert(1)>");
});
```


- [ ] **Step 3: Run it and watch the screenshot tests fail**

Run: `pnpm test:e2e`
Expected: FAIL — `20 failed`, `24 skipped`, `104 passed`. Every failure reads `Error: A snapshot doesn't exist at …/e2e/fixtures.spec.ts-snapshots/<fixture>-<project>-darwin.png, writing actual.` All axe, overflow, reflow, focus, zero-JS, no-JS, XSS and RED-proof tests pass. The 24 skips are all at 1200 and 1920 px, where the phone call bar and the phone menu do not exist: the 320 px reflow and focus tests (5 fixtures × 2 each × 2 projects = 20), the focus RED proof (2) and the phone-menu test (2).

- [ ] **Step 4: Review the 20 new baselines by eye**

Run: `open e2e/fixtures.spec.ts-snapshots`
Check each image: nothing overflows the right edge, `roofing-extreme` wraps its long headline, names and the upper-case place chip without breaking the layout, `cleaning-minimal` shows only hero, services, "Service area" (no "& hours"), contact and footer, `electrical-xss` shows the payloads as plain text, and the 390 px shots end with the green/blue/red "Call" bar. If any image is wrong, fix the template, delete that PNG and rerun Step 3.

- [ ] **Step 5: Run the suite again and the typecheck**

Run: `pnpm test:e2e && pnpm typecheck`
Expected: `124 passed`, `24 skipped`, no failures; `tsc -p . && tsc -p e2e` exits 0.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml playwright.config.ts e2e/tsconfig.json e2e/screenshot.css e2e/fixtures.spec.ts e2e/fixtures.spec.ts-snapshots
git commit -m "Add browser tests"
```

---
### Task 18: Full verification, adversarial check, human review and push

**Files:**
- No new files. Nothing is committed in this task unless a check fails and is fixed.

**Interfaces:**
- Consumes: everything above.
- Produces: a pushed `plan1-renderer` branch and five rendered pages in `out/` for review.

- [ ] **Step 1: Run every check from clean**

Run: `pnpm check`
Expected: `tsc -p . && tsc -p e2e` exits 0; `Test Files  23 passed (23)`, `Tests  306 passed (306)`; `124 passed`, `24 skipped`; exit code 0.

- [ ] **Step 2: Adversarial check 1 — break escaping and prove the tests catch it**

Run:
```bash
sed -i '' 's/  return value.replace(\/\[&<>\]\/g, (c) => TEXT_ESCAPES\[c\] ?? c);/  return value;/' packages/renderer/src/escape.ts
git diff --stat -- . ':(exclude)docs'
pnpm vitest run packages/renderer/test/xss.test.ts packages/renderer/test/escape.test.ts
git checkout -- packages/renderer/src/escape.ts
git status --short -- . ':(exclude)docs'
```
Expected: `git diff --stat` shows only `packages/renderer/src/escape.ts | 2 +-`; the tests FAIL with `Tests  8 failed | 3 passed (11)` (including "every raw '<' in the page starts one of our own tags or our one comment", "creates no event-handler attributes, quoted or not" and "never renders a script URL in any attribute"); after `git checkout`, the last command prints nothing. (The pathspec leaves out the moderating session's `docs/` edits, which are not part of this branch.)

- [ ] **Step 3: Adversarial check 2 — build a class name by interpolation and prove the drift check catches it**

Run:
```bash
sed -i '' 's/list: "columns-1 gap-6 sm:columns-2 lg:columns-3"/list: `columns-1 gap-6 sm:columns-2 lg:columns-${3}`/' packages/renderer/src/sections/testimonials.ts
git diff --stat -- . ':(exclude)docs'
pnpm test
git checkout -- packages/renderer/src/sections/testimonials.ts
git status --short -- . ':(exclude)docs'
```
Expected: the diff shows only `packages/renderer/src/sections/testimonials.ts | 2 +-`; `pnpm test` FAILS with `Tests  3 failed | 303 passed (306)` and `"lg:columns-3"` listed as missing from the compiled CSS (the output HTML is unchanged, so only the drift tests catch it); after `git checkout`, the last command prints nothing.

- [ ] **Step 4: Adversarial check 3 — lower a palette's contrast and prove the AA test catches it**

Run:
```bash
sed -i '' 's/textMuted: "#4B5563"/textMuted: "#9CA3AF"/' packages/renderer/src/theme.ts
pnpm vitest run packages/renderer/test/theme.test.ts
git checkout -- packages/renderer/src/theme.ts
git status --short -- . ':(exclude)docs'
```
Expected: FAIL with `Tests  2 failed | 68 passed (70)` ("textMuted on page" and "textMuted on white card"); after `git checkout`, the last command prints nothing.

- [ ] **Step 5: Confirm the tree is back to green**

Run: `pnpm test && git status --short -- . ':(exclude)docs'`
Expected: `Tests  306 passed (306)` and no output from `git status`.

- [ ] **Step 6: Render every fixture for human review**

Run: `pnpm render && open out/plumber-austin.html out/hvac-phoenix.html out/roofing-extreme.html out/cleaning-minimal.html out/electrical-xss.html`
Expected: five `wrote …/out/<name>.html` lines, then the pages open in the default browser. Check each at phone width (browser dev tools, 390 px) and desktop width: tap targets are comfortable, the call button is always reachable, text never runs off screen, the FAQ opens one answer at a time, the menu opens and its links jump to sections, and `electrical-xss` shows no alert. Report anything that looks wrong before pushing.

- [ ] **Step 7: Check commit identity and messages before pushing**

Run:
```bash
git log --oneline main..plan1-renderer | wc -l
git log --format='%an <%ae>|%cn <%ce>' main..plan1-renderer | grep -v '^sydashir <meetashirr@gmail.com>|sydashir <meetashirr@gmail.com>$' && echo "WRONG IDENTITY" || echo "identity ok"
git log --format=%B main..plan1-renderer | grep -iE 'co-authored|generated with|claude|anthropic' && echo "AI ATTRIBUTION FOUND" || echo "no attribution"
git log --format=%s main..plan1-renderer | awk 'NF>3' | grep . && echo "MESSAGE OVER 3 WORDS" || echo "messages ok"
```
Expected: `17`, then `identity ok`, `no attribution` and `messages ok`. Any offending commit is printed above its warning; if one appears, stop and report it to the moderating session instead of pushing (rewriting history is its decision).

- [ ] **Step 8: Push the branch as sydashir, then restore the other account**

Run:
```bash
gh auth switch --user sydashir
gh auth status --active --hostname github.com --json hosts --jq '.hosts["github.com"][0].login'
git push -u origin plan1-renderer
gh auth switch --user dev778d
gh auth status --active --hostname github.com --json hosts --jq '.hosts["github.com"][0].login'
```
Expected: the first status line prints `sydashir`; the push ends with `branch 'plan1-renderer' set up to track 'origin/plan1-renderer'.`; the last status line prints `dev778d`. The status command prints only the login, never a token. If the push fails, still run `gh auth switch --user dev778d` before doing anything else.

- [ ] **Step 9: Hand back**

Tell the moderating session: the branch name, the commit list (`git log --oneline main..plan1-renderer` shows 17 commits), the three test totals from Step 1, the Step 7 results, and anything from Step 6 that looked wrong. Also pass on two hand-offs for plan 2: send `X-Robots-Tag: noindex` from the Worker until a site is verified, and put the site id in the per-render `formAction` URL. The moderating session updates `docs/session.md` and `docs/journal.md` and decides when to merge to `main`.

---

## Verification record (how this plan was checked before handing it over)

- Every file in this plan was written and run in a scratch copy, then the plan was replayed task by task into a fresh git repository under `/private/tmp/…/scratchpad/plan1-fix/replay/` with a harness that, for each task, wrote the tests, ran the red command (it failed every time for the stated reason: the module under test did not exist yet), wrote the implementation, ran the green commands (all passed with the counts stated in each task), staged exactly the listed paths and confirmed `git status --porcelain` showed nothing untracked or unstaged. The replay stages instead of committing (the review session may not commit), so the commit steps themselves were not run; the staging lists were. All 17 tasks passed on Node 25.6.1 with pnpm 10.33.0.
- Task 18 Steps 1–6 were run in that replay with an uncommitted `docs/` edit and an untracked `docs/superpowers/` file present, as in the real repo: every expected output matched and the pathspec kept `docs/` out of every git check. The Step 7 commands were checked read-only against this repo's real history (`2c99ebe..main`: `identity ok`, `no attribution`, `messages ok`) and against a forged bad author, a `Co-Authored-By: Claude` trailer and a four-word subject (each printed its warning). The pathspec commands were also run read-only in the real repo and printed nothing.
- Red proofs for the review fixes, beyond the per-task red runs: with `escapeText` disabled the new "quoted or not" event-handler test fails; with the old attribute-name regex, the old three URL attributes and no forbidden-attribute list, 3 `html.test.ts` tests fail; with the chip `max-w-full wrap-anywhere` removed, the 320 px reflow test fails for `roofing-extreme` in Chromium and WebKit (53 px); an axe probe with low-contrast text in FAQ answers 2–4 of `plumber-austin` reported nothing with the `<details>` closed and `color-contrast` (3 nodes) once opened; without the `focus-outside:static` rule WebKit left the contact fields under the call bar in all five fixtures (WebKit ignores `scroll-padding` and `scroll-margin` when it scrolls a focused field into view; the old `scroll-pb-24` protected Chromium only, so it was replaced).
- Measured in the replay: compiled stylesheet 25,036 B raw / 5,536 B `gzip -9`; rendered pages 37–94 KB raw / 8–13 KB gzip; screenshot baselines about 10 MB in total; e2e run about 50–105 s with 6 workers. The e2e suite passed three times in a row against the same baselines.
- Also run on Node 24.21.0 LTS: typecheck, all 306 unit tests, the extreme-fixture generator (same hash) and all 124 browser tests.
- Facts checked on 2026-09-23: Vitest 5.0.1 `engines.node` (`npm view`); nvm present at `~/.nvm/nvm.sh` but not loaded by zsh; California B&P Code §7071.13 text; Google's FAQ rich-result removal notice (both linked in Decisions 7 and 8); axe-core 4.13.0 (bundled by @axe-core/playwright 4.13.0) has every structure rule id used in Task 17 and marks `landmark-complementary-is-top-level` deprecated, so it is not used; Tailwind 4.3.3 emits `.wrap-anywhere` and the `@custom-variant focus-outside` rule.

## Known limits (not verified, or deliberately out of scope)

- Real iPhone Safari was not tested; WebKit is exercised at 390 px and 320 px through Playwright's desktop WebKit build, where Tab skips links (it reached `<summary>` and form fields only in the replay), so link focus under the call bar is proven in Chromium only. Windows and Android font rendering were not checked, and the screenshot baselines are macOS-only.
- No CI workflow: the brief asks for a "test/CI check" and the class-drift check is a Vitest test that `pnpm test` and `pnpm check` run. A GitHub Actions workflow could not be run from this Mac (no Linux run; screenshot baselines are darwin-only), so it is left for plan 2, which sets up deployment. sydashir's token does have the `workflow` scope.
- The claim checker is word lists: it catches the usual phrasings, not every paraphrase ("our crew has decades…" is caught, "we have been at this a long while" is not). Plan 3's prompt should state the same rules, and plan 4's approval screen shows the owner every sentence before publishing.
- Requiring every fact section in the layout means an owner cannot hide, say, their reviews by layout alone; the planned "hide section" editor feature will need an explicit flag.
- The contact form posts to the placeholder `https://forms.example.com/submit` until plan 2 supplies the real endpoint; honeypot effectiveness against real bots is untested.
- A business with no street address gets valid schema.org `LocalBusiness` data, but Google requires `address` for its local business feature.
- Whether the full MIT licence texts (not only the copyright notices, which every page now carries) must travel inside each published page is a licensing question for the user; `THIRD_PARTY_NOTICES.md` covers the repository.
- Seen while reviewing the WebKit 390 px baseline, not fixed (pre-existing, outside the review findings): WebKit draws the native `<select>` in the contact form at its own height (about 24 px) instead of the 48 px `min-h-12`; it still passes axe `target-size`. `appearance-none` plus a drawn arrow would fix it.
