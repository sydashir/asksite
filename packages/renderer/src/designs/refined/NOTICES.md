# Classic (refined) design: third-party notices

Every Classic page carries one HTML comment in its `<head>` with the copyright notices below
(`ATTRIBUTION` in `index.ts`), because both MIT licences ask for the notice to travel with copies.
The design itself (layout, markup, styles, tokens) is this project's own work, built from the approved
Classic mockup (classic-v2, round 6).

## Tabler Icons

- Source: https://github.com/tabler/tabler-icons, SVG bodies as published in `@iconify-json/tabler`
  (read from https://api.iconify.design/tabler.json on 2026-09-30).
- Used in: `parts.ts` (receipt-2, calendar, building-store, mail, plus, arrow-up-right) and, through the
  shared `src/icons.ts`, phone, menu-2, x, chevron-down, certificate, shield-check, clock and map-pin.
- Licence text copied from the project's own LICENSE file
  (https://github.com/tabler/tabler-icons/blob/main/LICENSE, read 2026-09-30):

```
MIT License

Copyright (c) 2020-2026 Paweł Kuna

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## AstroWind

- Source: https://github.com/arthelokyo/astrowind at commit 14e1a691f80548dcc36370847b1a02c0d0b12821.
- Used in: `contact.ts`, whose form fields keep today's form field for field (ported from AstroWind's
  `Form.astro` through the shared `src/sections/contact.ts`); only their classes are Classic's.
- Licence text copied from the project's own LICENSE.md at that commit (read 2026-09-30):

```
MIT License

Copyright (c) 2023 onWidget

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Tailwind CSS

- The compiled sheet (`styles/out/refined.css`) contains Tailwind CSS 4.3.3's base styles and utilities
  and keeps its licence banner comment (`/*! tailwindcss v4.3.3 | MIT License | https://tailwindcss.com */`).
  The installed package's LICENSE reads "MIT License, Copyright (c) Tailwind Labs, Inc." (same MIT text as above).

## Fonts

- None shipped: zero font bytes. The page names only fonts that the visitor's own system already has
  (Charter, Rockwell, Palatino, Avenir Next on Apple devices; Sitka, Cambria, Palatino Linotype, Candara on
  Windows; Noto Serif on Android), with generic `serif` and `sans-serif` fallbacks.
