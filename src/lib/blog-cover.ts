import { closeSync, fstatSync, openSync, readSync } from "fs";
import { join } from "path";
import type { Lang } from "./i18n";

/**
 * A post's optional cover image (rule 3314). The front matter names a file the repository holds under `public/blog/` and an
 * alternative text in each language the post is written in:
 *
 *     cover: /blog/ramadan-2026.webp
 *     cover_alt_ar: ...
 *     cover_alt_en: ...
 *
 * Nothing is fetched from anywhere: the file must already be in the repository, and `postProblems` fails the build when it is
 * missing, is not a PNG, JPEG, WebP, AVIF or GIF (by its name and by its first bytes, so a renamed script or a page of HTML
 * is not an image), is larger than `COVER_MAX_BYTES`, or has no alternative text. A post with no cover shows its own
 * generated share card instead (`generatedCover`), which is the card its link preview already uses.
 */
export const COVER_DIR = "/blog/";
export const COVER_MAX_BYTES = 1_500_000;
export const COVER_ALT_MAX = 200;
/** `/blog/` plus one file name of lowercase words, digits, dots and hyphens: no folder, no `..`, no query. */
const COVER_PATH = /^\/blog\/[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(png|jpe?g|webp|avif|gif)$/;

export type ImageKind = "png" | "jpeg" | "webp" | "avif" | "gif";
const ASCII = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.slice(from, to));

/** The kind of image a file's first bytes say it is, or null. Pure, so a test can hand it any bytes. */
export function imageKind(b: Uint8Array): ImageKind | null {
  if (b.length >= 8 && b[0] === 0x89 && ASCII(b, 1, 4) === "PNG" && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 12 && ASCII(b, 0, 4) === "RIFF" && ASCII(b, 8, 12) === "WEBP") return "webp";
  if (b.length >= 12 && ASCII(b, 4, 8) === "ftyp" && (ASCII(b, 8, 12) === "avif" || ASCII(b, 8, 12) === "avis")) return "avif";
  if (b.length >= 6 && (ASCII(b, 0, 6) === "GIF87a" || ASCII(b, 0, 6) === "GIF89a")) return "gif";
  return null;
}

const KIND_OF_EXT: Record<string, ImageKind> = { png: "png", jpg: "jpeg", jpeg: "jpeg", webp: "webp", avif: "avif", gif: "gif" };

/** A file's first bytes and size, or null when it is not there. `cover` is the front matter value, already shaped by `COVER_PATH`. */
export type CoverFile = { head: Uint8Array; size: number };
export type CoverReader = (cover: string) => CoverFile | null;

/** Reads under `<repository>/public`. `COVER_PATH` has already kept the name to one file in `public/blog`. */
export const readCoverFile: CoverReader = (cover) => {
  let fd: number | undefined;
  try {
    fd = openSync(join(process.cwd(), "public", cover), "r");
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const head = new Uint8Array(16);
    const n = readSync(fd, head, 0, 16, 0);
    return { head: head.slice(0, n), size: st.size };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

/**
 * What is wrong with a post's cover fields, empty when there is no cover or it is fine. `langs` is the languages the post is
 * written in: each needs an alternative text, and a text for a language the post lacks is a mistake. The alternative text is
 * what a reader who cannot see the image is told, so it must say something: it is not blank and not longer than a sentence.
 */
export function coverProblems(file: string, meta: Record<string, string>, langs: readonly Lang[], read: CoverReader = readCoverFile): string[] {
  const out: string[] = [];
  const cover = meta.cover;
  const alts = (["ar", "en"] as const).filter((l) => meta[`cover_alt_${l}`] !== undefined);
  if (cover === undefined) {
    for (const l of alts) out.push(`${file}: cover_alt_${l} is given without a cover`);
    return out;
  }
  if (!COVER_PATH.test(cover)) {
    out.push(`${file}: cover "${cover.slice(0, 60)}" must be /blog/ plus one file name (png, jpg, jpeg, webp, avif or gif) from public/blog`);
  } else {
    const f = read(cover);
    const want = KIND_OF_EXT[cover.slice(cover.lastIndexOf(".") + 1)];
    if (!f) out.push(`${file}: cover ${cover} is not a file in public/blog`);
    else {
      const kind = imageKind(f.head);
      if (!kind) out.push(`${file}: cover ${cover} is not an image (its first bytes are not a PNG, JPEG, WebP, AVIF or GIF)`);
      else if (kind !== want) out.push(`${file}: cover ${cover} is a ${kind} image under a .${cover.slice(cover.lastIndexOf(".") + 1)} name`);
      if (f.size > COVER_MAX_BYTES) out.push(`${file}: cover ${cover} is ${f.size} bytes; the most is ${COVER_MAX_BYTES}`);
    }
  }
  for (const l of langs) {
    const a = meta[`cover_alt_${l}`];
    if (!a) out.push(`${file}: cover_alt_${l} is missing (a cover needs its alternative text in ${l === "ar" ? "Arabic" : "English"})`);
    else if (a.length > COVER_ALT_MAX) out.push(`${file}: cover_alt_${l} is ${a.length} characters; the most is ${COVER_ALT_MAX}`);
  }
  for (const l of alts) if (!langs.includes(l)) out.push(`${file}: cover_alt_${l} is given but the post is not in ${l === "ar" ? "Arabic" : "English"}`);
  return out;
}

export type PostCover = { src: string; alt: string; generated: boolean };

/**
 * The image to draw for a post in `lang`: its own cover with its own alternative text, or, with none, the generated share card
 * of the post (`opengraph-image/card`, the route `generateImageMetadata` in `src/app/[lang]/blog/[slug]/opengraph-image.tsx`
 * serves), which repeats the title the page already shows and so has an empty alternative text.
 */
export function postCover(lang: Lang, slug: string, cover: { src: string; alt: string } | null): PostCover {
  return cover ? { ...cover, generated: false } : { src: `/${lang}/blog/${slug}/opengraph-image/card`, alt: "", generated: true };
}
