// A static reached through the global reads the global first: `Float16Array.from` throws a
// ReferenceError where Float16Array (MDN 18.2) is missing, although MDN files `from` under
// TypedArray (10). `typeof X.y` reaches X the same way; only a bare `typeof X` is a feature test.
export const fromFloat16 = Float16Array.from([1]); // expect: unsupported javascript.builtins.Float16Array
export const ofFloat16 = Float16Array.of(1); // expect: unsupported javascript.builtins.Float16Array
export const bytesFloat16 = Float16Array.BYTES_PER_ELEMENT; // expect: unsupported javascript.builtins.Float16Array
export const protoFloat16 = Float16Array.prototype.at.call(new Uint8Array(1), 0); // expect: unsupported javascript.builtins.Float16Array
export const typeofReaches = typeof Float16Array.from === "function"; // expect: unsupported javascript.builtins.Float16Array
export const typeofBare = typeof Float16Array === "undefined";
export const fromUint8 = Uint8Array.from([1]);
export const bytesUint8 = Uint8Array.BYTES_PER_ELEMENT;
