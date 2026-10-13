/**
 * Regulated sectors (rules 1520-1524): a brand whose industry is health care, a pharmacy, real estate, law or finance and
 * investment never has an item approved without a person. `initialStatus` (src/lib/brand-rules.ts), the one place a new
 * item may start approved, holds every item of such a brand for the inbox even when the owner turned auto-approve on for
 * its type; and each customer-facing item gets one short plain line saying it is general information (`withDisclaimer`).
 *
 * The sector is read from the brand's own `industry` field (free text the owner or onboarding wrote, in either
 * language), after the same folding as the banned-word check: alef forms, yaa, taa marbuta, diacritics, lower case.
 * Words are whole words once و/ال are taken off, and a word marked "*" is matched at the start of a word, so "العيادات"
 * is a clinic, "عقارية" real estate, and "طبيعي" (natural) is not medical. Short or ambiguous words are left out on purpose (a "صالون تجميل" or a "healthy food" shop is not a clinic, a "software
 * developer" is not a property developer); the lists are exported so the founder can review them.
 *
 * Import-free (brand-rules.ts imports it), like brand-rules.ts itself.
 */
export type Sector = "pharmacy" | "health" | "real_estate" | "legal" | "finance";
export const REGULATED_SECTORS: readonly Sector[] = ["pharmacy", "health", "real_estate", "legal", "finance"];

/** Each sector's words, Arabic after folding and English in lower case. The first sector that matches wins (pharmacy before health). */
export const SECTOR_WORDS: Readonly<Record<Sector, { ar: readonly string[]; en: readonly string[] }>> = {
  pharmacy: {
    ar: ["صيدل*", "دواء", "ادويه"],
    en: ["pharmacy", "pharmacies", "pharmacist", "pharma", "pharmaceutical", "drugstore", "chemist"],
  },
  health: {
    ar: ["عياد*", "طبي", "طبيه", "طبيب", "اطباء", "مستشفي", "مستشفيات", "مستوصف*", "اسنان", "جلديه", "علاج طبيعي", "تمريض", "مختبر*", "رعايه صحيه", "خدمات صحيه"],
    en: ["clinic", "clinics", "medical", "medicine", "hospital", "hospitals", "healthcare", "health care", "dental", "dentist", "dentistry", "doctor", "doctors", "physician", "physiotherapy", "physio", "dermatology", "dermatologist", "nursing", "laboratory", "telehealth", "telemedicine"],
  },
  real_estate: {
    ar: ["عقار*"],
    en: ["real estate", "realestate", "realty", "realtor", "property", "properties", "estate agent", "estate agency", "proptech"],
  },
  legal: {
    ar: ["محام*", "قانوني", "قانونيه"],
    en: ["legal", "law firm", "law office", "law", "lawyer", "lawyers", "attorney", "attorneys", "solicitor", "solicitors", "notary", "legaltech"],
  },
  finance: {
    ar: ["استثمار*", "تمويل*", "مالي", "ماليه", "مصرف*", "بنك", "بنوك", "تداول", "اسهم", "تامين", "عملات رقميه", "فوركس", "قروض"],
    en: ["finance", "financial", "fintech", "investment", "investments", "investing", "invest", "bank", "banking", "wealth", "asset management", "trading", "brokerage", "stocks", "crypto", "cryptocurrency", "forex", "insurance", "lending", "loans", "loan", "mortgage", "mortgages"],
  },
};

const DROP = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;
const FOLD: Record<string, string> = { "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ى": "ي", "ة": "ه", "ؤ": "و", "ئ": "ي" };
const fold = (s: string) => s.replace(DROP, "").replace(/[أإآٱىةؤئ]/g, (c) => FOLD[c]).toLowerCase();
const isArabic = (s: string) => /[؀-ۿ]/.test(s);
/** A word without a leading و/ف and the article ("والعيادات" → "عيادات"). */
function stems(w: string): string[] {
  const out = [w];
  const c = w.length > 2 && (w.startsWith("و") || w.startsWith("ف")) ? w.slice(1) : w;
  if (c !== w) out.push(c);
  for (const a of ["بال", "لل", "ال"]) if (c.length > a.length + 1 && c.startsWith(a)) out.push(c.slice(a.length));
  return out;
}

