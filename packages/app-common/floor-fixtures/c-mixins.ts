// Hardening c: a mixin (Body, ARIAMixin, GlobalEventHandlers, WindowOrWorkerGlobalScope, ...) has no
// MDN entry of its own. MDN's data guidelines file its members "directly to the corresponding
// interface they're exposed on", and APIs on both Window and WorkerGlobalScope at the api root
// (api/_globals). Whatever still has no MDN key fails as unmapped, never passes silently.
declare const body: Body;
declare const aria: ARIAMixin;
declare const handlers: GlobalEventHandlers;
declare const scope: WindowOrWorkerGlobalScope;
declare const win: Window;
declare const div: HTMLDivElement;

export const bodyBytes = body.bytes(); // expect: unsupported api.Request.bytes; unsupported api.Response.bytes
export const bodyJson = body.json();
export const braille = aria.ariaBrailleLabel; // expect: unsupported api.Element.ariaBrailleLabel; unsupported api.ElementInternals.ariaBrailleLabel
export const label = aria.ariaLabel; // Element 12.2, ElementInternals 16.4
handlers.onscrollend = null; // expect: unsupported api.Document.scrollend_event; unsupported api.Element.scrollend_event
export const cloned = win.structuredClone({ a: 1 }); // api.structuredClone, 15.4
export const fetched = scope.fetch("/x"); // api.fetch, 10.3
export const firstLink = document.getElementsByTagName("a").item(0); // TypeScript's HTMLCollectionOf is MDN's HTMLCollection

// No MDN key anywhere.
export const offset = win.pageXOffset; // expect: unmapped Window.pageXOffset
div.onwebkitanimationend = null; // expect: unmapped GlobalEventHandlers.onwebkitanimationend
onscrollend = null; // expect: unmapped onscrollend
div.style.accentColor = "red"; // expect: unmapped CSSStyleProperties.accentColor

// Dictionaries are plain objects, not browser features: their members are never checked.
declare const result: ReadableStreamReadResult<string>;
export const done = result.done;
export const digits = new Intl.NumberFormat("en").resolvedOptions().maximumFractionDigits;
