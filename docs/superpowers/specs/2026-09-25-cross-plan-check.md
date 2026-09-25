# Cross-plan check: Stage 0 against Plans 2B, 3 and 4 (2026-09-25)

This check was read-only: nothing was run, installed or built. Its binding sources are the design (`spec` = `docs/superpowers/specs/2026-09-24-system-design.md`, including M1–M6 at spec:1541–1549), `.superpowers/sdd/plan-decisions.md` (A1–A6) and `CLAUDE.md`. Line references: `plan2` = `2026-09-24-plan2-hosting-publish.md`, `plan3` = `2026-09-24-plan3-generation.md`, `plan4` = `2026-09-24-plan4-app.md`, all in `docs/superpowers/plans/`.

Four checkers sent in findings. I merged the duplicates and re-read both locations of every item. Items I could not confirm are listed at the end of section 1. Stage 0 (Plan 2 Tasks 1–6) is treated as fixed. At the time of the check, `plan2-hosting` was at `37d5d60 Add core basics` (Task 2), with Task 3 files uncommitted and `main` at `553adcf`. No fix below touches Plan 2 Tasks 1–6.

## 0. Problem first: the disk is full

`df -h` showed **146 MiB free (100%)** on `/System/Volumes/Data`. A later shell call failed with `zsh: no space left on device`. One checker also hit `ENOSPC` earlier. The Stage 0 run in progress can fail on this, and so can every worktree, `pnpm install`, wrangler state and Playwright download that the parallel plans need. Free space before anything else starts (section 3, item 1).

## 1. Confirmed mismatches (10)

### 1. [High] M6 is not applied in Plan 3: it still rewrites and checks `vitest.config.ts`

- **The conflict.** M6 (spec:1549) says Plan 3 drops its own `vitest.config.ts` rewrite and relies on Stage 0's generic globs. Stage 0 writes those globs at plan2:1994 and plan2:2002 (`WORKERD = ["packages/*/test/**/*.workerd.test.ts", "apps/*/test/**/*.workerd.test.ts"]`; unit `include` adds `"apps/*/test/**/*.test.ts"`), with unit `testTimeout: 30_000` at plan2:2006. plan2:2017 and plan2:79 say later plans never edit the file.
- **Where Plan 3 still edits it:**
  - plan3:129 and plan3:153 list the file as modified.
  - plan3:208–237 tell the implementer to add `apps/generator` globs and show a whole file. That file names only `apps/sites` and `apps/generator` and has no unit `testTimeout`, so pasting it would drop Plan 4's `apps/app`/`apps/admin` tests from the root run (plan4:41, plan4:74) and undo Plan 2 Decision 33.
  - plan3:243 greps for the literal `"apps/generator/test/**/*.test.ts"`. Stage 0's file does not contain it, so the check fails and pushes the implementer to edit the file.
  - plan3:465 (`git add … vitest.config.ts`), plan3:4980 (expects the file in the diff; count 66), plan3:5106 and plan3:5108 (conflict lists), and plan3:5310 ("Task 1 Step 3 edits both projects").
  - plan3:208 and plan3:5253 also call Stage 0's Vitest task "Task 1". It is Task 5 (plan2:1954).
