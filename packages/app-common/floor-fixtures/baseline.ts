// The research prototype's proven catches (ios16-floor-proposal.md section 3), at the 16.4 floor.
// A line that must fail ends with an "expect" marker naming the result kind and the MDN key (several
// joined by "; "); every other line must pass. Versions: MDN browser-compat-data 8.1.3.
declare const x: string;
declare const xs: string[];
declare const arr: number[];
declare const dialog: HTMLDialogElement;
declare const div: HTMLDivElement;
declare const res: Response;

export const canParse = URL.canParse(x); // expect: unsupported api.URL.canParse_static
export const groupBy = Object.groupBy(xs, (s) => s.charAt(0)); // expect: unsupported javascript.builtins.Object.groupBy
export const withResolvers = Promise.withResolvers<void>(); // expect: unsupported javascript.builtins.Promise.withResolvers
export const wellFormed = x.isWellFormed(); // 16.4
export const fromAsync = Array.fromAsync(xs); // 16.4
export const transition = document.startViewTransition(); // expect: unsupported api.Document.startViewTransition
export const anySignal = AbortSignal.any([]); // expect: unsupported api.AbortSignal.any_static
export const union = new Set([1]).union(new Set([2])); // expect: unsupported javascript.builtins.Set.union
export const unicodeSets = /[\p{L}--\p{N}]/v; // expect: unsupported javascript.builtins.RegExp.unicodeSets
export const lookbehind = /(?<=\$)\d+/.test(x); // 16.4
export const iteratorMap = arr.values().map((n) => n * 2); // expect: unsupported javascript.builtins.Iterator.map
export const iteratorFilter = new Map<string, number>().keys().filter(Boolean); // expect: unsupported javascript.builtins.Iterator.filter
export const iteratorTake = Iterator.from([1]).take(1); // expect: unsupported javascript.builtins.Iterator.from; unsupported javascript.builtins.Iterator.take
export const idle = requestIdleCallback(() => {}); // expect: unsupported api.Window.requestIdleCallback
export const visible = div.checkVisibility(); // expect: unsupported api.Element.checkVisibility
export const bytes = res.bytes(); // expect: unsupported api.Response.bytes
export const staticJson = Response.json({}); // expect: unsupported api.Response.json_static
div.showPopover(); // expect: unsupported api.HTMLElement.showPopover
export const size = new URLSearchParams("a=1").size; // expect: unsupported api.URLSearchParams.size
export const blobBytes = new Blob([]).bytes(); // expect: unsupported api.Blob.bytes
export const highlights = CSS.highlights; // expect: unsupported api.CSS.highlights_static
export const promiseTry = Promise.try(() => 1); // expect: unsupported javascript.builtins.Promise.try
document.onscrollend = null; // expect: unsupported api.Document.scrollend_event

// Supported at the floor: none of these may fail.
export const cloned = structuredClone({ a: 1 });
export const sorted = arr.toSorted();
export const last = arr.findLast((n) => n > 1);
export const segmenter = new Intl.Segmenter("en", { granularity: "word" });
export const copied = navigator.clipboard.writeText(x);
dialog.showModal();
export const timeout = AbortSignal.timeout(1000);
export const uuid = crypto.randomUUID();
export const at = arr.at(-1);
export const json = res.json();
div.append("x");
export const supports = CSS.supports("display: grid");
export const activation = navigator.userActivation.isActive; // 16.4
export const duration = new Intl.DurationFormat("en"); // 16.4
export const compression = new CompressionStream("gzip"); // 16.4
export const offscreen = new OffscreenCanvas(1, 1); // 16.4
