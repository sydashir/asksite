// The owner client's browser floor (moderator decisions 2026-09-25 and 2026-10-06): Chrome 111, Edge 111,
// Firefox 128, Safari 16.4 and iOS Safari 16.4. For each browser it is the HIGHEST of four constraints:
// - Vite 8's default build target: chrome111, edge111, firefox114, safari16.4, ios16.4 (vite.dev/config/build-options);
// - Intl.Segmenter, used by the renderer (render.ts): Chrome 87, Firefox 125, Safari 14.1 (MDN browser-compat-data
//   javascript.builtins.Intl.Segmenter);
// - P4-7: Safari and iOS Safari 16.4 (every iOS-16-capable iPhone can update to 16.7.x; matches Vite's default and
//   Tailwind v4's minimum; today the code's regex lookbehind literals need it too, but that was not P4-7's reason);
// - Tailwind CSS v4: Chrome 111, Safari 16.4, Firefox 128 (https://tailwindcss.com/docs/compatibility: "the core
//   functionality of the framework specifically depends on these browser versions").
// This is the one place the floor is written. The floor check (scripts/check-browser-floor.ts) reads
// BROWSER_FLOOR, keyed by MDN browser-compat-data browser names; both Vite builds (owner app and admin) read
// BROWSER_FLOOR_BUILD_TARGET for `build.target`.
export const BROWSER_FLOOR = { chrome: "111", edge: "111", firefox: "128", safari: "16.4", safari_ios: "16.4" } as const;

// Vite 8 `build.target` strings for the same floor, one per browser (vite.dev/config/build-options: Vite's own
// default resolves to ['chrome111', 'edge111', 'firefox114', 'safari16.4', 'ios16.4']).
export const BROWSER_FLOOR_BUILD_TARGET = [
  `chrome${BROWSER_FLOOR.chrome}`,
  `edge${BROWSER_FLOOR.edge}`,
  `firefox${BROWSER_FLOOR.firefox}`,
  `safari${BROWSER_FLOOR.safari}`,
  `ios${BROWSER_FLOOR.safari_ios}`,
] as const;
