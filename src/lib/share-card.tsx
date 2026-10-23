import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import tokens from "../../assets/design-tokens.json";
import { dict, type Lang } from "./i18n";
import { woff2ToSfnt } from "./woff2";
import { shapeArabic } from "./arabic-shape";

/**
 * The share-card maker (rule 3141): one function draws the 1200×630 card a shared link shows for a blog post or a help
 * topic, from the page's own title (and, for help, its description). The idea comes from supastarter's docs app
 * (apps/docs/app/og/[...slug]/route.tsx, one card for every docs page); the code is ours. Used by
 * `src/app/[lang]/blog/[slug]/opengraph-image.tsx` and `src/app/[lang]/help/[topic]/opengraph-image.tsx`; every other page
 * keeps the one site card (`src/app/[lang]/opengraph-image.png`, rule 360).
 *
 * The card says only what the page says: its title, its description, the kind of page and the public name. No claim, number,
 * customer or model name of its own, in line with the site card (rule 366). Colours come from `assets/design-tokens.json`
 * (ink on lemon, the site card's pairing), the font is the site's Arabic display font from `src/app/fonts`, and Arabic is
 * set right to left, shaped by the font's own tables.
 */
export const CARD_SIZE = { width: 1200, height: 630 } as const;
export type CardKind = "blog" | "help";

const { ink, muted, lemon } = tokens.primitive.color;
const KIND_LABEL: Record<CardKind, Record<Lang, string>> = {
  blog: { ar: "المدونة", en: "Blog" },
  help: { ar: "مركز المساعدة", en: "Help center" },
};

const FONT_DIR = join(process.cwd(), "src", "app", "fonts", "thmanyah-serif-display");
const WEIGHTS = [{ weight: 500, file: "Medium" }, { weight: 700, file: "Bold" }, { weight: 900, file: "Black" }] as const;
let fonts: { name: string; data: ArrayBuffer; weight: 500 | 700 | 900; style: "normal" }[] | undefined;
/**
 * The three weights, unwrapped from their WOFF2 files in memory (src/lib/woff2.ts: Satori cannot read WOFF2, and the
 * licence forbids converting the files on disk). Read once per process.
 */
function cardFonts() {
  fonts ??= WEIGHTS.map(({ weight, file }) => ({ name: "Display", data: woff2ToSfnt(readFileSync(join(FONT_DIR, `thmanyahserifdisplay-${file}.woff2`))), weight, style: "normal" as const }));
  return fonts;
}

/** A long title takes a smaller size rather than a fourth and fifth line, so the whole of it fits the card. */
export const titleSize = (title: string): number => (title.length <= 36 ? 80 : title.length <= 64 ? 66 : title.length <= 100 ? 54 : 46);

/** The most a card draws of a title and of a description, so the text always fits the card; the rest is replaced by an ellipsis. */
export const TITLE_MAX = 120;
export const DESCRIPTION_MAX = 150;
/** `text` cut at a word boundary to at most `max` characters, with an ellipsis when something was cut. */
export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max >> 1)).trimEnd()}…`;
}

/** The text a card's image carries for assistive technology (`alt`): the kind of page and its title. */
export const cardAlt = (lang: Lang, kind: CardKind, title: string): string => `${KIND_LABEL[kind][lang]} · ${title} · ${dict[lang].brand}`;

export function shareCard({ lang, kind, title, description }: { lang: Lang; kind: CardKind; title: string; description?: string }): ImageResponse {
  const rtl = lang === "ar";
  const side = rtl ? "right" : "left";
  // `textAlign` is ignored under `lineClamp` in Satori, so long text is cut by `clip` instead. It also leaves a right-to-left
  // text that fits on one line at the left, so the box pushes its line to the reading side as well.
  const text = { display: "flex", justifyContent: rtl ? "flex-end" : "flex-start", direction: rtl ? "rtl" : "ltr", textAlign: side, width: "100%" } as const;
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", background: lemon.$value, color: ink.$value, padding: "64px 80px", fontFamily: "Display" }}>
        <div style={{ display: "flex", flexDirection: rtl ? "row-reverse" : "row", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", fontSize: 44, fontWeight: 900 }}>{shapeArabic(dict[lang].brand)}</div>
          <div style={{ display: "flex", fontSize: 28, fontWeight: 700, border: `3px solid ${ink.$value}`, borderRadius: 999, padding: "6px 24px" }}>{shapeArabic(KIND_LABEL[kind][lang])}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: rtl ? "flex-end" : "flex-start" }}>
          <div style={{ ...text, fontSize: titleSize(title), fontWeight: 900, lineHeight: 1.25 }}>{shapeArabic(clip(title, TITLE_MAX))}</div>
          {description ? <div style={{ ...text, marginTop: 28, fontSize: 32, fontWeight: 500, lineHeight: 1.45, color: muted.$value }}>{shapeArabic(clip(description, DESCRIPTION_MAX))}</div> : null}
        </div>
        <div style={{ display: "flex", height: 3, background: ink.$value }} />
      </div>
    ),
    { ...CARD_SIZE, fonts: cardFonts() },
  );
}