- **Correct side:** Stage 0 plus M6.
- **Fix, in Plan 3:**
  1. plan3:129: delete `vitest.config.ts (apps/generator tests in Stage 0's "unit" and "workerd" projects), `.
  2. plan3:153: `- Modify: \`tsconfig.json\` (\`include\`), \`pnpm-lock.yaml\` (by \`pnpm install\`)`
  3. Replace plan3:208–237 (from "`vitest.config.ts` comes from Stage 0" through "this plan relies on it.") with: `` `vitest.config.ts` belongs to Stage 0 (Plan 2 Task 5) and this plan does not edit it (design M6). Its `unit` project already includes `packages/*/test/**/*.test.ts` and `apps/*/test/**/*.test.ts`, and its `workerd` project includes every `packages/*/test/**/*.workerd.test.ts` and `apps/*/test/**/*.workerd.test.ts`, so this plan's tests, including its six `*.workerd.test.ts` files (Decision 29), run unchanged. If the file has no `projects`, stop and ask the moderator. ``
  4. plan3:243: `grep -qF '"apps/*/test/**/*.test.ts"' vitest.config.ts && grep -qF '"apps/*/test/**/*.workerd.test.ts"' vitest.config.ts && grep -q 'projects:' vitest.config.ts && git diff --quiet main -- vitest.config.ts && echo VITEST_OK`
  5. plan3:465: remove `vitest.config.ts ` from the `git add`.
  6. plan3:4980: `Expected: the first command prints nothing; the second prints exactly \`package.json\`, \`pnpm-lock.yaml\` and \`tsconfig.json\`; the count is \`65\` (62 files under \`packages/generation\` and \`apps/generator\` plus those 3).`
  7. plan3:5106: `Plans 2 and 3 change \`package.json\` and \`tsconfig.json\`, and all three plans change \`pnpm-lock.yaml\`; merges into \`main\` are fast-forward only.`
  8. plan3:5108: covered by item 3 below.
  9. plan3:5253: replace `Plan 2's current Task 1` with `Plan 2's Task 5`.
  10. plan3:5310: replace the middle cell with `FIXED: six tests renamed \`*.workerd.test.ts\`; Stage 0's generic globs run them and \`vitest.config.ts\` is not edited (M6)`.
- **Also, in Plan 2 (outside Tasks 1–6):** plan2:7800: prefix the item with `Decided by M6 and applied in Plan 3 on 2026-09-25:`.

### 2. [Medium] Plan 3's local-D1 hooks allow 60 s, not Stage 0's 120 s

- **The conflict.** Plan 3 Decision 29 (plan3:79) says its workerd tests get "120 s per hook". Four `beforeAll` calls override that with an explicit `60_000`: plan3:2537, :2620, :2947 and :3418. Stage 0's `workerd` project sets `hookTimeout: 120_000` (plan2:2010), and every Stage 0 and Plan 2 harness hook passes `120_000` (plan2:2078, :2476, :2801 and 10 more). The reason is recorded at plan2:71 and plan2:81: the Mac runs at load averages of 150–300. Plan 3's own worker test also uses `120_000` (plan3:3854).
- **Correct side:** Stage 0.
- **Fix, in Plan 3:** at plan3:2537, :2620, :2947 and :3418, change `, 60_000);` to `, 120_000);`. Optionally do the same at plan3:3937, which starts workerd inside the test body with a 60 s test timeout.

### 3. [Medium] Plan 3 syncs with `main` by rebasing; CLAUDE.md says merge

- **The conflict.** plan3:5107 says `git rebase main` and plan3:5108 says `git rebase --continue`; plan3:5292 records "a rebase step". CLAUDE.md:42 says: "the branch first merges `main` into itself (message "Sync with main"), re-runs every check, and is re-reviewed". Plan 4 follows CLAUDE.md (plan4:31).
- **A second problem after a merge.** Task 14 Steps 2–4 set `BASE` to the parent of "Add generation scaffold" (plan3:4974, :4987, :5000). After a merge, `BASE..HEAD` and `git diff "$BASE" HEAD` would also include main's commits and files, so the Step 2 and Step 3 expectations would fail.
- **Correct side:** CLAUDE.md.
- **Fix, in Plan 3:**
  - plan3:5107: `1. Run \`git merge main -m "Sync with main"\` on \`plan3-generation\` (CLAUDE.md: merge, never rebase).`
  - plan3:5108: `2. If it stops on conflicts: in \`tsconfig.json\` or \`package.json\` keep both sides' entries (for example Plan 2's \`exclude\` next to this plan's \`apps/generator\` entries); for \`pnpm-lock.yaml\` run \`git checkout main -- pnpm-lock.yaml && pnpm install\`; \`git add\` the resolved files by name, then \`git commit --no-edit\`.`
  - plan3:4974, :4987 and :5000: `BASE=$(git merge-base main HEAD)`. This gives the same base as today when there was no sync.
  - plan3:4993: after "13 lines", add `(plus one \`Sync with main\` line if Step 8 merged)`.
  - plan3:5292: replace `a rebase step` with `a "Sync with main" merge step`.

### 4. [Medium] Plan 4's production step does not copy `DAILY_MODEL_LIMIT` from the generator

