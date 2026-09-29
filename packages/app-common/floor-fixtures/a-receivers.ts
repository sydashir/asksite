// Hardening a: union and intersection receivers are split, and null and undefined dropped, so a
// member reached through `ref.current?.`, a React `currentTarget` or `A | B` maps to the receiver's
// own MDN interface. Several of these members come from mixins (ARIAMixin, Body,
// ReadableStreamGenericReader), which have no MDN entry of their own.
declare const ref: { current: HTMLDivElement | null };
declare const event: { currentTarget: EventTarget & HTMLDivElement };
declare const maybe: Response | undefined;
declare const either: Request | Response;
declare const defaultReader: ReadableStreamDefaultReader<string> | null;
declare const byobReader: ReadableStreamBYOBReader | null;

export const nullable = ref.current?.ariaBrailleLabel; // expect: unsupported api.Element.ariaBrailleLabel
export const intersection = event.currentTarget.ariaBrailleLabel; // expect: unsupported api.Element.ariaBrailleLabel
export const coalesced = (maybe ?? null)?.bytes(); // expect: unsupported api.Response.bytes
export const union = either.bytes(); // expect: unsupported api.Request.bytes; unsupported api.Response.bytes
export const control = document.querySelector("div")?.showPopover(); // expect: unsupported api.HTMLElement.showPopover

// The same mixin member is supported on one interface and not on another: only the receiver counts.
export const defaultClosed = defaultReader?.closed;
export const byobClosed = byobReader?.closed; // expect: unsupported api.ReadableStreamBYOBReader.closed

// The lib declares cssFloat on CSSStyleProperties (MDN: 26), MDN also lists it on CSSStyleDeclaration
// (1): the receiver's entry wins, and the dropped `null` adds no lookup by the declaring interface.
declare const style: CSSStyleDeclaration | null;
declare const styleRule: CSSStyleRule | null;
export const cssFloat = style?.cssFloat;
export const nestedRules = styleRule?.cssRules; // expect: unsupported api.CSSStyleRule.cssRules

// Our own type beside a lib type that declares the same member: the member is judged on the lib's
// declaration, whichever part comes first. An intersection keeps its written order; TypeScript 7
// orders a union's parts by type name, so OwnBody comes before Response.
interface PopoverHandle { showPopover(): void }
interface OwnBody { bytes(): Promise<Uint8Array> }
declare const handle: PopoverHandle & HTMLElement;
declare const ownOrResponse: OwnBody | Response;
declare const ownOnly: PopoverHandle;
export const ownFirstIntersection = handle.showPopover(); // expect: unsupported api.HTMLElement.showPopover
export const ownFirstUnion = ownOrResponse.bytes(); // expect: unsupported api.Response.bytes
export const ownOnlyMember = ownOnly.showPopover(); // only our own declaration: README "Known limits"
