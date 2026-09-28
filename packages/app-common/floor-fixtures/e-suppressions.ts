// Hardening e: `// floor-ok: <reason>` accepts a finding on the same line, or on the next line when
// the marker is the only thing on its line; the reason is required. A marker with no reason (or no
// colon) is itself a failure and accepts nothing.
declare const x: string;
declare const win: Window;

// floor-ok: the caller tests typeof URL.canParse first
export const lineBefore = URL.canParse(x); // expect: suppressed api.URL.canParse_static
export const sameLine = URL.canParse(x); /* expect: suppressed api.URL.canParse_static */ // floor-ok: same-line reason
export const partial = window.open("/x"); /* expect: suppressed api.Window.open */ // floor-ok: only opens same-tab links
export const unmapped = win.pageXOffset; /* expect: suppressed Window.pageXOffset */ // floor-ok: MDN files it as scrollX's other name
export const belowTrailingMarker = URL.canParse(x); // expect: unsupported api.URL.canParse_static

/* expect: bad-suppression floor-ok */ // floor-ok:
export const afterEmpty = URL.canParse(x); // expect: unsupported api.URL.canParse_static
export const sameLineEmpty = URL.canParse(x); /* expect: unsupported api.URL.canParse_static; bad-suppression floor-ok */ // floor-ok:
/* expect: bad-suppression floor-ok */ // floor-ok no colon
export const afterNoColon = URL.canParse(x); // expect: unsupported api.URL.canParse_static