- **The conflict.** Plan 3 Task 15 Step 8 sets the generator's `DAILY_MODEL_LIMIT` together with the chosen model, for example 16 for Sonnet 5 (plan3:5229, :5232). Plan 3's cross-Worker test requires every Worker that declares the limit to match (`SHARED_VARS`, plan3:3728; test at plan3:3787). Plan 4 declares it in both apps (plan4:1377, :11130). But Plan 4 Task 27 Step 1 (plan4:15722) syncs only `MODEL_PROVIDER`/`MODEL_ID`, and plan4:11 says "a switch is two values". If the user picks any limit other than 8, Plan 4 Task 27 Step 2 (plan4:15726) fails `config.test.ts`.
- **Correct side:** Plan 3 and M1 (spec:1544).
- **Fix, in Plan 4:**
  - plan4:15722: replace `and \`MODEL_PROVIDER\`/\`MODEL_ID\` (admin) to the generator's values.` with `\`MODEL_PROVIDER\`/\`MODEL_ID\` (admin) and \`DAILY_MODEL_LIMIT\` (app and admin) to the generator's values (Plan 3 Task 15 Step 8 sets the limit with the model; Plan 3's cross-Worker test requires all three Workers to match).`
  - plan4:11: replace `For Plan 4 a switch is two values: \`MODEL_PROVIDER\` and \`MODEL_ID\` in \`apps/admin/wrangler.jsonc\` must name the same model as the generator` with `For Plan 4 a switch is three values: \`MODEL_PROVIDER\` and \`MODEL_ID\` in \`apps/admin/wrangler.jsonc\`, and \`DAILY_MODEL_LIMIT\` in \`apps/app\` and \`apps/admin\`, must equal the generator's`.
- Who makes the edit is decision 4 in section 2.

### 5. [Low] Plan 2's deploy task edits every Worker config but lists only one; Plan 3's commit can then be empty

- **The conflict.** Plan 2 Task 19's Files line (plan2:7602) lists only `apps/sites/wrangler.jsonc`. But Step 4 runs `sed … apps/*/wrangler.jsonc` for the domain and the D1 id (plan2:7639), and Step 13 commits `git add apps/*/wrangler.jsonc` (plan2:7773).
- **What breaks.** Plan 3 Task 15 Step 9.1 (plan3:5242) sets the same id in `apps/generator/wrangler.jsonc` and commits "Set database id". If Plan 2's step ran first (it is meant to run after Plans 2–4 merge, plan2:7599), there is nothing to commit and `git commit` exits non-zero. Plan 4 Task 27 Step 1 (plan4:15722) also sets the domain and id again.
- **Keep Plan 2's glob.** It is load-bearing: Step 4 runs `pnpm test`, and Plan 3's cross-Worker test needs the same id in every config.
- **Fix:**
  - plan2:7602: `- Modify: every \`apps/*/wrangler.jsonc\` (Step 4: the real domain and database id, which must stay equal across Workers); \`apps/sites/wrangler.jsonc\` also gets the sender name and the security.txt date`.
  - plan3:5242: start the item with `If Plan 2 Task 19 Step 4 already ran after this plan merged, its \`sed\` over every \`apps/*/wrangler.jsonc\` set this id and committed it: only run the config test.` Change the commit to `git diff --quiet -- apps/generator/wrangler.jsonc || { git add apps/generator/wrangler.jsonc && git commit -m "Set database id"; }`.
  - plan4:15722: add at the start `If Plan 2 Task 19 Step 4 ran after this plan merged, the domain and database id are already set in both files: check them and set the rest.`

### 6. [Low] Only the public Worker gets the chosen email sender name

- **The conflict.** Design §12.9 (spec:1454) treats the email brand as one user decision. Plan 2 applies `$BRAND` to `apps/sites` only (plan2:7640). Plan 4 ships `"MAIL_FROM": "Website team <hello@mail.asksite.example>"` (plan4:1373, :11127), and its Task 27 Step 1 replaces only the domain (plan4:15722). In production, lead emails would come from `$BRAND` and every other email from "Website team".
- **Fix, in Plan 4 (it owns these files):** add to plan4:15722: `Set the sender name in both \`MAIL_FROM\` values to the brand chosen in Plan 2 Task 19 (\`$BRAND\`, design §12.9), so every email carries one sender name.`

### 7. [Low] M4: Plan 3's test harness binds D1 with a different id

