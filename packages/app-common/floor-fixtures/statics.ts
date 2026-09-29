// A static reached through the global reads the global first: `Float16Array.from` throws a
// ReferenceError where Float16Array (MDN 18.2) is missing, although MDN files `from` under
// TypedArray (10). `typeof X.y` reaches X the same way; only a bare `typeof X` is a feature test.
export const fromFloat16 = Float16Array.from([1]); // expect: unsupported javascript.builtins.Float16Array
export const ofFloat16 = Float16Array.of(1); // expect: unsupported javascript.builtins.Float16Array
export const bytesFloat16 = Float16Array.BYTES_PER_ELEMENT; // expect: unsupported javascript.builtins.Float16Array
export const protoFloat16 = Float16Array.prototype.at.call(new Uint8Array(1), 0); // expect: unsupported javascript.builtins.Float16Array
export const typeofReaches = typeof Float16Array.from === "function"; // expect: unsupported javascript.builtins.Float16Array
export const typeofBracketReaches = typeof Float16Array["from"] === "function"; // expect: unsupported javascript.builtins.Float16Array
export const typeofBare = typeof Float16Array === "undefined";
export const fromUint8 = Uint8Array.from([1]);
export const bytesUint8 = Uint8Array.BYTES_PER_ELEMENT;

// MDN files a subclass's own members under the subclass (Uint8Array.fromBase64, 18.2) and the shared
// ones under TypedArray (from, 10): the class's own entry is tried first, then the shared one.
export const fromBase64 = Uint8Array.fromBase64(""); // expect: unsupported javascript.builtins.Uint8Array.fromBase64
export const toBase64 = new Uint8Array(1).toBase64(); // expect: unsupported javascript.builtins.Uint8Array.toBase64
export const sharedAt = new Uint8Array(1).at(0);

// MDN files a constructor under its interface (data-guidelines/api.md), and it can be newer than the
// interface (VideoColorSpace 15.4, its constructor 17; Iterator 10, its constructor 18.4): `new X()`
// and `extends X` read the constructor too, also in parentheses. The legacy element factories are
// filed under their element (api.HTMLImageElement.Image).
export const newerConstructor = new VideoColorSpace(); // expect: unsupported api.VideoColorSpace.VideoColorSpace
export const parenthesizedConstructor = new (VideoColorSpace)(); // expect: unsupported api.VideoColorSpace.VideoColorSpace
export const parenthesizedWindowConstructor = new (window.VideoColorSpace)(); // expect: unsupported api.VideoColorSpace.VideoColorSpace
export class ViaParenthesizedBase extends (VideoColorSpace) {} // expect: unsupported api.VideoColorSpace.VideoColorSpace
export class ViaIteratorSubclass extends Iterator<number> { // expect: unsupported javascript.builtins.Iterator.Iterator
  next() {
    return { done: true as const, value: undefined };
  }
}
export const interfaceAndConstructor = new Highlight(); // expect: unsupported api.Highlight
export const image = new Image();
export const audio = new Audio();
export const option = new Option();

// Every other typed array (MDN: iOS 4.2, the BigInt ones 15) has no own from, of or BYTES_PER_ELEMENT
// entry, so each resolves to TypedArray's (iOS 10, 10 and 4.2). All pass.
export const int8 = [Int8Array.from([1]), Int8Array.of(1), Int8Array.BYTES_PER_ELEMENT];
export const uint8 = [Uint8Array.of(1), Uint8Array.prototype.at];
export const uint8Clamped = [Uint8ClampedArray.from([1]), Uint8ClampedArray.of(1), Uint8ClampedArray.BYTES_PER_ELEMENT];
export const int16 = [Int16Array.from([1]), Int16Array.of(1), Int16Array.BYTES_PER_ELEMENT];
export const uint16 = [Uint16Array.from([1]), Uint16Array.of(1), Uint16Array.BYTES_PER_ELEMENT];
export const int32 = [Int32Array.from([1]), Int32Array.of(1), Int32Array.BYTES_PER_ELEMENT];
export const uint32 = [Uint32Array.from([1]), Uint32Array.of(1), Uint32Array.BYTES_PER_ELEMENT];
export const float32 = [Float32Array.from([1]), Float32Array.of(1), Float32Array.BYTES_PER_ELEMENT];
export const float64 = [Float64Array.from([1]), Float64Array.of(1), Float64Array.BYTES_PER_ELEMENT];
export const bigInt64 = [BigInt64Array.from([1n]), BigInt64Array.of(1n), BigInt64Array.BYTES_PER_ELEMENT];
export const bigUint64 = [BigUint64Array.from([1n]), BigUint64Array.of(1n), BigUint64Array.BYTES_PER_ELEMENT];

// A subclass of our own inherits the statics: each is judged on the lib class's own entry first.
class OwnURL extends URL {}
export const viaOwnSubclass = OwnURL.canParse(""); // expect: unsupported api.URL.canParse_static
class OwnBytes extends Uint8Array {}
export const viaOwnTypedSubclass = OwnBytes.fromBase64(""); // expect: unsupported javascript.builtins.Uint8Array.fromBase64
export const viaOwnTypedShared = OwnBytes.from([1]);
