import { normalize } from "./brand-rules";

/**
 * Did the owner's own latest message ask for paid work (rule 1510)? The chat tools that spend credits (`generate_content`,
 * `draft_items`, `generate_image`) run straight away only when it did; otherwise the spend waits on a card the owner runs
 * with one tap (src/lib/spend-proposals.ts), or, over MCP, is refused. Only the owner's typed text is read here, never a
 * tool result, a file, a crawled page or the model's own words: those reach the model, and a model that read "generate 30
 * posts" in a catalogue must not be able to spend on it.
 *
 * Deterministic on purpose: word lists in Arabic (Gulf and MSA) and English, after the brand-rules folding (alef forms,
 * yaa, taa marbuta, diacritics, lower case). A request is a request verb that is not negated or asked about, together
 * with a deliverable noun in the same clause ("اكتب لي 3 منشورات", "write this week's plan"), or a clause that opens with
 * a number and a deliverable ("10 منشورات لليوم الوطني"). An image request is a drawing verb ("ارسم", "draw"), or a
 * request verb with an image noun ("سوّ صورة للمنشور"). Anything else, including a bare "yes" or "تمام", is not explicit:
 * the card asks once, with the price on it. The lists are exported so the founder can review them.
 */
export type SpendKind = "content" | "image";

/** Arabic request verbs matched as the start of a word (اكتب: اكتبي، اكتبلي، اكتبها). */
export const AR_VERB_PREFIXES = ["اكتب", "اعمل", "جهز", "انشي", "ولد", "صمم", "ارسم", "نفذ", "تكتب", "تسوي", "تجهز", "تعمل", "تصمم", "ترسم", "تحضر", "تولد", "تنشي", "نكتب", "نسوي", "نجهز", "اريد", "احتاج", "نحتاج", "محتاج", "ابغي", "ابغا", "نبغي", "بغيت", "اعطني", "عطني", "عطيني", "ابدا", "راجع", "حلل", "لخص", "قيم", "احسب"] as const;
/** Arabic request verbs matched as whole words (short words whose prefix would catch other words). */
export const AR_VERB_WORDS = ["سو", "سوي", "سويلي", "سوولي", "سويها", "سوها", "سوو", "حضر", "حضرلي", "حضري", "حضرها", "طلعلي", "هات", "ابي", "ابا", "ودي", "نبي", "نريد"] as const;
/** English request verbs (a trailing "s" is dropped before the match: "writes" is "write"). */
export const EN_VERBS = ["write", "draft", "create", "generate", "make", "produce", "prepare", "compose", "design", "draw", "render", "build", "give", "run", "redo", "rewrite", "craft", "need", "want", "start", "illustrate", "review", "analyze", "analyse", "audit", "summarize", "summarise", "forecast", "calculate"] as const;
/** Deliverable nouns: Arabic matched as the start of a word once و/ف and ال/لل/بال are taken off, English as whole words (a trailing "s" dropped). */
export const AR_NOUNS = ["بوست", "منشور", "محتوي", "مقال", "اعلان", "رسال", "رسايل", "واتس", "كابشن", "تغريد", "ستوري", "ريلز", "خطه", "خطط", "تقويم", "سكربت", "سكريبت", "سيناريو", "تقرير", "تقارير", "تقديمي", "استراتيجي", "حمله", "حملات", "دفعه", "مسوده", "مسودات", "ايميل", "سلسله", "مذكره", "خارطه", "تسعير", "توقعات", "تحليل", "مراجعه", "تجارب", "فيديو", "داشبورد", "لوحه", "اهداف", "ملخص", "اسعار", "ميزانيه", "مبيعات", "ارباح", "تكاليف", "منافس"] as const;
/** Short Arabic deliverable nouns matched as whole words only (as a prefix, نص would catch نصيحه and رد would catch ردت). */
export const AR_NOUN_WORDS = ["نص", "نصوص", "رد", "ردود", "عرض", "عروض", "سعر"] as const;
export const EN_NOUNS = ["post", "caption", "content", "article", "blog", "ad", "advert", "advertisement", "copy", "message", "whatsapp", "tweet", "thread", "story", "storie", "reel", "plan", "calendar", "script", "report", "deck", "presentation", "strategy", "memo", "okr", "prd", "roadmap", "forecast", "review", "experiment", "sequence", "email", "campaign", "batch", "draft", "playbook", "analysis", "pitch", "outline", "follow", "followup", "gbp", "offer", "text", "reply", "replie", "newsletter", "headline", "slogan", "tagline", "description", "bio", "landing", "video", "price", "pricing", "budget", "sales", "margin", "competitor", "economic", "cash"] as const;
/** Image nouns, both languages, matched like the deliverable nouns. */
export const AR_IMAGE_NOUNS = ["صوره", "تصميم", "رسمه", "فيجوال", "جرافيك", "بصري", "بنر", "بانر", "بوستر", "ثمبنيل"] as const;
export const AR_IMAGE_NOUN_WORDS = ["صور"] as const;
export const EN_IMAGE_NOUNS = ["image", "picture", "pic", "photo", "visual", "graphic", "illustration", "artwork", "banner", "thumbnail", "poster"] as const;
/** Verbs that ask for a drawing on their own. */
export const DRAW_VERBS = { ar: ["ارسم", "ترسم"], en: ["draw", "illustrate"] } as const;
/** Verbs that add an image to an item: a request only together with an image noun. */
export const ATTACH_VERBS = ["اضف", "ضيف", "حط", "ركب", "add", "put", "attach"] as const;
/** Words that cancel a request verb up to three words after them in the same clause: a negation, or a question about how or why. */
export const NEGATIONS = ["لا", "ما", "مو", "مب", "مش", "ماني", "بدون", "بلاش", "الغ", "الغي", "وقف", "dont", "not", "no", "never", "stop", "without", "cancel", "doesnt", "didnt", "wont", "shouldnt"] as const;
export const QUESTIONS = ["كيف", "ليش", "لماذا", "ليه", "وش", "ايش", "شو", "ماذا", "متي", "وين", "how", "why", "what", "when", "where", "should", "whether"] as const;
/** Number words that may open a request ("ثلاث منشورات", "five posts"); digits in any script count too. */
export const NUMBER_WORDS = ["واحد", "اثنين", "ثنتين", "ثلاث", "ثلاثه", "اربع", "اربعه", "خمس", "خمسه", "ست", "سته", "سبع", "سبعه", "ثمان", "ثماني", "تسع", "تسعه", "عشر", "عشره", "عشرين", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "twenty"] as const;

