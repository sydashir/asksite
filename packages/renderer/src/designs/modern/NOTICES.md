# Modern design: notices

The Modern page design (`packages/renderer/src/designs/modern/`, `packages/renderer/styles/sheets/modern.css`) is
our own work, built from the approved Modern mockup (`.superpowers/design-backup/modern-v2/r6`). It ports no new
third-party code, fonts or images beyond three Tabler icons. What it does reuse, and why each page carries the
attribution comment `<!-- Modern design. Portions adapted from AstroWind, Copyright (c) 2023 onWidget, and Tabler
Icons, Copyright (c) 2020-2026 Paweł Kuna. MIT License. -->` (`index.ts`):

| What | Where it comes from | Licence | Licence text read from |
|---|---|---|---|
| Icons: phone, menu-2, x, chevron-down, chevron-right, check, shield-check, circle-check, certificate, clock, map-pin | The shared `src/icons.ts` (Tabler Icons 3.48.0) | MIT, Copyright (c) 2020-2026 Paweł Kuna | `THIRD_PARTY_NOTICES.md` (copied there from the project's LICENSE file) |
| Icons: calendar, building, arrow-down (`icons.ts` in this folder) | Tabler Icons v3.48.0, `icons/outline/<name>.svg` from github.com/tabler/tabler-icons at tag v3.48.0: each icon's subpaths joined into one path, drawn with the shared icons' attributes | MIT, Copyright (c) 2020-2026 Paweł Kuna | The project's `LICENSE` at tag v3.48.0 (raw.githubusercontent.com/tabler/tabler-icons/v3.48.0/LICENSE, read 2026-09-30; the same text as `THIRD_PARTY_NOTICES.md`) |
| The contact form's field markup (the shared form contract that every design keeps, A12 §7) | The shared `src/sections/contact.ts`, ported from AstroWind `Contact.astro` and `Form.astro` | MIT, Copyright (c) 2023 onWidget | `THIRD_PARTY_NOTICES.md`; the upstream LICENSE (fetched in the design research, `.superpowers/design-backup/research/lic/arthelokyo_astrowind.txt`) |
| The CSS reset (preflight) and the few utilities compiled into `styles/out/modern.css` | Tailwind CSS 4.3.3 | MIT, Copyright (c) Tailwind Labs, Inc. | `node_modules/.pnpm/tailwindcss@4.3.3/node_modules/tailwindcss/LICENSE`; the compiled sheet keeps Tailwind's `/*! tailwindcss v4.3.3 \| MIT License \| https://tailwindcss.com */` banner |
| System font stacks (display and body) | Modern Font Stacks and the platforms' own faces | CC0 1.0 (no attribution required) | The project's own LICENSE, `.superpowers/design-backup/research/bold-v2-fonts/src/mfs-LICENSE` (CC0 1.0 Universal legal code) |

No web font is used: every face is one the visitor's device already has (zero font bytes). The quotation mark on the
reviews is Georgia or Times New Roman, drawn by CSS.

Colours (`tokens.ts`) are our own, chosen in the mockup rounds and checked for WCAG AA in
`packages/renderer/test/designs/modern/`.
