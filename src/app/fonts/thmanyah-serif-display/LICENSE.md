# Thmanyah Serif Display («ثمانية للعناوين»)

Copyright © 2016 Thmanyah Publishing and Distribution (شركة ثمانية للنشر والتوزيع). All rights reserved.

These three files (Medium, Bold, Black) are Thmanyah's own woff2 files, unmodified, used under the Thmanyah Font
License: https://font.thmanyah.com/licenses (the Arabic text prevails).

What the license allows here: commercial use in websites and apps, and embedding the font in a website or web app
only as part of a compiled, packaged or obfuscated product.

So in this repository:
- the files stay in `src/app/fonts/`, loaded by `next/font/local` in `src/app/[lang]/layout.tsx`, and reach the browser
  only through the build (hashed under `/_next/static/media`);
- never copy them into `public/`, never link them for download, never modify, subset, convert or rename them as
  another font, and never remove this notice;
- `tests/fonts.test.ts` pins this (rule 317 in `docs/system/tests.md`).
