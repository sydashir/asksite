// Hardening e in JSX. Between JSX children a `//` line is text that the page shows, so the marker there
// is a block comment in braces. It works as the `//` form does (e-suppressions.ts): alone on its line it
// accepts the next line, after code it accepts its own line only, and one without a reason (or without a
// colon) accepts nothing and is itself a failure. With `jsx: preserve` and this JSX namespace, the file
// type-checks without React.
declare const div: HTMLDivElement;
declare const win: Window;
declare global {
  namespace JSX {
    interface IntrinsicElements {
      [tag: string]: Record<string, unknown>;
    }
  }
}

export const markers = (
  <div>
    {/* floor-ok: the popover is an optional extra */}
    <button onClick={() => div.showPopover()} />{/* expect: suppressed api.HTMLElement.showPopover */}
    <button onClick={() => div.showPopover()} />{/* floor-ok: same-line reason */}{/* expect: suppressed api.HTMLElement.showPopover */}
    <a onClick={() => win.open("/x")} />{/* floor-ok: only opens same-tab links */}{/* expect: suppressed api.Window.open */}
    <p title={String(win.pageXOffset)} />{/* floor-ok: MDN files it as scrollX's other name */}{/* expect: suppressed Window.pageXOffset */}
    <button onClick={() => div.showPopover()} />{/* expect: unsupported api.HTMLElement.showPopover */}
    {/* a note */}{/* floor-ok: a note may stand on either side */}{/* another note */}
    <button onClick={() => div.showPopover()} />{/* expect: suppressed api.HTMLElement.showPopover */}
    {/* floor-ok: covers its own line only */}<button onClick={() => div.showPopover()} />{/* expect: suppressed api.HTMLElement.showPopover */}
    <button onClick={() => div.showPopover()} />{/* expect: unsupported api.HTMLElement.showPopover */}
    {/* expect: bad-suppression floor-ok */}{/* floor-ok: */}
    <button onClick={() => div.showPopover()} />{/* expect: unsupported api.HTMLElement.showPopover */}
    <button onClick={() => div.showPopover()} />{/* floor-ok: */}{/* expect: unsupported api.HTMLElement.showPopover; bad-suppression floor-ok */}
    {/* expect: bad-suppression floor-ok */}{/* floor-ok no colon */}
    <button onClick={() => div.showPopover()} />{/* expect: unsupported api.HTMLElement.showPopover */}
  </div>
);