const NEG = new Set<string>([...NEGATIONS, ...QUESTIONS]);
const NUM = new Set<string>(NUMBER_WORDS);
const WINDOW = 3;
const has = (list: readonly string[], w: string) => list.includes(w);
const isArabic = (w: string) => /[؀-ۿ]/.test(w);
/** A word as written and without a leading و or ف ("واكتب", "فسوي"). */
const stripConj = (w: string) => (w.length > 2 && (w.startsWith("و") || w.startsWith("ف")) ? [w, w.slice(1)] : [w]);
const ARTICLES = ["وال", "فال", "بال", "كال", "لل", "ال", "ل", "ب"];
/** A noun as written, without و/ف, and without the article and its prepositions ("للمنشور", "بالصور"). */
function nounForms(w: string): string[] {
  const out = new Set<string>([w]);
  for (const f of stripConj(w)) {
    out.add(f);
    for (const a of ARTICLES) if (f.length > a.length + 1 && f.startsWith(a)) out.add(f.slice(a.length));
  }
  return [...out];
}
const enStem = (w: string) => (w.length > 2 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
const arVerb = (f: string, prefixes: readonly string[]) => has(AR_VERB_WORDS, f) || prefixes.some((p) => f.startsWith(p));

function isVerb(w: string, extra: readonly string[] = []): boolean {
  if (isArabic(w)) return stripConj(w).some((f) => arVerb(f, AR_VERB_PREFIXES) || extra.some((p) => isArabic(p) && f.startsWith(p)));
  const s = enStem(w);
  return has(EN_VERBS, w) || has(EN_VERBS, s) || has(extra, w) || has(extra, s);
}
function isNoun(w: string, ar: readonly string[], en: readonly string[], arWords: readonly string[]): boolean {
  if (isArabic(w)) return nounForms(w).some((f) => has(arWords, f) || ar.some((n) => f.startsWith(n)));
  return has(en, w) || has(en, enStem(w));
}
const isDraw = (w: string) => (isArabic(w) ? stripConj(w).some((f) => DRAW_VERBS.ar.some((p) => f.startsWith(p))) : has(DRAW_VERBS.en, w) || has(DRAW_VERBS.en, enStem(w)));
const contentNoun = (w: string) => isNoun(w, AR_NOUNS, EN_NOUNS, AR_NOUN_WORDS);
const imageNoun = (w: string) => isNoun(w, AR_IMAGE_NOUNS, EN_IMAGE_NOUNS, AR_IMAGE_NOUN_WORDS);
const isNumber = (w: string) => /^\p{N}+$/u.test(w) || NUM.has(w);
/** "لاتكتب": the negation glued to the verb. */
const gluedNegation = (w: string) => w.length > 3 && w.startsWith("لا") && isVerb(w.slice(2));

/** The clauses of a message, each as its folded words. Apostrophes are dropped first, so "don't" is one word. */
export function clauses(text: string): string[][] {
  return normalize(text.replace(/['’`]/g, ""))
    .split(/[.!?؟،,;؛\n]+/)
    .map((c) => c.split(/[^\p{L}\p{N}]+/u).filter(Boolean))
    .filter((c) => c.length > 0);
}

/**
 * Whether a clause holds a request verb that nothing in the three words before it cancels, and, when `noun` is given, a
 * noun that is another word of the clause (so "review" alone, both a verb and a noun, is not a request).
 */
function liveVerb(words: string[], test: (w: string) => boolean, noun?: (w: string) => boolean): boolean {
  return words.some((w, i) => {
    if (gluedNegation(w) || !test(w)) return false;
    if (words.slice(Math.max(0, i - WINDOW), i).some((b) => stripConj(b).some((f) => NEG.has(f)))) return false;
    return !noun || words.some((x, j) => j !== i && noun(x));
  });
}

/**
 * True when the owner's own message explicitly asks for paid work of this kind. `content`: a text batch or drafts.
 * `image`: a render for an item. Pure and synchronous: the gate reads no store and costs nothing.
 */
export function spendIntent(text: unknown, kind: SpendKind): boolean {
  if (typeof text !== "string" || !text.trim()) return false;
  for (const words of clauses(text.slice(0, 4000))) {
    if (kind === "image") {
      if (liveVerb(words, isDraw)) return true;
      if (liveVerb(words, (w) => isVerb(w, ATTACH_VERBS), imageNoun)) return true;
      continue;
    }
    if (liveVerb(words, (w) => isVerb(w), (w) => contentNoun(w) || imageNoun(w))) return true;
    // "10 منشورات لليوم الوطني", "5 posts for Ramadan": a clause that opens with a number and a deliverable.
    if (isNumber(words[0]) && words.slice(1, 3).some(contentNoun)) return true;
  }
  return false;
}