/**
 * Does this folded, split text hold the phrase, word by word? A word of the phrase that ends in "*" starts the matching
 * word ("عياد*": عيادة، عيادات); any other word is the whole word (Arabic once و/ال are taken off, so "طبي" never matches
 * "طبيعي").
 */
function holds(words: string[], phrase: string): boolean {
  const parts = phrase.split(" ");
  const one = (w: string, p: string) => {
    const forms = isArabic(p) ? stems(w) : [w];
    return p.endsWith("*") ? forms.some((s) => s.startsWith(p.slice(0, -1))) : forms.includes(p);
  };
  for (let i = 0; i + parts.length <= words.length; i++) if (parts.every((p, k) => one(words[i + k], p))) return true;
  return false;
}

/** The regulated sector a brand's industry names, or null. Unknown, empty or non-string input is null (not regulated). */
export function regulatedSector(industry: unknown): Sector | null {
  if (typeof industry !== "string" || !industry.trim()) return null;
  const words = fold(industry.slice(0, 400)).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length) return null;
  for (const s of REGULATED_SECTORS) {
    const w = SECTOR_WORDS[s];
    if ([...w.ar, ...w.en].some((p) => holds(words, fold(p)))) return s;
  }
  return null;
}

/** True when the brand is in a regulated sector: no item of it is ever approved without a person. */
export const isRegulated = (brand: { industry?: unknown } | null | undefined): boolean => regulatedSector(brand?.industry) !== null;

/** One short plain line per sector and language: general information, not advice. No promise, no legal claim. */
export const DISCLAIMER: Readonly<Record<Sector, { ar: string; en: string }>> = {
  health: { ar: "للتوعية العامة فقط، ولا يغني عن استشارة الطبيب.", en: "For general awareness only; not a substitute for a doctor's advice." },
  pharmacy: { ar: "للتوعية العامة فقط، استشر الصيدلي أو الطبيب قبل استخدام أي دواء.", en: "General awareness only; ask a pharmacist or doctor before using any medicine." },
  real_estate: { ar: "معلومات للتعريف فقط، والتفاصيل النهائية حسب العقد.", en: "For information only; final details are as stated in the contract." },
  legal: { ar: "معلومات عامة، وليست استشارة قانونية.", en: "General information, not legal advice." },
  finance: { ar: "معلومات عامة، وليست نصيحة استثمارية أو مالية.", en: "General information, not investment or financial advice." },
};

/** The language of a body for its disclaimer: Arabic when it has Arabic letters, else English. */
const langOf = (body: string): "ar" | "en" => (/[؀-ۿ]/.test(body) ? "ar" : "en");

/**
 * The body with its sector's disclaimer as a last line, in the body's own language. Idempotent: a body that already
 * carries the line (in either language) is returned unchanged, so a regenerated or re-saved item never gets it twice.
 */
export function withDisclaimer(body: string, sector: Sector): string {
  const d = DISCLAIMER[sector];
  if (body.includes(d.ar) || body.includes(d.en)) return body;
  const line = d[langOf(body)];
  return body.trim() ? `${body.trimEnd()}\n\n${line}` : line;
}

/**
 * A post cut to a platform's length (X: 280) that keeps a regulated brand's disclaimer line whole (rule 1524). Only a
 * regulated brand's customer-facing item carries one of the `DISCLAIMER` lines (`withDisclaimer`), so the line itself marks
 * it: the body is trimmed and the line stays at the end. Any other text is cut exactly as before (`slice(0, max)`). Lengths
 * are UTF-16 units, like that slice; a cut never ends on half a surrogate pair.
 */
export function cutKeepingDisclaimer(text: string, max: number): string {
  if (text.length <= max) return text;
  const line = Object.values(DISCLAIMER).flatMap((d) => [d.ar, d.en]).find((l) => text.includes(l));
  if (!line || line.length > max) return text.slice(0, max);
  const at = text.lastIndexOf(line);
  const body = `${text.slice(0, at)}${text.slice(at + line.length)}`.trim();
  let cut = body.slice(0, Math.max(0, max - line.length - 2)).trimEnd();
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1).trimEnd();
  return cut ? `${cut}\n\n${line}` : line;
}
