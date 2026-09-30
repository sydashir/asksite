# Modern design: notices

The Modern page design (`packages/renderer/src/designs/modern/`, `packages/renderer/styles/sheets/modern.css`) is
our own work, built from the approved Modern mockup (`.superpowers/design-backup/modern-v2/r6`). It ports no new
third-party code, fonts or images. What it does reuse, and why each page carries the attribution comment
`<!-- Modern design. Portions adapted from AstroWind, Copyright (c) 2023 onWidget, and Tabler Icons, Copyright (c)
2020-2026 Paweł Kuna. MIT License. -->` (`index.ts`):

| What | Where it comes from | Licence | Licence text read from |
|---|---|---|---|
| Icons: phone, menu, close, chevron-down, check, circle-check, shield-check, certificate, clock, map-pin | The shared `src/icons.ts` (Tabler Icons 3.48.0) | MIT, Copyright (c) 2020-2026 Paweł Kuna | `THIRD_PARTY_NOTICES.md` (copied there from the project's LICENSE file) |
| The contact form's field markup (the shared form contract that every design keeps, A12 §7) | The shared `src/sections/contact.ts`, ported from AstroWind `Contact.astro` and `Form.astro` | MIT, Copyright (c) 2023 onWidget | `THIRD_PARTY_NOTICES.md`; the upstream LICENSE (fetched in the design research, `.superpowers/design-backup/research/lic/arthelokyo_astrowind.txt`) |
| The CSS reset (preflight) and the few utilities compiled into `styles/out/modern.css` | Tailwind CSS 4.3.3 | MIT, Copyright (c) Tailwind Labs, Inc. | `node_modules/.pnpm/tailwindcss@4.3.3/node_modules/tailwindcss/LICENSE`; the compiled sheet keeps Tailwind's `/*! tailwindcss v4.3.3 \| MIT License \| https://tailwindcss.com */` banner |
| System font stacks (display and body) | Modern Font Stacks and the platforms' own faces | CC0 1.0 (no attribution required) | `.superpowers/design-backup/research/lic/cc0_official.txt` |

No web font is used: every face is one the visitor's device already has (zero font bytes). The quotation mark on the
reviews is Georgia or Times New Roman, drawn by CSS.

Colours (`tokens.ts`) are our own, chosen in the mockup rounds and checked for WCAG AA in
`packages/renderer/test/designs/modern/`.
