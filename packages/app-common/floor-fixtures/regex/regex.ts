// Checked at the floor safari 14 / safari_ios 14, below every regular expression feature the check
// detects (MDN browser-compat-data 8.1.3: the d flag 15, lookbehind 16.4, the v flag 17, modifiers 26),
// so each detection must fire here. At the real floor, baseline.ts shows lookbehind passing.
export const indices = /a/d; // expect: unsupported javascript.builtins.RegExp.hasIndices
export const lookbehind = /(?<=\$)\d+/; // expect: unsupported javascript.regular_expressions.lookbehind_assertion
export const negativeLookbehind = /(?<!\$)\d+/; // expect: unsupported javascript.regular_expressions.lookbehind_assertion
export const modifier = /(?i:a)b/; // expect: unsupported javascript.regular_expressions.modifier
export const removedModifier = /(?-i:a)b/i; // expect: unsupported javascript.regular_expressions.modifier
export const unicodeSets = /[\p{L}--\p{N}]/v; // expect: unsupported javascript.builtins.RegExp.unicodeSets

// Older groups that the check must not take for those features: all pass.
export const named = /(?<year>\d{4})/;
export const nonCapturing = /(?:ab)+/;
export const lookahead = /(?=a)b/;
