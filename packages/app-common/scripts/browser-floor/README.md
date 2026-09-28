# Browser floor check

The owner client must run on iOS/Safari 16.4 (`src/browser-floor.ts`, the one place the floor lives).
This checker reads the client's TypeScript program and fails on every runtime use of a platform API
that MDN's browser-compat-data (8.1.3, pinned) does not list as fully supported at that floor.

- Run: `pnpm check:floor` (root) or `pnpm --filter @asksite/app check:floor`. It runs `tsc` on
  `apps/app/tsconfig.floor.json` first, then `node scripts/check-browser-floor.ts <tsconfig>`.
- Exit codes: 0 nothing above the floor; 1 at least one use fails; 2 the program cannot be judged
  (usage error, or the program does not type-check: an unresolved type hides a use).
- Each failing line prints `file:line:col  kind  API  MDN key  (browser: version_added)`. Kinds: not
  supported, partial support (MDN `partial_implementation`), no MDN key (unmapped: fails, never
  skipped), and a `floor-ok` marker without a reason.
- To accept one finding: `// floor-ok: <reason>` at the end of its line, or alone on the line before.
  An empty reason accepts nothing and is itself a failure.
- Tests: `test/browser-floor-check.test.ts` runs the checker over `floor-fixtures/`. A fixture line
  that must fail carries `expect: <kind> <key>`; every other line must pass, so a miss and a false
  alarm both fail the test.

## Forms it judges (the closed list, p4-7-brief.md "DECIDED 2026-09-28")

Each form has a fixture line that fails the test when the checker misses it (fixture file and
export name):

| Form | Fixtures |
|---|---|
| Bare identifier: call, reference | baseline.ts `idle`; forms.ts `idleReference` |
| `window.X`, `globalThis.X`, `self.X` | forms.ts `viaWindow`, `viaGlobalThis`, `viaSelf`, `viaSelfStatic`, `newViaGlobalThis`; aliases.ts `viaWindow`, `viaGlobalThis` |
| Member by dot, `?.`, string-literal bracket | baseline.ts; aliases.ts `viaOptionalCall`, `viaBracket`, `viaConstKey`; forms.ts `viaOptionalBracket`, `viaInstanceBracket` |
| `new X()` (the constructor's own MDN entry too) | statics.ts `interfaceAndConstructor`, `newerConstructor` |
| `extends X`, instantiation expression | aliases.ts `ViaExtends`, `viaClassExpression`, `viaInstantiation`; statics.ts `ViaIteratorSubclass` |
| `instanceof X` | forms.ts `isHighlight` |
| `typeof X.y` reaches X (a bare `typeof X` is a feature test) | statics.ts `typeofReaches` (control `typeofBare`) |
| Instance members through the type: unions, generics, mixins, optional chaining | a-receivers.ts, b-generics.ts, c-mixins.ts |
| Destructuring declarations, parameters (with defaults), for-of, rest, array, nested, quoted or literal computed keys | destructuring.ts, "Declarations" |
| Destructuring ASSIGNMENTS, nested, with defaults, for-of heads | destructuring.ts, "Assignments" and the for-of lines |
| Shorthand property | aliases.ts `viaShorthand` (control `ownShorthand`) |
| Alias through a variable | aliases.ts `viaTypedAlias`, `viaUntypedAlias` |
| Alias through an import or re-export | alias-import.ts (6 lines); alias-source.ts `idle` |
| Statics of every typed array and of subclasses: the class's own entry first | statics.ts `fromFloat16`, `ofFloat16`, `bytesFloat16`, `protoFloat16`, `fromBase64`, `viaOwnSubclass`, `viaOwnTypedSubclass`; every other typed array passes (`int8` ... `bigUint64`) |

A for-of assignment head over an iterable that is not an array or a tuple (`for ({ x } of aSet)`) is
reported as `no MDN key  destructuring assignment  source not judged`: it fails, it is never skipped.

## Known limits

This is our own client code, not an attacker boundary. These forms are not judged here:

- Computed access: `globalThis[name]` or `X[key]` with a key typed `string`, a computed destructuring
  key of such a type, and `Reflect.get(X, "y")`. Covered only when the key's type is a string
  literal (`URL[key]` with `const key = "canParse"`, aliases.ts `viaConstKey`). Nothing else covers
  them.
- `eval`, `Function` and string code in `setTimeout`/`setInterval`: the code inside the string is not
  read. The owner app's planned policy (Task 14, `contentSecurityPolicy`: `script-src 'self'`, no
  `'unsafe-eval'`) blocks all of them at run time (MDN, CSP `script-src`), so such code cannot run at
  all. Nothing checks the code itself.
- `any`-typed receivers: `(URL as any).canParse`, a member read from `JSON.parse(...)` or from
  `Response.json()`. The receiver has no type to map, so the member passes. Nothing covers them (the
  repo has no lint rule against `any`; `strict` only stops an implicit `any`).
- CSS and HTML features: CSS properties and values, HTML elements and attributes (including JSX
  attributes such as `popover`), and DOM event names given as strings or React props
  (`addEventListener("scrollend")`, `onScrollEnd`). Partly covered: Tailwind CSS v4 targets Safari 16.4
  (tailwindcss.com/docs/compatibility), and Vite 8 minifies CSS with Lightning CSS, which lowers some
  newer CSS syntax for `build.cssTarget` (defaults to `build.target`, which Task 14 is to set from
  `BROWSER_FLOOR_BUILD_TARGET`). That lowers syntax; it does not check for a property the floor lacks.
  Nothing checks the rest.

Also known, from the reviews (each fails loudly or is rare): a qualified name in a type-only heritage
clause (`interface X extends WebAssembly.Global {}`) is reported as unmapped; a `// floor-ok` marker
does not fit inside JSX; CSSOM properties written as `el.style.x` have no MDN key and are reported
as unmapped.

## Backstops (what else would catch a too-new API)

- Playwright's WebKit (1.63.0 ships WebKit 26.6, `playwright-core/browsers.json`) and the user's
  iPhone run CURRENT WebKit, not iOS 16.4. So neither the browser tests (e.g. Task 16's photo tests)
  nor the real-iPhone check (Task 27) catches a DOM API that is too new for the floor.
- Only two gates do:
  - the TypeScript lib gate, for ES built-ins: the client's typecheck config (planned in Task 14,
    `apps/app/tsconfig.client.json`) uses `lib: ["es2023", "dom", "dom.iterable"]`, so an ES built-in
    newer than ES2023 is a type error (TS2339). It says nothing about DOM APIs: `lib.dom` declares
    the newest ones;
  - this checker, for DOM and ES APIs alike. That is why the closed list above matters.

## Updating

- MDN data: bump `@mdn/browser-compat-data` on purpose (only its schema follows semver) and re-run
  the fixture test; a changed version shows up there.
- TypeScript: 7.0 ships no stable compiler API (`typescript/unstable/*`); 7.1 will ship a different
  one. A TypeScript bump breaks this checker loudly (the fixture test and the type-check gate), never
  silently.
