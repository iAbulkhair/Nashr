// Writes the PWA icons (rule 682): public/icons/icon-192.png, icon-512.png, icon-maskable-512.png and
// src/app/apple-icon.png (180). Run: node scripts/make-pwa-icons.mjs
//
// PLACEHOLDER until the founder supplies a logo: a «ذ» drawn with plain SVG strokes, lemon on ink
// (assets/design-tokens.json). No font is used, so the output is the same on every machine and no font licence is
// involved (the Thmanyah wordmark may only reach the browser through the website build, rule 317). To ship the real
// logo, replace the four PNGs at the same paths and sizes, or edit MARK below and run this again. `sharp` comes with
// next (its image optimiser), so the script needs no dependency of its own.
import sharp from "sharp";
import { mkdirSync, readFileSync } from "node:fs";

const { color } = JSON.parse(readFileSync("assets/design-tokens.json", "utf8")).primitive;
const INK = color.ink.$value;
const LEMON = color.lemon.$value;

// The letter on a 512 grid: dal's stroke from the top down to the baseline corner, the base running left with a small
// lift, and the dot above, moved onto the centre. Kept inside the central 60%, so a maskable crop (safe zone: a circle
// of 80%) never cuts it.
const MARK = `
  <g transform="translate(15 14)">
  <g fill="none" stroke="${LEMON}" stroke-width="46" stroke-linecap="round" stroke-linejoin="round">
    <path d="M 214 218 Q 318 262 318 344 L 196 344 Q 172 344 164 322" />
  </g>
  <circle cx="232" cy="148" r="30" fill="${LEMON}" />
  </g>`;

/** `round`: the corner radius, 0 for full bleed (maskable and Apple, which crop or round the icon themselves). */
const svg = (round) => `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${round}" fill="${INK}" />${MARK}
</svg>`;

const out = [
  { file: "public/icons/icon-192.png", size: 192, round: 96 },
  { file: "public/icons/icon-512.png", size: 512, round: 96 },
  { file: "public/icons/icon-maskable-512.png", size: 512, round: 0 },
  { file: "src/app/apple-icon.png", size: 180, round: 0 },
];

mkdirSync("public/icons", { recursive: true });
for (const { file, size, round } of out) {
  await sharp(Buffer.from(svg(round))).resize(size, size).png({ compressionLevel: 9 }).toFile(file);
  console.log(`${file} ${size}x${size}`);
}
