# Bold (design id "impact"): notices

The Bold page design is our own work, built from the approved mockup (bold-v2 round 4) and its judges'
must-fix list. It includes the third-party material below. Every rendered Bold page carries one HTML comment
(`ATTRIBUTION` in `index.ts`) with the copyright notices of all three.

## AstroWind (MIT)

- The contact form is today's form (`src/sections/contact.ts`, ported from AstroWind's `Contact.astro` and
  `ui/Form.astro` at commit 14e1a691f80548dcc36370847b1a02c0d0b12821), field for field, with only its classes
  changed (A12 §7).
- Licence: MIT, Copyright (c) 2023 onWidget. Full text: `THIRD_PARTY_NOTICES.md` at the repository root.

## Tabler Icons (MIT)

- `icons.ts` adds plus, minus, calendar, arrow-right, arrow-up-right, mail and the filled quote mark to the shared
  set in `src/icons.ts`. Path data is copied unchanged from Tabler Icons 3.48.0 (the approved mockup's copies of
  Tabler's own SVG files).
- Licence: MIT, Copyright (c) 2020-2026 Paweł Kuna. Full text: `THIRD_PARTY_NOTICES.md`.

## Archivo (SIL Open Font License 1.1)

- Used in: `styles/sheets/impact.css`, one `@font-face` named "Archivo Condensed", inlined as a `data:font/woff2`
  URI (user decision 2026-09-27, A12.md). The Bold headings, buttons, prices and phone menu use it; body text stays
  in the owner's lettering choice. The compiled sheet repeats the copyright and licence notice next to the font.
- Source: Archivo by Omnibus-Type, https://github.com/Omnibus-Type/Archivo (Google Fonts builds it from commit
  b5d63988ce19d044d3e10362de730af00526b672). The static instance at wdth 75, wght 800 ("Archivo SemiBold
  Condensed ExtraBold" in its name table), latin subset, as Google Fonts serves it:
  https://fonts.gstatic.com/s/archivo/v25/k3k6o8UDI-1M0wlSV9XAw6lQkqWY8Q9osJaRE-NWIDdgffTTtDRZ9xdpBU7iVNRQ.woff2
  (14,544 bytes, sha256 6a7f90ef8f7603b14198cc039824709ec3dfc5ae90bbc65868ce35ab31879b53).
- This copy is a Modified Version under the OFL (a subset, FAQ 2.6), made with fontTools 4.62.1:

  ```
  pyftsubset <that file> --flavor=woff2 --layout-features='*' --name-IDs='*' --name-legacy --name-languages='*'
    --no-hinting --desubroutinize
    --unicodes=U+0020-007E,U+00A0-00FF,U+0131,U+0152-0153,U+2013-2014,U+2018-201A,U+201C-201E,U+2022,U+2026,U+2032-2033,U+2122,U+2212
  ```

  Result: 12,076 bytes, sha256 da12957e6990ce2bdb70adec71ff73135879a71abe98ecb24ae902ea704a7c27 (pinned in
  `test/designs/impact/sheet.test.ts`). Its name table keeps the copyright (ID 0) and the licence URL (ID 14).
- The copyright line declares no Reserved Font Name, so the subset may keep the name Archivo (OFL condition 3).
  The font is not sold by itself and stays under the OFL (conditions 1 and 5).
- Licence text: copied from the project's own OFL.txt (identical at github.com/Omnibus-Type/Archivo and
  github.com/google/fonts ofl/archivo, both read 2026-09-30):

```
Copyright 2020 The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded, 
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

## What a live page needs

The public page, the admin review page and the owner app's preview must allow `font-src data:` in their
Content-Security-Policy (nothing else). The public page's policy does (`pageCsp`, apps/sites/src/headers.ts); the
admin review and preview policies are Plan 4's. Where a policy lacks it, browsers draw the Bold headings in the
fallback stack (Bahnschrift, the Android condensed face, Nimbus Sans Narrow, then system-ui). Those policies live
outside this design's files: contract steps. Every page inlines the whole sheet, so the font travels with each page
(A16, accepted).
