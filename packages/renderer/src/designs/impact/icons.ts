// Icons the Bold design adds to the shared set (src/icons.ts): Tabler Icons 3.48.0 (MIT, Copyright (c)
// 2020-2026 Paweł Kuna; see NOTICES.md), path data copied unchanged from the approved mockup's
// _work/icons/*.svg (Tabler's own files). All are 24x24 and use currentColor; "quote" is Tabler's filled mark.
import { html, trusted, type SafeHtml } from "../../html.ts";
import { icon as sharedIcon, type IconName } from "../../icons.ts";

const EXTRA = {
  plus: trusted('<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M12 5l0 14"/><path d="M5 12l14 0"/></g>'),
  minus: trusted('<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M5 12l14 0"/></g>'),
  calendar: trusted('<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M4 7a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12"/><path d="M16 3v4"/><path d="M8 3v4"/><path d="M4 11h16"/><path d="M11 15h1"/><path d="M12 15v3"/></g>'),
  "arrow-right": trusted('<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M5 12l14 0"/><path d="M13 18l6 -6"/><path d="M13 6l6 6"/></g>'),
  "arrow-up-right": trusted('<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M17 7l-10 10"/><path d="M8 7l9 0l0 9"/></g>'),
  mail: trusted('<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M3 7a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-10"/><path d="M3 7l9 6l9 -6"/></g>'),
  quote: trusted('<g fill="currentColor"><path d="M9 5a2 2 0 0 1 2 2v6c0 3.13 -1.65 5.193 -4.757 5.97a1 1 0 1 1 -.486 -1.94c2.227 -.557 3.243 -1.827 3.243 -4.03v-1h-3a2 2 0 0 1 -1.995 -1.85l-.005 -.15v-3a2 2 0 0 1 2 -2z"/><path d="M18 5a2 2 0 0 1 2 2v6c0 3.13 -1.65 5.193 -4.757 5.97a1 1 0 1 1 -.486 -1.94c2.227 -.557 3.243 -1.827 3.243 -4.03v-1h-3a2 2 0 0 1 -1.995 -1.85l-.005 -.15v-3a2 2 0 0 1 2 -2z"/></g>'),
} as const;

export type BoldIconName = IconName | keyof typeof EXTRA;

const isExtra = (name: BoldIconName): name is keyof typeof EXTRA => Object.hasOwn(EXTRA, name);

/** Decorative inline SVG. `className` must be a whole literal class string from our source. */
export function icon(name: BoldIconName, className = "ic"): SafeHtml {
  if (!isExtra(name)) return sharedIcon(name, className);
  return html`<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true">${EXTRA[name]}</svg>`;
}
