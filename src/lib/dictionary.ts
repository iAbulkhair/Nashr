import type { L } from "./home";
import type { AgentId } from "./agents";
import type { Lang } from "./i18n";

/**
 * قاموس ذكين ("The Thakeen Dictionary") — the homepage's interactive game. Pure reducer + copy tables; the UI (a
 * later task) drives a `useReducer` with this module and feeds every keystroke of the brand input through the
 * `brand` action. Type-only imports on purpose: this module is imported by client components and must not pull in
 * any server-only value (see `tests/client-bundle.test.ts`).
 *
 * Controller ruling R1: the `brand` action collapses whitespace runs to a single space, trims the START only (not
 * the end), then caps at `BRAND_MAX`. Trimming the end would erase the space the user just typed on every keystroke
 * and make a name like "قهوة الصباح" untypeable through a controlled input. `canAdvance` and the sample generators
 * account for this by using `brand.trim()` where a clean value is needed.
 */

export type SectorId = "coffee" | "restaurant" | "clinic" | "store" | "services";

export type WordId =
  | "bold"
  | "warm"
  | "refined"
  | "popular"
  | "calm"
  | "luxury"
  | "fun"
  | "local"
  | "fast"
  | "honest"
  | "family"
  | "youthful";

export type Step = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type DictState = { step: Step; brand: string; sector: SectorId | null; words: WordId[] };

export type DictAction =
  | { type: "brand"; value: string }
  | { type: "sector"; value: SectorId }
  | { type: "word"; value: WordId }
  | { type: "next" }
  | { type: "back" }
  | { type: "approve" }
  | { type: "reset" };

export const MAX_WORDS = 5;
export const BRAND_MAX = 40;

export const INITIAL: DictState = { step: 1, brand: "", sector: null, words: [] };

export function canAdvance(s: DictState): boolean {
  switch (s.step) {
    case 1:
      return s.brand.trim() !== "" && s.sector !== null;
    case 2:
      return s.words.length === MAX_WORDS;
    case 3:
    case 4:
    case 6:
      return true;
    case 5:
    case 7:
      return false;
  }
}

export function reduce(s: DictState, a: DictAction): DictState {
  switch (a.type) {
    case "brand": {
      const collapsed = a.value.replace(/\s+/g, " ").trimStart();
      return { ...s, brand: collapsed.slice(0, BRAND_MAX) };
    }
    case "sector":
      return { ...s, sector: a.value };
    case "word": {
      const has = s.words.includes(a.value);
      if (has) return { ...s, words: s.words.filter((w) => w !== a.value) };
      if (s.words.length >= MAX_WORDS) return s;
      return { ...s, words: [...s.words, a.value] };
    }
    case "next":
      return s.step !== 5 && s.step < 7 && canAdvance(s) ? { ...s, step: (s.step + 1) as Step } : s;
    case "back":
      return { ...s, step: Math.max(1, s.step - 1) as Step };
    case "approve":
      return s.step === 5 ? { ...s, step: 6 } : s;
    case "reset":
      return INITIAL;
  }
}

export const SECTORS: { id: SectorId; name: L }[] = [
  { id: "coffee", name: { ar: "قهوة", en: "Coffee" } },
  { id: "restaurant", name: { ar: "مطعم", en: "Restaurant" } },
  { id: "clinic", name: { ar: "عيادة", en: "Clinic" } },
  { id: "store", name: { ar: "متجر إلكتروني", en: "Online store" } },
  { id: "services", name: { ar: "خدمات", en: "Services" } },
];

