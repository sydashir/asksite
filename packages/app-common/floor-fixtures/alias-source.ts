// Aliases of platform globals that alias-import.ts imports, directly and through alias-reexport.ts.
// An alias of a global function is judged where it is made; an alias of an object keeps its type, so
// the member used through it is judged where it is used.
export const LocalURL = URL;
export const idle = requestIdleCallback; // expect: unsupported api.Window.requestIdleCallback
export default URL;
