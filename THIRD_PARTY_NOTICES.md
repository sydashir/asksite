# Third-party notices

asksite includes code and assets adapted from the projects below. Each licence text is
copied from the project's own LICENSE file. Every rendered customer page also carries a one-line
HTML comment in its `<head>` with the AstroWind and Tabler Icons copyright notices
(`packages/renderer/src/render.ts`).

## AstroWind

- Source: https://github.com/arthelokyo/astrowind at commit 14e1a691f80548dcc36370847b1a02c0d0b12821
- Used in: `packages/renderer/src/ui.ts`, `packages/renderer/src/sections/{hero,services,gallery,testimonials,faq,contact,footer}.ts`
  and the button utilities in `packages/renderer/styles/input.css` (markup and class lists ported to TypeScript).

```
MIT License

Copyright (c) 2023 onWidget

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

## Tabler Icons

- Source: https://github.com/tabler/tabler-icons (version 3.48.0, SVG bodies taken from @iconify-json/tabler 1.2.40)
- Used in: `packages/renderer/src/icons.ts`

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

## Modern Font Stacks

- Source: https://github.com/system-fonts/modern-font-stacks
- Used in: the font stacks in `packages/renderer/src/theme.ts`
- Licence: CC0 1.0 Universal (public domain dedication; no attribution required, credited here anyway).

## Unicode data (confusables.txt)

- Source: Unicode Security Mechanisms for UTS #39, `confusables.txt`, Version 18.0.0 (2026-08-06),
  https://www.unicode.org/Public/18.0.0/security/confusables.txt
- Used in: the look-alike table in `packages/site-schema/src/lookalikes.ts` and the letters that look like digits
  (`DIGIT_LETTER`) in `packages/site-schema/src/copy.ts`, which are derived in part from that file and (A9e) from
  `UnicodeData.txt` and `NamesList.txt` 18.0.0 (https://www.unicode.org/Public/18.0.0/ucd/), Unicode Data Files under
  the same licence.
- Licence: Unicode License v3. The file's terms of use (https://www.unicode.org/terms_of_use.html, which redirects
  to https://www.unicode.org/copyright.html) place all Unicode Data Files, everything under
  https://www.unicode.org/Public/, under it. Text copied from https://www.unicode.org/license.txt:

```
UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 1991-2026 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.
```

## standardwebhooks

- Source: https://github.com/standard-webhooks/standard-webhooks (npm `standardwebhooks` 1.1.1)
- Used in: the generator Worker bundle (`apps/generator`), as a dependency of `@anthropic-ai/sdk`
  (`resources/beta/webhooks.mjs`).
- Licence: its package.json says "MIT"; the npm tarball has no LICENSE file; the repository's root LICENSE is
  Apache-2.0; `libraries/javascript` has no LICENSE, and its package.json says MIT.