- **The conflict.** plan3:2481 (`startLocalD1`) uses `database_id: "00000000-0000-4000-8000-000000000001"`. M4 (spec:1547) says every local D1 binding uses `00000000-0000-0000-0000-000000000000`, and Stage 0's own harness does (plan2:2063). Plan 3 also contradicts itself: plan3:63 and plan3:5287 say the literal appears only in `apps/generator/wrangler.jsonc`. The change does not affect behaviour: each harness has its own in-memory D1 (plan3:2417).
- **Fix, in Plan 3:**
  - plan3:2481: use `"00000000-0000-0000-0000-000000000000"`.
  - plan3:63: replace `The literal appears once, in \`apps/generator/wrangler.jsonc\`:` with `Among Worker configs the literal appears once, in \`apps/generator/wrangler.jsonc\` (the test-only harness in \`test/support/d1.ts\` uses the same placeholder, M4):`.
  - plan3:5287: replace `the literal lives only in the generator's \`wrangler.jsonc\`` with `among Worker configs the literal lives only in the generator's \`wrangler.jsonc\``.

### 8. [Low] Plan 2 describes Plan 3's tsconfig setup with out-of-date text

- **The conflict.** plan2:70, Decision 22(b), says Plan 3 "adds `apps/*/src` and `apps/*/test` to the root `include`". plan2:7798 says "Plan 3 adds `packages/generation` to both tsconfig lists". Plan 3 actually names only `packages/generation/eval`, `apps/generator/src` and `apps/generator/test`, forbids `apps/*`, and adds nothing to `tsconfig.workers.json` (plan3:78, :202–205, :242). Plan 4 depends on that (plan4:41).
- **Correct side:** Plan 3.
- **Fix, in Plan 2 (text only; no task is affected):**
  - plan2:70: replace `and adds \`apps/*/src\` and \`apps/*/test\` to the root \`include\`` with `and adds only \`packages/generation/eval\`, \`apps/generator/src\` and \`apps/generator/test\` to the root \`include\` (Plan 3 Decision 28; never \`apps/*\`)`.
  - plan2:7798: replace `5 (\`tsconfig.workers.json\`; Plan 3 adds \`packages/generation\` to both tsconfig lists)` with `5 (\`tsconfig.workers.json\`; Plan 3 adds nothing to it and names only its own folders in the root \`include\`)`.

### 9. [Low] Plan 3's verification record still cites Plan 4's old limit of 30

- **The conflict.** plan3:5261 says Plan 4's draft configs fail with `[ 'admin', 'DAILY_MODEL_LIMIT', '30' ]`. Plan 4 now ships "8" in both apps (plan4:1377, :11130; decision 17 at plan4:65), per M1.
- **Fix, in Plan 3:**
  - plan3:5261: replace that sentence with `With the current Plan 4 configs (\`GENERATION_ENABLED\` "false", \`DAILY_MODEL_LIMIT\` "8", admin \`anthropic\`/\`claude-opus-5-5\`), Plan 4 decision 17 reports config.test.ts passing (M1).`
  - plan3:5298: replace `User and moderator: the design's 30 and Plan 4's configs` with `Decided by M1; Plan 4 ships "8" in apps/app and apps/admin`.

### 10. [Low] Plan 4 names amendments A1–A5, but A6 exists

- **The conflict.** plan4:15 says "the moderator's amendments A1–A5". A6 is recorded (plan-decisions.md:51), and Plan 4 relies on it (plan4:38).
- **Fix:** plan4:15: `A1–A6`.

### Checked and dropped (not mismatches)