export const WORDS: { id: WordId; name: L; tone: L; react: { who: AgentId; text: L } }[] = [
  {
    id: "bold",
    name: { ar: "جريء", en: "Bold" },
    tone: { ar: "جريئة", en: "bold" },
    react: { who: "faris", text: { ar: "«يعجبني.»", en: '"I like it."' } },
  },
  {
    id: "warm",
    name: { ar: "دافي", en: "Warm" },
    tone: { ar: "دافية", en: "warm" },
    react: { who: "sami", text: { ar: "«العميل يحس فيها.»", en: '"Customers feel that."' } },
  },
  {
    id: "refined",
    name: { ar: "راقي", en: "Refined" },
    tone: { ar: "راقية", en: "refined" },
    react: { who: "majed", text: { ar: "«بشرط ما نبالغ.»", en: '"As long as we don\'t overdo it."' } },
  },
  {
    id: "popular",
    name: { ar: "شعبي", en: "Down-to-earth" },
    tone: { ar: "شعبية", en: "down-to-earth" },
    react: { who: "noor", text: { ar: "«قريب من الناس، أبشر.»", en: '"Close to people. Done."' } },
  },
  {
    id: "calm",
    name: { ar: "هادي", en: "Calm" },
    tone: { ar: "هادية", en: "calm" },
    react: { who: "layan", text: { ar: "«الهدوء يرجّع العميل.»", en: '"Calm brings customers back."' } },
  },
  {
    id: "luxury",
    name: { ar: "فاخر", en: "Luxurious" },
    tone: { ar: "فاخرة", en: "luxurious" },
    react: { who: "razan", text: { ar: "«والسعر يشبهه؟»", en: '"Does the price match?"' } },
  },
  {
    id: "fun",
    name: { ar: "مرح", en: "Playful" },
    tone: { ar: "مرحة", en: "playful" },
    react: { who: "noor", text: { ar: "«ترند جاهز.»", en: '"A trend waiting to happen."' } },
  },
  {
    id: "local",
    name: { ar: "محلي", en: "Local" },
    tone: { ar: "محلية", en: "local" },
    react: { who: "faris", text: { ar: "«نبدأ من الحي.»", en: '"We start with the neighbourhood."' } },
  },
  {
    id: "fast",
    name: { ar: "سريع", en: "Quick" },
    tone: { ar: "سريعة", en: "quick" },
    react: { who: "sami", text: { ar: "«أرد قبل ما يبرد العميل.»", en: '"I reply before the lead goes cold."' } },
  },
  {
    id: "honest",
    name: { ar: "صادق", en: "Honest" },
    tone: { ar: "صادقة", en: "honest" },
    react: { who: "dana", text: { ar: "«هذي كلمتي.»", en: '"That\'s my word."' } },
  },
  {
    id: "family",
    name: { ar: "عائلي", en: "Family" },
    tone: { ar: "عائلية", en: "family-friendly" },
    react: { who: "layan", text: { ar: "«العائلة ترجع.»", en: '"Families come back."' } },
  },
  {
    id: "youthful",
    name: { ar: "شبابي", en: "Youthful" },
    tone: { ar: "شبابية", en: "youthful" },
    react: { who: "noor", text: { ar: "«تيك توك يناديك.»", en: '"TikTok is calling."' } },
  },
];

type PlanLines = { line1: L; line2: L; line3: L };

const PLAN: Record<SectorId, PlanLines> = {
  coffee: {
    line1: {
      ar: "الأحد: صورة أول كوب في الصباح، بنبرة {tone}.",
      en: "Sunday: the first cup of the morning, in a {tone} voice.",
    },
    line2: { ar: "الثلاثاء: رسالة واتساب لعملاء الأسبوع الماضي.", en: "Tuesday: a WhatsApp note to last week's customers." },
    line3: { ar: "الخميس: سؤال للمتابعين: وش قهوتكم للويكند؟", en: "Thursday: ask followers what they're drinking this weekend." },
  },
  restaurant: {
    line1: { ar: "الأحد: طبق الأسبوع بصورة قريبة، بنبرة {tone}.", en: "Sunday: the dish of the week, close up, in a {tone} voice." },
    line2: { ar: "الأربعاء: عرض الغداء لأهل الدوام.", en: "Wednesday: the lunch offer for the office crowd." },
    line3: { ar: "الجمعة: قصة المطبخ قبل الافتتاح.", en: "Friday: a kitchen story from before opening." },
  },
  clinic: {
    line1: { ar: "الأحد: نصيحة قصيرة من الطبيب، بنبرة {tone}.", en: "Sunday: a short tip from the doctor, in a {tone} voice." },
    line2: { ar: "الثلاثاء: تذكير بالمواعيد عبر واتساب.", en: "Tuesday: an appointment reminder on WhatsApp." },
    line3: { ar: "الخميس: سؤال شائع وجوابه.", en: "Thursday: a common question, answered." },
  },
  store: {
    line1: { ar: "الأحد: منتج الأسبوع، بنبرة {tone}.", en: "Sunday: the product of the week, in a {tone} voice." },
    line2: { ar: "الثلاثاء: رسالة لمن ترك السلة.", en: "Tuesday: a note to everyone who left their cart." },
    line3: { ar: "الخميس: الجديد قبل الويكند.", en: "Thursday: what's new, before the weekend." },
  },
  services: {
    line1: {
      ar: "الأحد: مشكلة يعرفها عميلك وكيف تحلها، بنبرة {tone}.",
      en: "Sunday: a problem your customer knows, and how you solve it, in a {tone} voice.",
    },
    line2: { ar: "الثلاثاء: متابعة لمن طلب عرض سعر.", en: "Tuesday: a follow-up to everyone who asked for a quote." },
    line3: { ar: "الخميس: خلف الكواليس: كيف نشتغل.", en: "Thursday: behind the scenes, how we work." },
  },
};

