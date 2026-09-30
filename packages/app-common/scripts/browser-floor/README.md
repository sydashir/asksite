# Browser floor check

The owner client must run on iOS/Safari 16.4 (`src/browser-floor.ts`, the one place the floor lives).
This checker reads the client's TypeScript program. It fails on a runtime use of a platform API (one
that TypeScript's default lib files declare), in the forms listed below, that MDN's browser-compat-data
(8.1.3, pinned) does not list as fully supported at that floor. What it does not judge is listed
under "Known limits"; each says what else covers it, or that nothing does.

- Run: `pnpm check:floor` (root) or `pnpm --filter @asksite/app check:floor`. It runs `tsc` on
  `apps/app/tsconfig.floor.json` first, then `node scripts/check-browser-floor.ts <tsconfig>`.
- Exit codes: 0 nothing above the floor; 1 at least one use fails; 2 the program cannot be judged
  (usage error, or the program does not type-check: an unresolved type hides a use).
- Each failing line prints `file:line:col  kind  API  MDN key  (browser: version_added)`. Kinds: not
  supported, partial support (MDN `partial_implementation`), no MDN key (unmapped: fails, never
  skipped), and a `floor-ok` marker without a reason.
- To accept findings: `// floor-ok: <reason>` at the end of a line accepts every finding on that line
  (`either.bytes()` on a `Request | Response` gives two, and one marker accepts both); alone on a
  line (only comments beside it), it accepts every finding on the next line. A marker after code
  does not reach the next line. Between JSX children, where a `//` line is text that the page
  shows, write `{/* floor-ok: <reason> */}` the same way. An empty reason (or no colon) accepts
  nothing and is itself a failure. Markers are read from the text, so one in a string or in JSX text
  counts too: keep them in comments.
- Tests: `test/browser-floor-check.test.ts` runs the checker over `floor-fixtures/`. A fixture line
  that must fail carries `expect: <kind> <key>`; every other line must pass, so a miss and a false
  alarm both fail the test. `floor-fixtures/regex/` is checked at a floor below every regular
  expression feature the check detects (the `d` and `v` flags, lookbehind, modifiers), so each
  detection has a line that must fail. `floor-fixtures/comments/` holds a `floor-ok` line with 200
  block comments, which the command must finish within a time limit.

## Forms it judges (the closed list, p4-7-brief.md "DECIDED 2026-09-28")

Each form has a fixture line that fails the test when the checker misses it (fixture file and
export name):

