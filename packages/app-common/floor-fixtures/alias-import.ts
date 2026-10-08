// Aliasing through an import or a re-export: the imported name keeps the global's type, so the
// member used through it maps to the same MDN key.
import DefaultURL, { LocalURL, idle } from "./alias-source";
import * as direct from "./alias-source";
import { ReexportedDefault, ReexportedURL, sources } from "./alias-reexport";
declare const x: string;

export const viaImport = LocalURL.canParse(x); // expect: unsupported api.URL.canParse_static
export const viaDefaultImport = DefaultURL.canParse(x); // expect: unsupported api.URL.canParse_static
export const viaNamespaceImport = direct.LocalURL.canParse(x); // expect: unsupported api.URL.canParse_static
export const viaReexport = ReexportedURL.canParse(x); // expect: unsupported api.URL.canParse_static
export const viaReexportedDefault = ReexportedDefault.canParse(x); // expect: unsupported api.URL.canParse_static
export const viaReexportedNamespace = sources.LocalURL.canParse(x); // expect: unsupported api.URL.canParse_static
// The alias was judged where it was made (alias-source.ts).
export const idleThroughImport = idle(() => {});