const POST: Record<SectorId, L> = {
  coffee: { ar: "{brand}: أول كوب يرتّب يومك.", en: "{brand}: the first cup that sorts your day." },
  restaurant: { ar: "{brand}: طبق اليوم ينتظرك.", en: "{brand}: today's dish is waiting for you." },
  clinic: {
    ar: "{brand}: صحتك تستاهل موعد اليوم، مو بكرة.",
    en: "{brand}: your health deserves an appointment today, not tomorrow.",
  },
  store: {
    ar: "{brand}: وصل الجديد. خذ نظرة قبل الويكند.",
    en: "{brand}: new arrivals are in. Take a look before the weekend.",
  },
  services: {
    ar: "{brand}: نشيل عنك الشغل اللي ياخذ وقتك.",
    en: "{brand}: we take the work that eats your time.",
  },
};

const WHATSAPP: L = {
  ar: "هلا! شكراً لسؤالك عن {brand}. تبي أرسل لك التفاصيل هنا، ولا نتصل فيك؟",
  en: "Hi! Thanks for asking about {brand}. Shall I send the details here, or would you like a call?",
};

/**
 * Puts a value into a template's placeholder as literal text. A replacement string would read `$&`, `$'`, `` $` `` and
 * `$$` in it, and the brand is whatever the visitor typed; a replacement function is never read that way.
 */
const fill = (template: string, placeholder: string, value: string) => template.replaceAll(placeholder, () => value);

export function samplePlan(s: DictState, lang: Lang): string[] {
  const sector = s.sector ?? "coffee";
  const lines = PLAN[sector];
  const firstWord = WORDS.find((w) => w.id === s.words[0]);
  const tone = firstWord ? firstWord.tone[lang] : "";
  return [fill(lines.line1[lang], "{tone}", tone), lines.line2[lang], lines.line3[lang]];
}

export function sampleDraft(s: DictState, lang: Lang): { post: string; whatsapp: string } {
  const sector = s.sector ?? "coffee";
  const brand = s.brand.trim();
  return {
    post: fill(POST[sector][lang], "{brand}", brand),
    whatsapp: fill(WHATSAPP[lang], "{brand}", brand),
  };
}

export const DICT_COPY: {
  title: L;
  subtitle: L;
  steps: Record<Step, L>;
  example: L;
  greet: { who: AgentId; text: L };
  approve: L;
  approveNote: L;
  analysis: { who: AgentId; text: L };
  measure: L;
  cta: L;
  brandLabel: L;
  sectorLabel: L;
  next: L;
  back: L;
  counter: L;
} = {
  title: { ar: "قاموس ذكين", en: "The Thakeen Dictionary" },
  subtitle: { ar: "سبع خطوات، من اسم علامتك لأول نتيجة.", en: "Seven steps, from your brand's name to its first result." },
  steps: {
    1: { ar: "براندك", en: "Your brand" },
    2: { ar: "كلماتك", en: "Your words" },
    3: { ar: "خطة", en: "Plan" },
    4: { ar: "مسودة", en: "Draft" },
    5: { ar: "موافقتك", en: "Your approval" },
    6: { ar: "تحليل", en: "Analysis" },
    7: { ar: "قياس", en: "Measurement" },
  },
  example: { ar: "مثال", en: "Example" },
  greet: { who: "noor", text: { ar: "«حلو الاسم. خلّني أعرفكم.»", en: '"Nice name. Let me get to know you."' } },
  approve: { ar: "موافق", en: "Approve" },
  approveNote: { ar: "ولا شي ينتشر قبل هالضغطة.", en: "Nothing goes out before this tap." },
  analysis: {
    who: "dana",
    text: {
      ar: "«الأسبوع الجاي أقول لك وش نفع ووش ما نفع، من أرقامك أنت.»",
      en: '"Next week I\'ll tell you what worked and what didn\'t, from your own numbers."',
    },
  },
  measure: {
    ar: "نقيس من المصادر اللي تربطها: نتائج إعلانات ميتا وسناب، ومبيعات سلة وشوبيفاي وزد، أو ملف CSV.",
    en: "We measure from the sources you connect: Meta and Snapchat ad results, Salla, Shopify and Zid sales, or a CSV file.",
  },
  cta: { ar: "جرّبها على موقعك", en: "Try it on your website" },
  brandLabel: { ar: "وش اسم علامتك؟", en: "What's your brand called?" },
  sectorLabel: { ar: "وش تبيع؟", en: "What do you sell?" },
  next: { ar: "التالي", en: "Next" },
  back: { ar: "رجوع", en: "Back" },
  counter: { ar: "اخترت {n} من ٥", en: "{n} of 5 picked" },
};
