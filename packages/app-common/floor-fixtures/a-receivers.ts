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
