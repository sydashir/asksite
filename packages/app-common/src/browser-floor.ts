// The owner client's browser floor (P4-7, moderator decision 2026-09-25): iOS/Safari 16.4.
// This is the one place the floor is written. The floor check (scripts/check-browser-floor.ts)
// reads BROWSER_FLOOR, keyed by MDN browser-compat-data browser names; the Vite builds (Tasks 14
// and 23) read BROWSER_FLOOR_BUILD_TARGET for `build.target`.
export const BROWSER_FLOOR = { safari: "16.4", safari_ios: "16.4" } as const;

// Vite 8 `build.target` strings for the same floor (vite.dev/config/build-options: Vite's own
// default resolves to ['chrome111', 'edge111', 'firefox114', 'safari16.4', 'ios16.4']).
export const BROWSER_FLOOR_BUILD_TARGET = [`safari${BROWSER_FLOOR.safari}`, `ios${BROWSER_FLOOR.safari_ios}`] as const;
