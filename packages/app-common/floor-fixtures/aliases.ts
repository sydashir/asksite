// The same API reached through aliases and other forms (the prototype's proven catches).
declare const x: string;

const typed: typeof URL = URL;
export const viaTypedAlias = typed.canParse(x); // expect: unsupported api.URL.canParse_static
const untyped = URL;
export const viaUntypedAlias = untyped.canParse(x); // expect: unsupported api.URL.canParse_static
const { canParse } = URL; // expect: unsupported api.URL.canParse_static
export const viaDestructuring = canParse(x);
export const viaWindow = window.URL.canParse(x); // expect: unsupported api.URL.canParse_static
export const viaGlobalThis = globalThis.URL.canParse(x); // expect: unsupported api.URL.canParse_static
export const viaBracket = URL["canParse"](x); // expect: unsupported api.URL.canParse_static
const key = "canParse" as const;
export const viaConstKey = URL[key](x); // expect: unsupported api.URL.canParse_static
export const viaOptionalCall = URL?.canParse?.(x); // expect: unsupported api.URL.canParse_static
function pick<T>(value: T): T {
  return value;
}
export const viaGeneric = pick(URL).canParse(x); // expect: unsupported api.URL.canParse_static

// A feature test is not a use; the guarded call still is (it needs a `floor-ok` reason).
export const detected = typeof URL.canParse === "function";
export const detectedByBracket = typeof URL["canParse"] === "function";
export const guardedByTypeof = typeof URL.canParse === "function" ? URL.canParse(x) : false; // expect: unsupported api.URL.canParse_static
export const guardedByBracketTypeof = typeof URL["canParse"] === "function" ? URL["canParse"](x) : false; // expect: unsupported api.URL.canParse_static
export const guardedByIn = "canParse" in URL && URL.canParse(x); // expect: unsupported api.URL.canParse_static

// A class's `extends` clause and an instantiation expression read the global at runtime (TypeScript
// parses both as ExpressionWithTypeArguments, a type node); `implements` and an interface's
// `extends` are types only.
export class ViaExtends extends Highlight {} // expect: unsupported api.Highlight
export const viaClassExpression = class extends Highlight {}; // expect: unsupported api.Highlight
export const viaInstantiation = Float16Array<ArrayBuffer>; // expect: unsupported javascript.builtins.Float16Array
export class Deadline implements IdleDeadline {
  readonly didTimeout = false;
  timeRemaining() {
    return 0;
  }
}
export interface OwnHighlight extends Highlight {}

// A shorthand property reads the value its name resolves to: the global here, a parameter below.
export const viaShorthand = { requestIdleCallback }; // expect: unsupported api.Window.requestIdleCallback
export function ownShorthand(requestIdleCallback: () => void) {
  return { requestIdleCallback };
}

// Known misses by design (ios16-floor-proposal.md section 3): an `any` cast and reflection.
export const viaAny = (URL as any).canParse(x);
export const viaReflect = Reflect.get(URL, "canParse");
// A constructor reached through an alias is judged on its interface only (README.md "Known limits"):
// CustomElementRegistry passes (Safari 10.1, Chrome 54, Firefox 63), its constructor (Chrome 146, Safari 26) is not judged.
const Registry = CustomElementRegistry;
export const viaConstructorAlias = new Registry();

// Same names that are not the platform API must pass.
class OwnSet {
  union(other: OwnSet) {
    return other;
  }
}
export const ownUnion = new OwnSet().union(new OwnSet());
export const arrayMap = [1, 2].map((n) => n);
