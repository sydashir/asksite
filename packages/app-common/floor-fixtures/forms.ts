// The closed list of forms (p4-7-brief.md, DECIDED 2026-09-28) that the other fixture files do not
// already hold: a bare reference, `window.`, `globalThis.` and `self.`, the optional bracket (also on
// a receiver that may be null or undefined), an instance member by bracket, and `instanceof`.
declare const x: string;
declare const node: Node;
declare const div: HTMLDivElement;
declare const maybeDiv: HTMLDivElement | null;
declare const ref: { current: HTMLDivElement | null };
declare const maybeEither: Request | Response | undefined;

// A bare identifier is a use when it is only referenced, not called (baseline.ts has the call).
export const idleReference = requestIdleCallback; // expect: unsupported api.Window.requestIdleCallback

// The global object by any of its names.
export const viaWindow = window.requestIdleCallback(() => {}); // expect: unsupported api.Window.requestIdleCallback
export const viaGlobalThis = globalThis.requestIdleCallback(() => {}); // expect: unsupported api.Window.requestIdleCallback
export const viaSelf = self.requestIdleCallback(() => {}); // expect: unsupported api.Window.requestIdleCallback
export const viaSelfStatic = self.URL.canParse(x); // expect: unsupported api.URL.canParse_static
export const newViaGlobalThis = new globalThis.Highlight(); // expect: unsupported api.Highlight

// A string-literal bracket, also after `?.`, and on an instance.
export const viaOptionalBracket = URL?.["canParse"](x); // expect: unsupported api.URL.canParse_static
export const viaInstanceBracket = div["showPopover"](); // expect: unsupported api.HTMLElement.showPopover
// `?.[...]` on a receiver that may be null or undefined reads the key without them, as `?.` does.
export const viaNullableBracket = maybeDiv?.["showPopover"](); // expect: unsupported api.HTMLElement.showPopover
export const viaRefBracket = ref.current?.["ariaBrailleLabel"]; // expect: unsupported api.Element.ariaBrailleLabel
export const viaNullableUnionBracket = maybeEither?.["bytes"](); // expect: unsupported api.Request.bytes; unsupported api.Response.bytes
export function viaNullableConstraintBracket<T extends HTMLDivElement | null>(t: T) {
  return t?.["showPopover"](); // expect: unsupported api.HTMLElement.showPopover
}

// `instanceof` reads the global.
export const isHighlight = node instanceof Highlight; // expect: unsupported api.Highlight
export const isElement = node instanceof Element;
