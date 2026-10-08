// Writes the share card src/app/[lang]/opengraph-image.png (1200×630). Run: node scripts/make-share-image.mjs
//
// The wordmark «ذكين» is set like components/Wordmark.tsx: Thmanyah Serif Display with its Stylistic Alternates on the
// kaf alone (the long, sent-out kaf; the noon stays round), the letters in presentation forms so the split keeps the
// joining, never kashida (rule 317). The font is read from src/app/fonts by a local headless Chromium and only the
// rendered pixels leave this script, so the font files are never copied, served or linked for download. The two slogan lines
// come from SLOGAN.line1 in src/lib/home.ts, the colours from assets/design-tokens.json. Needs the Playwright Chromium
// that e2e/ already uses (npx playwright install chromium), or any Chromium named in CHROMIUM_PATH.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const { color } = JSON.parse(readFileSync("assets/design-tokens.json", "utf8")).primitive;
const INK = color.ink.$value;
const LEMON = color.lemon.$value;
const MUTED = color.muted.$value;

const home = readFileSync("src/lib/home.ts", "utf8");
const line1 = home.match(/line1: \{ ar: "([^"]+)", en: "([^"]+)" \}/);
if (!line1) throw new Error("SLOGAN.line1 not found in src/lib/home.ts");
const [, sloganAr, sloganEn] = line1;

// In memory only: a blank page may not load file:// fonts, and nothing is written to disk but the PNG.
const font = (w) => `data:font/woff2;base64,${readFileSync(`src/app/fonts/thmanyah-serif-display/thmanyahserifdisplay-${w}.woff2`).toString("base64")}`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: T; src: url("${font("Bold")}") format("woff2"); font-weight: 700; }
@font-face { font-family: T; src: url("${font("Black")}") format("woff2"); font-weight: 900; }
html, body { margin: 0; }
body { width: 1200px; height: 630px; background: ${LEMON}; color: ${INK}; font-family: T, sans-serif; position: relative; overflow: hidden; }
.mark { position: absolute; right: 88px; top: 70px; text-align: right; }
.ar { font-weight: 900; font-size: 236px; line-height: 1; direction: rtl; }
.kaf { font-feature-settings: "salt" 1; }
.en { font-weight: 700; font-size: 64px; line-height: 1; margin-top: 6px; letter-spacing: -0.01em; }
.rule { position: absolute; left: 88px; right: 88px; top: 486px; border-top: 3px solid ${INK}; }
.s { position: absolute; top: 518px; font-weight: 700; line-height: 1.2; }
.s-ar { right: 88px; font-size: 40px; direction: rtl; }
.s-en { left: 88px; font-size: 32px; color: ${MUTED}; }
</style></head><body>
<div class="mark"><div class="ar">ذ<span class="kaf">ﻛ</span>ﻴﻦ</div><div class="en">Thakeen</div></div>
<div class="rule"></div>
<div class="s s-ar">${sloganAr}</div>
<div class="s s-en">${sloganEn}</div>
</body></html>`;

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
const loaded = await page.evaluate(() => document.fonts.check("900 236px T") && document.fonts.check("700 32px T"));
if (!loaded) throw new Error("Thmanyah did not load");
await page.screenshot({ path: "src/app/[lang]/opengraph-image.png", type: "png" });
await browser.close();
console.log("wrote src/app/[lang]/opengraph-image.png");
