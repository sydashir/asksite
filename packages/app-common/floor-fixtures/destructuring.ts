// Destructuring reads a member from its source. A declaration, a parameter with a default, for-of,
// rest, array and nested forms are typed by TypeScript from the source. An ASSIGNMENT's left side
// (`({ canParse } = URL)`) is an object literal that TypeScript types from the targets instead, so the
// check reads each property from the right-hand side itself.
declare const x: string;
declare const div: HTMLDivElement;

// Declarations.
export const { canParse: declared } = URL; // expect: unsupported api.URL.canParse_static
export function withDefault({ canParse }: typeof URL = URL) { // expect: unsupported api.URL.canParse_static
  return canParse(x);
}
export const { canParse: withRest, ...rest } = URL; // expect: unsupported api.URL.canParse_static
export const [signalAny] = [AbortSignal.any]; // expect: unsupported api.AbortSignal.any_static
export const { a: { canParse: nested } } = { a: URL }; // expect: unsupported api.URL.canParse_static
export const { canParse: withFallback = URL.canParse } = URL; // expect: unsupported api.URL.canParse_static; unsupported api.URL.canParse_static
for (const { canParse } of [URL]) canParse(x); // expect: unsupported api.URL.canParse_static
export const { showPopover } = div; // expect: unsupported api.HTMLElement.showPopover
export const [{ canParse: inArray }] = [URL]; // expect: unsupported api.URL.canParse_static
export const arrowDefault = ({ canParse } = URL) => canParse(x); // expect: unsupported api.URL.canParse_static
export function annotated({ showPopover }: HTMLElement) { // expect: unsupported api.HTMLElement.showPopover
  return showPopover;
}
export const { "canParse": quoted } = URL; // expect: unsupported api.URL.canParse_static
export const { ["canParse"]: computed } = URL; // expect: unsupported api.URL.canParse_static

// Assignments.
let canParse: typeof URL.canParse;
let renamed: typeof URL.canParse;
let anySignal: typeof AbortSignal.any;
let popover: typeof div.showPopover;
({ canParse } = URL); // expect: unsupported api.URL.canParse_static
({ canParse: renamed } = URL); // expect: unsupported api.URL.canParse_static
({ any: anySignal } = AbortSignal); // expect: unsupported api.AbortSignal.any_static
({ canParse = URL.canParse } = URL); // expect: unsupported api.URL.canParse_static; unsupported api.URL.canParse_static
({ a: { canParse } } = { a: URL }); // expect: unsupported api.URL.canParse_static
[{ canParse }] = [URL]; // expect: unsupported api.URL.canParse_static
[renamed] = [URL.canParse]; // expect: unsupported api.URL.canParse_static
({ showPopover: popover } = div); // expect: unsupported api.HTMLElement.showPopover
({ "canParse": renamed } = URL); // expect: unsupported api.URL.canParse_static
({ ["canParse"]: renamed } = URL); // expect: unsupported api.URL.canParse_static
// A nested pattern with a default reads the outer property or the default: both are judged, and a
// source met twice counts once.
({ a: { canParse } = { canParse: URL.canParse } } = { a: URL }); // expect: unsupported api.URL.canParse_static; unsupported api.URL.canParse_static
({ a: { canParse } = URL } = { a: URL }); // expect: unsupported api.URL.canParse_static
export const assigned = [canParse, renamed, anySignal, popover];

// An assignment pattern in a for-of head reads each element: judged over an array or a tuple, and
// reported (never skipped) over any other iterable, whose element type the check does not derive.
for ({ canParse } of [URL]) canParse(x); // expect: unsupported api.URL.canParse_static
for ({ canParse } of [URL, URL] as const) canParse(x); // expect: unsupported api.URL.canParse_static
for ({ canParse } of new Set([URL])) canParse(x); // expect: unmapped source not judged