| Form | Fixtures |
|---|---|
| Bare identifier: call, reference | baseline.ts `idle`; forms.ts `idleReference` |
| `window.X`, `globalThis.X`, `self.X` | forms.ts `viaWindow`, `viaGlobalThis`, `viaSelf`, `viaSelfStatic`, `newViaGlobalThis`; aliases.ts `viaWindow`, `viaGlobalThis` |
| Member by dot, `?.`, string-literal bracket (also `?.[...]` on a receiver that may be null or undefined) | baseline.ts; aliases.ts `viaOptionalCall`, `viaBracket`, `viaConstKey`; forms.ts `viaOptionalBracket`, `viaInstanceBracket`, `viaNullableBracket`, `viaRefBracket`, `viaNullableUnionBracket`, `viaNullableConstraintBracket` |
| `new X()`, also `new (X)()` and `new window["X"]()` (the constructor's own MDN entry too) | statics.ts `interfaceAndConstructor`, `newerConstructor`, `parenthesizedConstructor`, `parenthesizedWindowConstructor`, `bracketWindowConstructor`, `bracketGlobalThisConstructor` |
| `extends X`, instantiation expression | aliases.ts `ViaExtends`, `viaClassExpression`, `viaInstantiation`; statics.ts `ViaIteratorSubclass`, `ViaParenthesizedBase`, `ViaBracketBase` |
| `instanceof X` | forms.ts `isHighlight` |
| `typeof X.y` and `typeof X["y"]` reach X (their `y`, and a bare `typeof X`, are feature tests) | statics.ts `typeofReaches`, `typeofBracketReaches` (control `typeofBare`); aliases.ts `detected`, `detectedByBracket` |
| Instance members through the type: unions and intersections (also with our own type that declares the same member), generics, mixins, optional chaining | a-receivers.ts (`ownFirstIntersection`, `ownFirstUnion`), b-generics.ts, c-mixins.ts |
| Destructuring declarations, parameters (with defaults, also typed `X \| undefined`), for-of, rest, array, nested, quoted or literal computed keys | destructuring.ts, "Declarations" (`nullableWithDefault`) |
| Destructuring ASSIGNMENTS, nested, with defaults (also over an outer property that may be undefined), for-of heads | destructuring.ts, "Assignments" and the for-of lines |
| Shorthand property | aliases.ts `viaShorthand` (control `ownShorthand`) |
| Alias through a variable | aliases.ts `viaTypedAlias`, `viaUntypedAlias` |
| Alias through an import or re-export | alias-import.ts (6 lines); alias-source.ts `idle` |
| Statics of every typed array and of subclasses: the class's own entry first | statics.ts `fromFloat16`, `ofFloat16`, `bytesFloat16`, `protoFloat16`, `fromBase64`, `viaOwnSubclass`, `viaOwnTypedSubclass`; every other typed array passes (`int8` ... `bigUint64`) |

A for-of assignment head over an iterable that is not an array or a tuple (`for ({ x } of aSet)`) is
reported as `no MDN key  destructuring assignment  source not judged`: it fails, it is never skipped.

## Known limits

This is our own client code, not an attacker boundary. The check does not judge:

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
- APIs typed by our own declarations: a structural annotation (`const U: { canParse(u: string):
  boolean } = URL; U.canParse(x)`) or an augmentation (`declare global { var EyeDropper: ... }`).
  The check judges only what TypeScript's default lib files declare, and the lib gate accepts our own
  declarations. Nothing covers them. A union or intersection receiver that also holds a lib type that
  declares the member (`PopoverHandle & HTMLElement`, `OwnBody | Response`) is judged on the lib's
  declaration (a-receivers.ts `ownFirstIntersection`, `ownFirstUnion`; `ownOnlyMember` passes).
- Sub-features under a member: options and parameters (`div.focus({ focusVisible: true })`, MDN
  `api.HTMLElement.focus.options_focusVisible_parameter`, iOS 18.4) and behaviors such as symbols as
  WeakMap keys (`javascript.builtins.WeakMap.symbol_as_keys`, 16.4, so it passes at today's floor).
  The check reads the member's own MDN entry only. For DOM APIs nothing covers them: `lib.dom`
  declares the newest options (`FocusOptions.focusVisible`). For ES built-ins the TypeScript lib gate
  stops an option or parameter its es2023 files do not declare (`Intl.PluralRules` `roundingMode`,
  17.2, and the `context` argument of a `JSON.parse` reviver, 18.4, are type errors there), but not a
  behavior: symbols as WeakMap keys pass it.
- Iteration protocols: `for...of`, spread and `for await` use an object's iterator without naming it.
  In MDN 8.1.3 the only one above the floor on an interface that passes is `for await` over a
  `ReadableStream` (`api.ReadableStream.@@asyncIterator`, 27). `lib.dom` declares that iterator, so
  the lib gate passes it too. Nothing covers it.
- Regular expressions: only literals are read, and only for the `d` and `v` flags, lookbehind and
  modifiers. A pattern or flags in a string (`new RegExp("(?<=a)b")`) is not read, nor is any other
  syntax: duplicate named groups (MDN 17) pass. The lib gate (target es2023) stops only the `v` flag
  in a literal (TS1501). Nothing else covers them.
- Code in dependencies (`node_modules`, for example React or Zod): the check reads only the program's
  own files and the workspace packages they import, and the lib gate reads a dependency's type
  declarations only, never its JavaScript. Nothing checks which APIs a dependency calls.
- Members of plain-object types (mapping.ts `isPlainObjectMember`): a member with no MDN key passes
  when its lib type has no MDN entry, is not a mixin MDN files under other interfaces, and names no
  global value. These are WebIDL dictionaries (`*Init`, `*Options`, `ReadableStreamReadResult`,
  `StorageEstimate`), TypeScript helper shapes (`IArguments`, `TemplateStringsArray`), deprecated
  aliases (`ClientRect`) and `Console`, plus `X.prototype` itself. Reading a dictionary's field is
  not a browser feature (review r1 scanned the 724 such names and found no gap at 16.4). Nothing else
  covers them.
- CSS and HTML features: CSS properties and values, HTML elements and attributes (including JSX
  attributes such as `popover`), and DOM event names given as strings or React props
  (`addEventListener("scrollend")`, `onScrollEnd`). Partly covered: Tailwind CSS v4 targets Safari 16.4
  (tailwindcss.com/docs/compatibility), and Vite 8 minifies CSS with Lightning CSS, which lowers some
  newer CSS syntax for `build.cssTarget` (defaults to `build.target`, which Task 14 is to set from
  `BROWSER_FLOOR_BUILD_TARGET`). That lowers syntax; it does not check for a property the floor lacks.
  Nothing checks the rest.
- A constructor reached through an alias (`const V = VideoColorSpace; new V()`): judged on the
  interface's entry only, not on the constructor's (`new X()`, `new (X)()` and `class extends X` are
  judged on both; aliases.ts `viaConstructorAlias` pins the miss). In MDN 8.1.3 nine APIs have a
  constructor newer than their interface at the floor: eight DOM APIs (CSSMathMax, CSSMathMin,
  CSSMathProduct, CSSMathSum, CustomElementRegistry, RTCEncodedAudioFrame, RTCEncodedVideoFrame,
  VideoColorSpace), where nothing covers it, and the ES built-in Iterator, which the TypeScript lib
  gate stops (es2023 declares no `Iterator` value: TS2693).

Reported although the code may be fine (each fails loudly; check it by hand, then accept it with a
`floor-ok` reason):

- A qualified name in a type-only heritage clause (`interface X extends WebAssembly.Global {}`) is
  reported as unmapped.
- CSSOM properties written as `el.style.x` have no MDN key and are reported as unmapped.
- WebIDL constants (`Node.ELEMENT_NODE`, `Event.AT_TARGET`) have no MDN data ("not known to be a
  source of any compatibility issues", MDN data guidelines). One read from its interface object passes
  when that interface is fully supported at the floor; in MDN 8.1.3 every interface with constants is,
  except NodeFilter, which has no MDN entry, so `NodeFilter.SHOW_ELEMENT` is reported as unmapped. A
  constant read from an instance (`node.ELEMENT_NODE`) is reported as unmapped too (statics.ts, the
  last lines).
- A `(` inside a regular expression's character class, where it is a plain character, is read as a
  group: `/[(?i:]/` is reported as not supported (modifiers, MDN 26), and `/[(?<=]/` would be too at
  a floor below 16.4 (lookbehind, MDN 16.4). It only adds a false alarm, never a silent miss: a real
  group beside such a class is still found.

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
- Neither gate reads the code of dependencies (`node_modules`): nothing checks which APIs they call
  (Known limits).

## Updating

- MDN data: bump `@mdn/browser-compat-data` on purpose (only its schema follows semver) and re-run
  the fixture test; a changed version shows up there.
- TypeScript: 7.0 ships no stable compiler API (`typescript/unstable/*`); 7.1 will ship a different
  one. A TypeScript bump breaks this checker loudly (the fixture test and the type-check gate), never
  silently.
