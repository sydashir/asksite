// Hardening b: a type parameter's receiver maps through its constraint, and `this` through the
// class it belongs to.
export function viaConstraint<T extends Response>(response: T) {
  return response.bytes(); // expect: unsupported api.Response.bytes
}
export function viaNullableConstraint<T extends HTMLDivElement | null>(div: T) {
  return div?.ariaBrailleLabel; // expect: unsupported api.Element.ariaBrailleLabel
}
export function viaDocumentConstraint<D extends Document>(doc: D) {
  doc.onscrollend = null; // expect: unsupported api.Document.scrollend_event
}

export class Menu extends HTMLElement {
  watch() {
    this.onscrollend = null; // expect: unsupported api.Element.scrollend_event
  }
  label() {
    return this.ariaBrailleLabel; // expect: unsupported api.Element.ariaBrailleLabel
  }
  open() {
    this.showPopover(); // expect: unsupported api.HTMLElement.showPopover
  }
}

// The constraint decides: the same mixin member passes on one reader and fails on the other.
export function defaultClosed<R extends ReadableStreamDefaultReader<string>>(reader: R) {
  return reader.closed;
}
export function byobClosed<R extends ReadableStreamBYOBReader>(reader: R) {
  return reader.closed; // expect: unsupported api.ReadableStreamBYOBReader.closed
}
