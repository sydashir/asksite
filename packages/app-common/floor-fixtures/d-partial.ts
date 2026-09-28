// Hardening d: MDN's `partial_implementation` at the floor ("does not implement mandatory specified
// behavior ... a demonstrable negative impact on web developers") fails unless accepted with a reason.
declare const key: KeyboardEvent;
declare const div: HTMLDivElement;

export const opened = window.open("/x"); // expect: partial api.Window.open
export const openedGlobally = open("/x"); // expect: partial api.Window.open
export const ratio = devicePixelRatio; // expect: partial api.Window.devicePixelRatio
export const composing = key.isComposing; // expect: partial api.KeyboardEvent.isComposing

// Partial only in versions before the floor, full at the floor: passes.
export const aborted = new AbortController().abort();
// Partial only in versions after the floor: not supported at the floor at all.
div.popover = "auto"; // expect: unsupported api.HTMLElement.popover