- **`utcDayStart` defined again in Plan 3** (plan3:2739 vs Stage 0 plan2:820). It gives the same value for every non-negative time, it is internal (Plan 3's `index.ts` does not export it, plan3:3627), and no binding rule requires reusing it. Optional cleanup: import it from `@asksite/core`.
- **plan2:37 and plan2:79, "Plans 3 and 4 edit" the shared root files.** Plan 4 changes only `pnpm-lock.yaml` (plan4:20). This overstatement has no effect.
- **plan4:72 and plan4:93, "design §4.2 still types the field `number`".** This is still literally true (spec:766), so it is not stale.
- **M3 against Stage 0's `AdminSettings`.** This is real, but Stage 0 is fixed and the consumer already compensates, so it is decision 1 below.
- **Plan 4's consumed names.** I checked all 45 `@asksite/core` names and the 2 `@asksite/site-css` names from plan4:243–252, plus Plan 3's list at plan3:168, against Stage 0's text (plan2:239–2562): every one is exported there. Every Plan 1 name Plan 4 uses exists in `packages/site-schema/src` and `packages/renderer/src` today.

## 2. Decisions for the moderator and the user

**Needed before or during the parallel run**

1. **M3 against Stage 0's type.**
   - Evidence: plan2:1873 ships `AdminSettings.worstCaseDailyMicrousd: number`, while M3 (spec:1546) says `number | null`. The design text still says `number` too (spec:766, spec:1014). Plan 3 returns `number | null` (plan3:1757) and never uses `AdminSettings`. Plan 4 answers `SettingsView = Omit<AdminSettings, …> & { worstCaseDailyMicrousd: number | null }` (plan4:12876), which compiles with either core type.
   - Options:
     - (a) Accept `SettingsView` as the M3 implementation and fix the design text.
     - (b) After Stage 0 merges, make a one-line moderator edit to `packages/core/src/views.ts`.
     - (c) Amend Task 4's text before it runs (it has not run yet), which this check was told not to propose.
   - Recommendation: (b), together with the design text at spec:766 and spec:1014. It does not block anything, because Plan 4 compiles either way.
2. **Lifetime cap and first builds.**
   - Evidence: Plan 3 counts every generation of an owner against 20 (plan3:2810–2813, :2873–2883), as the design says. So an owner at the cap can never get a first draft for a second site, and publishing then refuses (plan4:98, :88, :60).
   - Options: (a) keep it; (b) do not count `kind = 'first'`; (c) at the cap, give first builds the template.
   - Recommendation: (b), decided now, while Plan 3 has not started. It changes INSERT_JOB and `generationAllowance`, the test at plan3:2664, the mutation at plan3:5027 and Plan 4 decision 40. First builds stay bounded by admin-only invites, and money stays bounded by the global daily model limit (M1).
3. **Who edits the three Workers' shared settings when the model, the limit or the on switch changes.**
   - Evidence: Plan 3 says the moderator changes `apps/app` and `apps/admin` in the same merge (plan3:5232, :5245). Plan 4 Task 27 says Plan 4 does it, "in the app, admin and generator together" (plan4:15722), but its own rules forbid editing `apps/generator` (plan4:20).
   - Recommendation: the moderator makes each change as one commit covering all three files, because the cross-Worker test needs them equal at every commit. Plan 4 Task 27 Step 1 only checks the values, and its "and generator" becomes "the moderator sets it in all three Workers in one commit (Plan 3 Task 15 Step 9.4)".
4. **Where the sessions run.** See section 3, item 4.

**Can wait (no plan text depends on these now)**

5. **Final model and limit** (M1: the user decides after the Plan 3 Task 15 eval; plan3:54, :5229–5232).
   - Recommendation: choose them together so the worst case stays at or under $11 a day (for example 16 for Sonnet 5), and turn generation on only after the key, the provider spend limit and the eval are all in place.
   - Also fix design §12.4 (spec:1447), which still tells the user "30 model calls per day (about $10 a day)"; it should be 8 ($10.65 on Opus 5.5). Mark the tags M1–M6 answered as decided: plan3:54, :59, :61, :63, :72; plan4:72, :92, :93.
6. **Local D1 errors under `pnpm dev`** (plan4:94: 5 of 7 runs failed).
   - Recommendation: Plan 2 Task 15 has not run, so add a note there naming the symptom (`SQLITE_BUSY_RECOVERY`, `D1_ERROR … internal error`) and the fix (restart). Move `pnpm dev` to one runtime later, after measuring. Production is not affected.
7. **CI does not check the two apps** (plan4:95; plan2:7412–7420 runs only the root `typecheck` and `test` plus e2e).
   - Recommendation: after Plan 4 merges, add the two `--filter` typechecks and the two `test:e2e` runs to `ci.yml` as a targeted edit.
8. **`pnpm dev` stops on an app that is not built yet** (plan4:97; plan2:6557–6567).
   - Recommendation: keep Plan 4's documented `--only sites,generator` workaround (plan4:40).
9. **Unify the two TypeScript setups** (plan2:70 "may schedule").
   - Recommendation: do not. The separation is deliberate: the Workers `URL` type clashes with Node's (plan2:53).
10. **Design changes to accept.** These are Plan 2 Decisions 2–6, 9, 10, 13, 15 and 24–33 (plan2:47, :7798) and Plan 4's list (plan4:96).
    - Recommendation: accept them all, and fold Plan 2's 24, 25, 28 and 29 and Plan 4's 1, 28 and 33 into the design text. Stage 0 already ships Plan 2 Decision 25's `LIMITS` key.
11. **Smaller product calls.** Recommended answer for each:
    - Email links: leave them out for v1 (plan2:63, plan4:61).
    - Spam leads: keep counting them toward the cap, hidden (plan2:7808).
    - A server-side reset of the "reviews are real" confirmation: no; keep the client-side reset (plan4:86).
    - HTTP 400 from a model host: keep treating it as `bad_request` (plan3:5280).
    - The 30–60 character headline target: accept (plan3:69).
    - The zone rate-limit rule: add it after Task 19 (plan2:7809).
12. **Plan 1 changes**, applied after Stage 0 merges (Stage 0 Task 1 is editing Plan 1's packages now), in one amendment:
    - Write the literal U+200D at `packages/site-schema/src/facts.ts:24` (the bytes are confirmed) as `‍`.
    - Add `seven days` and `days a week` to the round-the-clock pattern at `packages/site-schema/src/claims.ts:39` (the gaps are listed at plan3:5278).
    - Mark the slow axe test `test.slow()`.
    - Defer the phone `pattern` (it changes the golden files) and skip a separate property-test timeout, which plan2:81 already covers.
13. **The user's calls** (spec §12):
    - The domain, now: the Public Suffix List request takes weeks.
    - The email brand.
    - Workers Paid before the first owner.
    - Resend Pro before about 20 sites.
    - A real mailbox for `SUPPORT_EMAIL` (plan4:99).
    - The Access identity provider with MFA.
    - Owner edits: keep them strict for v1 (spec:1537).
    - Deploy `asksite-sites` alone as soon as the domain exists (plan2:7599). Its real-edge checks are the ones most likely to force changes.

## 3. What blocks starting Plans 2B, 3 and 4 in parallel

1. **The disk is full** (section 0). This blocks everything, including the Stage 0 run in progress.
2. **Stage 0 is not done or merged.** It is at Task 2 of 6, and `main` has none of it. Plans 3 and 4 branch from `main` only after Stage 0 has merged (plan3:25, :44; plan4:38, :188). Plan 2 hands over at plan2:2562. Stage 0 has to pass review and `main` has to fast-forward to `plan2-hosting` after Task 6. Plan 2B then continues on `plan2-hosting`.
3. **Plan 3's text must get fix 1 before its Task 1.** Otherwise Step 3's `VITEST_OK` check fails against Stage 0's file and pushes an edit that M6 forbids. Apply fixes 2 and 3 at the same time: they are cheap now, and Tasks 8 and 14 need them. Plan 4 needs no text change to start. Fixes 4–6 and 10 affect only its Task 27 and its preamble.
4. **Session layout.** Plan 2B hard-codes this folder: the leftover check at plan2:28–34, and `cd /Users/ashir/Documents/workk2/web_maker` at plan2:211, :6790, :7144 and :7613. Plans 3 and 4 use `git rev-parse --show-toplevel` (plan3:25, plan4:31).
   - Keep Plan 2B here.
   - Put the Plan 3 and Plan 4 worktrees **outside** `/Users/ashir/Documents/workk2/web_maker/`. Plan 2's leftover check and its suggested `pkill -f "/Users/ashir/Documents/workk2/web_maker/"` (plan2:28, :31; CLAUDE.md:48) match any path under that folder, so they would list, and could kill, the other plans' `wrangler`/`workerd` processes.
   - `main` is not checked out anywhere, so it can be fast-forwarded without checking it out: `git fetch . <branch>:main` refuses a non-fast-forward.
5. **Not blockers:**
   - M3: Plan 4 compiles either way.
   - Fixed ports: nothing clashes before Plan 4 Task 24/25, which needs Plan 2 merged first, and Plan 2 checks its ports before starting (plan2:6788).
   - Machine load: running three suites at once raises the timeout risk that Plan 2 Decisions 23 and 33 describe. Rerun a full-suite step that fails only on a timeout, as those decisions already allow.
