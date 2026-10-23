/**
 * Arabic letters into their joined forms, for the share card (rule 3141).
 *
 * `next/og` (Satori) lays a line out by measuring each letter on its own, in its isolated shape, and then draws the joined
 * shapes the font substitutes: every Arabic word comes out narrower than the box it was given, so the words sit far apart
 * (found by rendering the first card: about one letter's width of extra space inside every word). Written in the Arabic
 * Presentation Forms the font already carries for each position (initial, medial, final), a letter measures as wide as it
 * draws, and the same joined shapes come out. The text stays in logical order; Satori still does the right-to-left
 * ordering. Letters outside the table (Persian or Urdu additions, digits, Latin, marks) pass through unchanged, a mark
 * staying transparent to the joining of the letters around it.
 *
 * Lam followed by an alef is written as the two letters joined (lam initial or medial, alef final), not as the lam-alef
 * ligature: this font keeps the ligature's code points (U+FEF5-U+FEFC) as empty glyphs and makes the ligature only
 * through its own substitution tables, which Satori cannot be asked to apply to forms it measures correctly. The two joined
 * letters read as the same word.
 *
 * The forms are the Unicode ones (the compatibility decompositions of U+FE70-U+FEFC), listed here by position for the
 * 36 letters of U+0621-U+064A (without tatweel). A form the script does not have is "-"; an isolated letter is the letter.
 */
const BASE = "\u0621\u0622\u0623\u0624\u0625\u0626\u0627\u0628\u0629\u062A\u062B\u062C\u062D\u062E\u062F\u0630\u0631\u0632\u0633\u0634\u0635\u0636\u0637\u0638\u0639\u063A\u0641\u0642\u0643\u0644\u0645\u0646\u0647\u0648\u0649\u064A";
const FINAL = "-\uFE82\uFE84\uFE86\uFE88\uFE8A\uFE8E\uFE90\uFE94\uFE96\uFE9A\uFE9E\uFEA2\uFEA6\uFEAA\uFEAC\uFEAE\uFEB0\uFEB2\uFEB6\uFEBA\uFEBE\uFEC2\uFEC6\uFECA\uFECE\uFED2\uFED6\uFEDA\uFEDE\uFEE2\uFEE6\uFEEA\uFEEE\uFEF0\uFEF2";
const INITIAL = "-----\uFE8B-\uFE91-\uFE97\uFE9B\uFE9F\uFEA3\uFEA7----\uFEB3\uFEB7\uFEBB\uFEBF\uFEC3\uFEC7\uFECB\uFECF\uFED3\uFED7\uFEDB\uFEDF\uFEE3\uFEE7\uFEEB--\uFEF3";
const MEDIAL = "-----\uFE8C-\uFE92-\uFE98\uFE9C\uFEA0\uFEA4\uFEA8----\uFEB4\uFEB8\uFEBC\uFEC0\uFEC4\uFEC8\uFECC\uFED0\uFED4\uFED8\uFEDC\uFEE0\uFEE4\uFEE8\uFEEC--\uFEF4";

/** Marks that sit on a letter and do not take part in joining: the harakat, the dagger alef, and the other combining marks. */
const isMark = (ch: string) => /\p{Mn}/u.test(ch);
const index = (ch: string) => BASE.indexOf(ch);
/** A letter that joins the next one: it has an initial form (tatweel joins both ways). */
const joinsNext = (ch: string) => ch === "\u0640" || (index(ch) >= 0 && INITIAL[index(ch)] !== "-");
/** A letter the previous one can join: every letter of the table but the hamza on its own. */
const joinsPrev = (ch: string) => ch === "\u0640" || (index(ch) >= 0 && FINAL[index(ch)] !== "-");

export function shapeArabic(text: string): string {
  const chars = [...text];
  const out: string[] = [];
  /** The nearest letter before / after `i`, looking past marks, or "" when a space, a digit or a break comes first. */
  const near = (i: number, step: -1 | 1) => {
    for (let j = i + step; j >= 0 && j < chars.length; j += step) if (!isMark(chars[j])) return chars[j];
    return "";
  };
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const k = index(ch);
    if (k < 0 || isMark(ch)) { out.push(ch); continue; }
    const prev = near(i, -1), next = near(i, 1);
    // A letter takes the previous letter's join only when that letter reaches forward: not after an alef, dal, reh or waw.
    const fromPrev = prev !== "" && joinsNext(prev);
    const toNext = joinsNext(ch) && next !== "" && joinsPrev(next);
    const form = fromPrev ? (toNext ? MEDIAL[k] : FINAL[k]) : (toNext ? INITIAL[k] : ch);
    out.push(form === "-" ? ch : form);
  }
  return visualWords(out);
}

const isArabicLetter = (ch: string) => /\p{sc=Arabic}/u.test(ch) && /\p{L}/u.test(ch);

/**
 * Each run of Arabic letters, written backwards (a letter with its marks moving as one). Satori puts the words of a
 * right-to-left line in the right order but draws the letters it is given from left to right, and only reverses them
 * itself for the unshaped letters it joins through the font's own tables; presentation forms are plain glyphs to it, so
 * the word has to arrive in the order it is drawn. Digits, Latin and punctuation are left where they are.
 */
function visualWords(chars: string[]): string {
  const clusters: string[][] = [];
  for (const ch of chars) {
    if (isMark(ch) && clusters.length) clusters[clusters.length - 1].push(ch);
    else clusters.push([ch]);
  }
  const out: string[] = [];
  for (let i = 0; i < clusters.length; ) {
    if (!isArabicLetter(clusters[i][0])) { out.push(...clusters[i++]); continue; }
    let j = i;
    while (j < clusters.length && isArabicLetter(clusters[j][0])) j++;
    for (let k = j - 1; k >= i; k--) out.push(...clusters[k]);
    i = j;
  }
  return out.join("");
}
