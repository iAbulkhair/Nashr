import { AGENCY_MIN, ONBOARD_EXTRA_BRAND_COST, PLAN_CREDITS, PLAN_PRICE_SAR, PLAN_SEATS, formatCount, type PublicTier } from "./pricing";
import { TASK_COST, TASK_COUNT, type TaskType } from "./tasks";
import { MEDIA_MODELS } from "./media-catalog";

export type Lang = "ar" | "en";
export const LANGS: Lang[] = ["ar", "en"];

export function isLang(v: string): v is Lang {
  return v === "ar" || v === "en";
}

// Every price, credit amount, seat count and task cost below is read from src/lib/pricing.ts, src/lib/tasks.ts or the
// media catalogue, never typed here: tests/pricing-copy.test.ts (rule 248) pins the cards, the credits table, the FAQ
// and the other public pages to those tables. The three modules imported above import nothing themselves.

/** "1 seat", "3 seats"; in Arabic "مقعد واحد", "مقعدان", "3 مقاعد" (3-10) and "11 مقعداً" (11 and up). */
export function seatsText(lang: Lang, n: number): string {
  if (lang === "en") return `${n} ${n === 1 ? "seat" : "seats"}`;
  return n === 1 ? "مقعد واحد" : n === 2 ? "مقعدان" : n <= 10 ? `${n} مقاعد` : `${n} مقعداً`;
}
/** "1 credit", "2 credits". */
const enCredits = (n: number) => `${n} ${n === 1 ? "credit" : "credits"}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** A task's cost as the credits table shows it: the batch, or one item of it (a post is one of ten). */
export const creditCost = (type: TaskType, perItem = false): number => (perItem ? TASK_COST[type] / (TASK_COUNT[type] || 1) : TASK_COST[type]);
/** "1–2": the lowest and highest price of a media kind in the catalogue. */
const mediaRange = (kind: "image" | "video") => {
  const c = MEDIA_MODELS.filter((m) => m.kind === kind).map((m) => m.credits);
  const lo = Math.min(...c), hi = Math.max(...c);
  return { lo, text: lo === hi ? String(lo) : `${lo}–${hi}` };
};

/**
 * The task types the pricing page's credits table names, in reading order. `perItem`: the row prices one item of the
 * batch. Rows are grouped by cost from TASK_COST / TASK_COUNT, so a price change moves a type to its new row by itself.
 */
export const CREDIT_TABLE_TYPES: readonly { type: TaskType; perItem?: boolean; label: Record<Lang, string> }[] = [
  { type: "social", perItem: true, label: { ar: "منشور سوشال", en: "social post" } },
  { type: "ads", perItem: true, label: { ar: "إعلان", en: "ad" } },
  { type: "whatsapp", perItem: true, label: { ar: "رسالة واتساب", en: "WhatsApp message" } },
  { type: "article", label: { ar: "مقال SEO", en: "SEO article" } },
  { type: "lead_qualifier", label: { ar: "بطاقة تأهيل", en: "lead qualification card" } },
  { type: "weekly_plan", label: { ar: "خطة الأسبوع", en: "weekly plan" } },
  { type: "weekly_report", label: { ar: "تقرير أسبوعي", en: "weekly report" } },
  { type: "unit_economics", label: { ar: "اقتصاديات الوحدة", en: "unit economics" } },
  { type: "sales_script", label: { ar: "سكربتات مبيعات", en: "sales scripts" } },
  { type: "pricing_review", label: { ar: "مراجعة تسعير", en: "pricing review" } },
  { type: "cash_forecast", label: { ar: "تدفق نقدي", en: "cash forecast" } },
  { type: "growth_experiments", label: { ar: "تجارب نمو", en: "growth experiments" } },
  { type: "followup_seq", label: { ar: "سلسلة متابعة", en: "follow-up cadence" } },
  { type: "gtm_plan", label: { ar: "خطة دخول للسوق", en: "go-to-market plan" } },
  { type: "board_deck", label: { ar: "عرض مجلس الإدارة", en: "board deck" } },
  { type: "strategy_review", label: { ar: "مراجعة استراتيجية", en: "strategy review" } },
];

/** The credits table: task rows by cost, the image range, then the free row and the added-brand setup row. */
function creditRows(lang: Lang): { action: string; cost: string }[] {
  const byCost = new Map<number, string[]>();
  for (const t of CREDIT_TABLE_TYPES) {
    const c = creditCost(t.type, t.perItem);
    byCost.set(c, [...(byCost.get(c) ?? []), t.label[lang]]);
  }
  const image = mediaRange("image");
  const priced = [
    ...[...byCost].map(([c, labels]) => ({ lo: c, action: cap(labels.join(" / ")), cost: String(c) })),
    { lo: image.lo, action: lang === "ar" ? "صورة" : "Image", cost: image.text },
  ].sort((a, b) => a.lo - b.lo); // stable: the image follows the task row of its lowest price
  return [
    ...priced.map(({ action, cost }) => ({ action, cost })),
    lang === "ar"
      ? { action: "الدردشة مع الفريق وإعداد علامتك الأولى من رابط موقعك", cost: "مجاناً" }
      : { action: "Chatting with the team and setting up your first brand from your URL", cost: "Free" },
    lang === "ar"
      ? { action: "إعداد كل علامة إضافية من رابطها (يُعاد إن تعذّر بناء ملف العلامة، والنموذج اليدوي مجاني)", cost: String(ONBOARD_EXTRA_BRAND_COST) }
      : { action: "Setting up each added brand from its URL (refunded if the brand file cannot be built; the manual form is free)", cost: String(ONBOARD_EXTRA_BRAND_COST) },
  ];
}

/** List prices for the pricing cards, the FAQ and the help copy, read from the plan table. */
const P = PLAN_PRICE_SAR;
const perPost = creditCost("social", true);

/** One card on the pricing page. `id` joins it to src/lib/pricing.ts (the billing page finds its card by id). */
export type PlanCard = {
  id: PublicTier;
  name: string;
  price: string;
  period: string;
  credits: string;
  tagline: string;
  features: string[];
  cta: string;
  highlight?: boolean;
};

export type Dict = {
  dir: "rtl" | "ltr";
  brand: string;
  agent: string;
  nav: { how: string; agents: string; industries: string; pricing: string; faq: string; cta: string; switchLang: string; switchHref: string; tools: string; blog: string };
  hero: {
    eyebrow: string;
    title1: string;
    title2: string;
    sub: string;
    cta: string;
    cta2: string;
    logTitle: string;
    logNote: string;
    log: { t: string; text: string; tag: string }[];
  };
  proof: { label: string; items: { n: string; l: string }[] };
  how: { eyebrow: string; title: string; steps: { title: string; body: string }[] };
  agents: { eyebrow: string; title: string; sub: string; items: { name: string; role: string; body: string; does: string[] }[] };
  industries: { eyebrow: string; title: string; items: { name: string; body: string }[] };
  integrations: { eyebrow: string; title: string; sub: string; groups: { label: string; items: string[] }[] };
  calendar: { eyebrow: string; title: string; sub: string; items: { when: string; name: string; play: string }[] };
  pricing: { eyebrow: string; title: string; sub: string; trial: string; annual: string; plans: PlanCard[]; creditsTitle: string; credits: { action: string; cost: string }[] };
  faq: { eyebrow: string; title: string; items: { q: string; a: string }[] };
  waitlist: { title: string; sub: string; email: string; company: string; industry: string; industries: string[]; submit: string; ok: string; err: string };
  footer: { tagline: string; rights: string; links: { label: string; href: string }[] };
};

export const dict: Record<Lang, Dict> = {
  ar: {
    dir: "rtl",
    brand: "ذكين",
    agent: "نور",
    nav: { how: "كيف تعمل", agents: "الوكلاء", industries: "القطاعات", pricing: "الأسعار", faq: "الأسئلة", cta: "ابدأ مجاناً", switchLang: "English", switchHref: "/en", tools: "أدوات مجانية", blog: "المدونة" },
    hero: {
      eyebrow: "فريق تسويق كامل يعمل بالذكاء الاصطناعي — مبني للخليج",
      title1: "أنت توافق،",
      title2: "نور تسوّق.",
      sub: "نور وكيلة تسويق تخطط وتكتب بالعربي وبالإنجليزي، وحين تعتمد العنصر وتضغط «انشر» أو تطلب منها في الدردشة، تنشره على Telegram أو ترسل المقال مسودة إلى WordPress. أنت توافق، هي تنفّذ.",
      cta: "ابدأ تجربتك المجانية",
      cta2: "شاهد مثالاً من يومها",
      logTitle: "مثال من أسبوع مع نور",
      logNote: "مثال توضيحي، لا حساب حقيقي. خطة الأسبوع تُجهَّز تلقائياً صباح الأحد، وباقي العناصر عندما تطلبها، ولا يُنشر شيء قبل موافقتك.",
      log: [
        { t: "06:00", text: "جهّزت مسودة خطة الأسبوع من ملف علامتك وتقويم المواسم، وأرسلتها لصندوق الموافقة.", tag: "خطة" },
        { t: "09:00", text: "بناءً على طلبك، كتبت كابشنات الأسبوع بلهجة علامتك.", tag: "سوشال" },
        { t: "09:05", text: "كل عنصر ينتظر موافقتك في الصندوق. لا يُنشر شيء قبل أن توافق.", tag: "موافقة" },
        { t: "10:00", text: "عُدِّل أحد الكابشنات قبل اعتماده، فحفظتُ التعديل لأكتب على طريقتك في المرة القادمة.", tag: "تعلّم" },
        { t: "10:30", text: "بناءً على طلبك، أرسلت المقال المعتمد كمسودة إلى WordPress.", tag: "مقالات" },
        { t: "10:45", text: "بناءً على طلبك، نشرت المنشور المعتمد على قناتك في Telegram.", tag: "نشر" },
      ],
    },
    proof: {
      label: "لماذا الآن",
      items: [
        { n: "12", l: "موسم بيع خليجي في السنة — كلها في تقويم نور" },
        { n: "8:00", l: "صباحاً بتوقيت السعودية: ملخصك في التطبيق، كل يوم" },
      ],
    },
    how: {
      eyebrow: "كيف تعمل",
      title: "اربط، وافق، وخلّها تشتغل.",
      steps: [
        { title: "اربط قنواتك", body: "WordPress لمسودات المقالات، وTelegram لنشر ما توافق عليه، ومنتجات متجرك على سلة أو زد أو شوبيفاي أو WooCommerce تُستورد من رابطه — بدون تصدير ملفات." },
        { title: "نور تتعلم علامتك", body: "تقرأ موقعك ومنتجاتك، وتبني ملف صوت العلامة: اللهجة، الأسلوب، الممنوعات، والمنافسين." },
        { title: "خطة أسبوعية من بياناتك", body: "من ملف علامتك ومنتجاتك وتعديلاتك السابقة تقترح خطة: ماذا ننشر، أين نعلن، ولمن نرسل. مبنية على التقويم الخليجي." },
        { title: "أنت توافق، هي تنفّذ", body: "صندوق موافقة واحد. اقبل أو عدّل أو ارفض. كل تعديل يعلّمها." },
        { title: "ملخص الصباح", body: "ما ينتظر موافقتك، ما اعتمدته، رصيدك، المواسم القريبة، والخطوة التالية. ملخص قصير في التطبيق." },
      ],
    },
    agents: {
      eyebrow: "الوكلاء",
      title: "نور تقود التسويق. وفريقها يغطي المبيعات والمالية والنمو والتقارير.",
      sub: "فريق كامل يعمل من ملف علامتك نفسه. كل عنصر ينتظر موافقتك.",
      items: [
        { name: "نور", role: "التسويق", body: "تخطط وتكتب محتواك لكل القنوات. هي التي تجهّز ملخصك الصباحي.", does: ["الخطة الأسبوعية", "منشورات ومقالات SEO", "واتساب وإعلانات", "Google Business"] },
        { name: "سامي", role: "تمكين المبيعات", body: "يحوّل الاهتمام إلى صفقات: تأهيل العملاء، سكربتات، اعتراضات، متابعة.", does: ["بطاقة تأهيل العملاء", "سكربت مكالمة وواتساب", "جدول الاعتراضات", "سلسلة متابعة 7 رسائل"] },
        { name: "رزان", role: "المالية والتسعير", body: "تسعير بالريال شامل الضريبة، اقتصاديات الوحدة، وتدفق نقدي لـ 90 يوماً.", does: ["مراجعة التسعير", "اقتصاديات الوحدة", "توقع التدفق النقدي", "مراجعة الإيرادات"] },
        { name: "فارس", role: "الدخول للسوق والنمو", body: "التموضع، خطة 90 يوماً، تجارب نمو بتقييم ICE، والاحتفاظ والإحالة.", does: ["خطة GTM", "5 تجارب نمو", "3 خطط احتفاظ", "برامج الإحالة"] },
        { name: "دانة", role: "التقارير والعروض", body: "تقرير أسبوعي صادق من بياناتك، مواصفة لوحة المؤشرات، وعرض مجلس إدارة يُحمَّل PowerPoint.", does: ["التقرير الأسبوعي", "لوحة المؤشرات", "عرض المستثمرين", "الملخص التنفيذي"] },
        { name: "ماجد", role: "المستشار التنفيذي", body: "فريقك التنفيذي في شخص واحد: مراجعة استراتيجية، أهداف الربع، مذكرات قرار، قرارات محفظة المنتجات، وأين يفيدك الذكاء الاصطناعي فعلاً.", does: ["مراجعة 90 يوماً", "OKRs", "مذكرة قرار", "محفظة المنتجات", "خطة تبنّي الذكاء الاصطناعي"] },
        { name: "ليان", role: "المنتج والاحتفاظ", body: "من فكرة إلى PRD وخارطة طريق، ومن عميل جديد إلى عميل يعود: التفعيل والاحتفاظ والمتابعة.", does: ["PRD", "خارطة طريق RICE", "تحليل آراء العملاء", "رحلة التفعيل"] },
        { name: "ريم", role: "السكرتيرة", body: "تحفظ مهامك ومتابعاتك وما لك عند غيرك، بمواعيد بتوقيت بلدك تعيدها عليك. لا تغلق شيئاً إلا بتأكيدك.", does: ["قائمة المهام", "المتابعات", "ما لك عند غيرك", "المتأخر في ملخص الصباح"] },
      ],
    },
    industries: {
      eyebrow: "القطاعات",
      title: "مبنية لمن يبيع في الخليج.",
      items: [
        { name: "متاجر سلة وزد وشوبيفاي", body: "رسائل السلات المتروكة، مواسم البيع، وصف منتجات بالعربي." },
        { name: "العقار والمطورون", body: "حملات إطلاق المشاريع، سكربتات واتساب لتأهيل المستفسرين، محتوى للوسطاء." },
        { name: "المكاتب القانونية", body: "محتوى توعوي عام، مقالات SEO ومنشورات Google Business، وأسئلة تأهيل الاستشارات." },
        { name: "الشركات الناشئة", body: "إطلاق منتج، LinkedIn وX، تجارب نمو أسبوعية بميزانية محدودة." },
        { name: "العيادات والتجميل", body: "منشورات Google Business Profile، رسائل حجز عبر واتساب، ومحتوى يراعي ضوابط الإعلان الطبي." },
        { name: "المطاعم والضيافة", body: "عروض يومية، مراجعات، توصيل، محتوى مرئي بلهجة محلية." },
        { name: "وكالات التسويق", body: "عدة علامات من حساب واحد على أي خطة، ولكل علامة ملفها وصندوق موافقتها." },
        { name: "الخدمات المهنية", body: "محاسبة، استشارات، تعليم — محتوى يبني الثقة، مقالات SEO ومنشورات Google Business." },
      ],
    },
    integrations: {
      eyebrow: "التكاملات",
      title: "الأدوات التي تستخدمها فعلاً.",
      sub: "ليست قائمة أمريكية. القنوات الخليجية أولاً.",
      groups: [
        { label: "التجارة", items: ["سلة (استيراد المنتجات من الرابط)", "زد (استيراد المنتجات من الرابط)", "Shopify (استيراد المنتجات من الرابط)", "WooCommerce"] },
        { label: "النشر", items: ["Telegram", "WordPress (مسودات)", "X (قريباً)"] },
      ],
    },
    calendar: {
      eyebrow: "التقويم الخليجي",
      title: "المواسم مبرمجة. وخطتك الأسبوعية تراعيها.",
      sub: "نور تذكّرك بالمواسم القريبة في ملخص الصباح، وتراعيها في الخطة والمحتوى.",
      items: [
        { when: "شعبان", name: "ما قبل رمضان", play: "بناء الجمهور، عروض مبكرة، محتوى استعداد" },
        { when: "رمضان", name: "رمضان", play: "نشر بعد الإفطار، إعلانات ليلية، عروض العشر الأواخر" },
        { when: "شوال", name: "عيد الفطر", play: "هدايا، توصيل سريع، رسائل تهنئة للعملاء" },
        { when: "ذو الحجة", name: "عيد الأضحى", play: "حملات العائلة، عروض ما بعد الحج" },
        { when: "22 فبراير", name: "يوم التأسيس", play: "محتوى هوية، إصدارات محدودة" },
        { when: "23 سبتمبر", name: "اليوم الوطني السعودي", play: "أكواد خصم برقم الذكرى، تصاميم باللون الأخضر" },
        { when: "2 ديسمبر", name: "اليوم الوطني الإماراتي", play: "حملات موازية للسوق الإماراتي" },
        { when: "نوفمبر", name: "الجمعة البيضاء", play: "تسخين من أكتوبر، حملات ريتارقت مكثفة" },
        { when: "ديسمبر - يناير", name: "مهرجان دبي للتسوق", play: "عروض سياحية، محتوى بالإنجليزية" },
        { when: "أغسطس", name: "العودة للمدارس", play: "حزم عائلية، تقسيط تابي وتمارا" },
      ],
    },
    pricing: {
      eyebrow: "الأسعار",
      title: "أرخص من موظف واحد.",
      sub: "الأسعار بالريال السعودي غير شاملة الضريبة. ألغِ في أي وقت.",
      trial: "تجربة 3 أيام مجاناً — بدون بطاقة",
      annual: "ادفع سنوياً ووفّر شهرين (قريباً)",
      plans: [
        { id: "starter", name: "البداية", price: String(P.starter), period: "ريال / شهر", credits: `${formatCount(PLAN_CREDITS.starter)} كريدت شهرياً`, tagline: "للتاجر الفرد والمبدع", features: [`علامات بلا حد، ${seatsText("ar", PLAN_SEATS.starter)}`, "منشورات سوشال (الصور قريباً)", "مقالات SEO بالعربي", "نسخ إعلانية لسناب وميتا", "ملخص يومي 8 صباحاً", "كتيّبات جاهزة لقطاعات الخليج", "وصول MCP"], cta: "ابدأ مجاناً" },
        { id: "pro", name: "الاحتراف", price: String(P.pro), period: "ريال / شهر", credits: `${formatCount(PLAN_CREDITS.pro)} كريدت شهرياً`, tagline: "للمؤسس والمتجر والعيادة", highlight: true, features: ["كل ما في البداية", `${seatsText("ar", PLAN_SEATS.pro)} تشمل المالك، بدورَي مدير وعضو`, "ضبط الإعلانات تلقائياً ضمن حدودك (قريباً)", "حملات واتساب + استرجاع السلات (قريباً)", "تدقيق إعلانات أسبوعي وكشف الهدر (قريباً)"], cta: "ابدأ مجاناً" },
        { id: "business", name: "الأعمال", price: String(P.business), period: "ريال / شهر", credits: `${formatCount(PLAN_CREDITS.business)} كريدت شهرياً — يتجدد كل شهر ولا يترحّل`, tagline: "للفرق والشركات الأكبر", features: ["كل ما في الاحتراف", `${seatsText("ar", PLAN_SEATS.business)} تشمل المالك`, "تقارير بعلامتك للعملاء (قريباً)", "ضبط الإعلانات كل ساعتين (قريباً)"], cta: "ابدأ مجاناً" },
        { id: "agency", name: "الوكالات", price: "تواصل معنا", period: "فوترة سنوية", credits: `رصيد مخصص، من ${formatCount(AGENCY_MIN.credits)} كريدت شهرياً`, tagline: "للوكالات والمجموعات الكبيرة", features: ["الوكلاء المتخصصون كلهم", "استضافة البيانات داخل السعودية (قريباً)", "ربط CRM ومستودع البيانات (قريباً)", "تدريب نموذج على صوت علامتك (قريباً)", "مدير نجاح مخصص", "SLA ساعة واحدة (قريباً)", "عدد مقاعد حسب فريقك"], cta: "تواصل معنا" },
      ],
      creditsTitle: "كم تكلّف كل مهمة؟",
      credits: creditRows("ar"),
    },
    faq: {
      eyebrow: "الأسئلة الشائعة",
      title: "أسئلة؟ خذ الخلاصة.",
      items: [
        { q: "ليش ما أستخدم ChatGPT أو Claude مباشرة؟", a: "تقدر، وستقضي وقتك تكتب الأوامر وتنسخ وتلصق. نور مبنية للتسويق الخليجي: ملف علامة تقرؤه في كل مرة، كتيّبات لكل قطاع، تقويم رمضان والأعياد، مراجع ثانٍ للالتزام، صندوق موافقة، تقويم نشر، ونشر عبر التكاملات. وتتعلم من تعديلاتك." },
        { q: "هل تنشر نور بدون إذني؟", a: "لا. كل عنصر ينتظر موافقتك في الصندوق، والنشر دائماً بقرار منك. بعد أن تثق بها، تقدر تعتمد أنواعاً محددة تلقائياً من صفحة الحوكمة." },
        { q: "وش يعني ملخص الصباح؟", a: "كل يوم 08:00 بتوقيت السعودية: ما ينتظر موافقتك، ما اعتُمد، رصيدك، المواسم القريبة، ومتابعات الفريق (عناصر موعدها اليوم، أشياء تنتظرك من يومين). في التطبيق." },
        { q: "متى أشوف نتائج؟", a: "تكتب نور ملف العلامة وخطة 90 يوماً من رابط موقعك أثناء الإعداد، ثم تصلك أول دفعة محتوى عندما تطلبها." },
        { q: "كم تكلّف؟", a: `كريدت شهري حسب الخطة: البداية ${P.starter}، الاحتراف ${P.pro}، الأعمال ${P.business} ريال، والوكالات بعقد. منشور = ${perPost} كريدت، مقال = ${TASK_COST.article}، عرض مجلس إدارة = ${TASK_COST.board_deck}. الدردشة مع الفريق وإعداد علامتك الأولى مجاناً، وإعداد كل علامة إضافية من رابطها ${ONBOARD_EXTRA_BRAND_COST} كريدت. ولتغيير الخطة تواصل معنا.` },
        { q: "الخصوصية؟", a: "بياناتك لمساحة عملك فقط: لا تستخدمها منصة ذكين لتدريب النماذج، ولا تشاركها بين الحسابات. مفاتيح التكاملات مشفّرة. تحذف حسابك وبيانات مساحة عملك بنفسك من صفحة «حسابك»." },
        { q: "هل تتعلم صوت علامتي؟", a: "نعم. من موقعك أولاً، ثم من كل تعديل ورفض تكتبه، يُحفظ في preferences.md وتلتزم به." },
        { q: "أقدر ألغي؟", a: "نعم. تجربة 3 أيام بدون بطاقة، وبعدها تختار خطتك من صفحة الاشتراك. ولتغيير خطتك أو إلغائها، تواصل معنا." },
        { q: "من هم بقية الفريق؟", a: "سامي للمبيعات، رزان للمالية والتسعير، فارس للنمو، دانة للتقارير والعروض، ماجد المستشار التنفيذي، ليان للمنتج والاحتفاظ، وريم السكرتيرة لمهامك ومتابعاتك. كلهم في الدردشة نفسها ومن ملف العلامة نفسه." },
      ],
    },
    waitlist: {
      title: "احجز مكانك في الإطلاق.",
      sub: "أول 100 علامة تحصل على شهرين مجاناً على خطة الاحتراف ودعم إعداد شخصي.",
      email: "بريدك الإلكتروني",
      company: "اسم النشاط أو الموقع",
      industry: "القطاع",
      industries: ["متجر إلكتروني", "عقار", "قانوني", "شركة ناشئة", "عيادة", "مطعم", "وكالة", "أخرى"],
      submit: "احجز مكاني",
      ok: "تم! وصلتنا بياناتك.",
      err: "لم يتم الإرسال. جرّب مرة أخرى أو راسلنا على hello@nashr.ai",
    },
    footer: {
      tagline: "وكيلة تسويق مبنية للخليج.",
      rights: "© 2026 ذكين. جميع الحقوق محفوظة.",
      links: [
        { label: "الأسعار", href: "/ar/pricing" },
        { label: "أدوات مجانية", href: "/ar/tools" },
        { label: "المدونة", href: "/ar/blog" },
        { label: "الشركاء", href: "/ar/affiliates" },
        { label: "المساعدة", href: "/ar/help" },
        { label: "المقارنات", href: "/ar/vs/enrich-labs" },
        { label: "سياسة الخصوصية", href: "/ar/privacy" },
        { label: "الشروط", href: "/ar/terms" },
      ],
    },
  },
  en: {
    dir: "ltr",
    brand: "Thakeen",
    agent: "Noor",
    nav: { how: "How it works", agents: "Agents", industries: "Industries", pricing: "Pricing", faq: "FAQ", cta: "Start free", switchLang: "العربية", switchHref: "/ar", tools: "Free tools", blog: "Blog" },
    hero: {
      eyebrow: "An AI marketing team, built for the Gulf",
      title1: "You approve,",
      title2: "Noor markets.",
      sub: "Noor is an AI marketing agent that plans and writes in Arabic and English. When you approve an item and click Publish, or ask her in chat, she posts it to Telegram or sends the article to WordPress as a draft. You approve. She executes.",
      cta: "Start your free trial",
      cta2: "See a sample of her work",
      logTitle: "A sample week with Noor",
      logNote: "An illustrative example, not a real account. The weekly plan is drafted automatically on Sunday morning, everything else when you ask, and nothing is published before you approve.",
      log: [
        { t: "06:00", text: "Drafted this week's plan from your brand file and the seasons calendar, and sent it to your approvals inbox.", tag: "Plan" },
        { t: "09:00", text: "At your request, wrote the week's captions in your brand's dialect.", tag: "Social" },
        { t: "09:05", text: "Every item is waiting in your inbox. Nothing is published until you approve it.", tag: "Approvals" },
        { t: "10:00", text: "A caption was edited before approval, so I saved the edit to write your way next time.", tag: "Learning" },
        { t: "10:30", text: "At your request, sent the approved article to WordPress as a draft.", tag: "Articles" },
        { t: "10:45", text: "At your request, posted the approved update to your Telegram channel.", tag: "Publishing" },
      ],
    },
    proof: {
      label: "Why now",
      items: [
        { n: "12", l: "Gulf selling seasons a year — all in Noor's calendar" },
        { n: "8:00", l: "AM KSA: your brief in the app, every day" },
      ],
    },
    how: {
      eyebrow: "How it works",
      title: "Connect, approve, let it run.",
      steps: [
        { title: "Connect your channels", body: "WordPress for article drafts, Telegram for posts you approve, and your store's products on Salla, Zid, Shopify or WooCommerce, imported from its URL — no file exports." },
        { title: "Noor learns your brand", body: "She reads your site and products, then builds a brand voice file: dialect, tone, banned words, competitors." },
        { title: "A weekly plan from your data", body: "From your brand file and memory — not templates — she proposes what to post, where to advertise, and who to message. Built on the Gulf calendar." },
        { title: "You approve, she executes", body: "One approval inbox. Accept, edit, or reject. Every edit teaches her." },
        { title: "Morning brief", body: "What waits for your approval, what you approved, your balance and upcoming seasons. One short summary in the app." },
      ],
    },
    agents: {
      eyebrow: "Agents",
      title: "Noor runs marketing. Her team covers sales, finance, growth and reporting.",
      sub: "One team working from the same brand file. Every item waits for your approval.",
      items: [
        { name: "Noor", role: "Marketing", body: "Plans and writes your content for every channel. She's the one who leaves your brief each morning.", does: ["Weekly plan", "Posts and SEO articles", "WhatsApp and ads", "Google Business"] },
        { name: "Sami", role: "Sales enablement", body: "Turns attention into deals: lead qualification, scripts, objections, follow-ups.", does: ["Lead qualification card", "Call and WhatsApp scripts", "Objection sheet", "7-touch follow-up cadence"] },
        { name: "Razan", role: "Finance and pricing", body: "SAR pricing with VAT in mind, unit economics, and a 90-day cash-flow forecast.", does: ["Pricing review", "Unit economics", "Cash-flow forecast", "Revenue review"] },
        { name: "Faris", role: "Go-to-market and growth", body: "Positioning, a 90-day plan, ICE-scored growth experiments, retention and referrals.", does: ["GTM plan", "5 growth experiments", "3 retention plays", "Referral programs"] },
        { name: "Dana", role: "Reports and decks", body: "An honest weekly report from your data, a dashboard spec, and a board deck that downloads as PowerPoint.", does: ["Weekly report", "Dashboard spec", "Investor deck", "Executive summary"] },
        { name: "Majed", role: "Executive advisor", body: "Your executive team in one person: strategy review, quarterly OKRs, decision memos, product portfolio calls, and where AI actually pays off.", does: ["90-day review", "OKRs", "Decision memo", "Product portfolio", "AI adoption plan"] },
        { name: "Layan", role: "Product and retention", body: "From idea to PRD and roadmap, and from new customer to returning customer: activation, retention, follow-ups.", does: ["PRD", "RICE roadmap", "Feedback synthesis", "Activation flow"] },
        { name: "Reem", role: "Secretary", body: "Keeps your to-dos, follow-ups and what others owe you, with dates in your local time that she reads back. Nothing closes without your confirmation.", does: ["To-do list", "Follow-ups", "What others owe you", "Overdue items in the morning brief"] },
      ],
    },
    industries: {
      eyebrow: "Industries",
      title: "Built for people who sell in the Gulf.",
      items: [
        { name: "Salla, Zid & Shopify stores", body: "Abandoned-cart messages, selling seasons, Arabic product copy." },
        { name: "Real estate & developers", body: "Project launch campaigns, WhatsApp lead-qualification scripts, broker content." },
        { name: "Law firms", body: "General educational content, SEO articles and Google Business posts, consultation intake questions." },
        { name: "Startups", body: "Product launches, LinkedIn and X, weekly growth experiments on a tight budget." },
        { name: "Clinics & aesthetics", body: "Google Business Profile posts, WhatsApp booking messages, content written with MOH advertising rules in mind." },
        { name: "Restaurants & hospitality", body: "Daily offers, reviews, delivery, visual content in local dialect." },
        { name: "Marketing agencies", body: "Several brands from one account on any plan, each with its own brand file and approval inbox." },
        { name: "Professional services", body: "Accounting, consulting, education — authority content, SEO articles and Google Business posts." },
      ],
    },
    integrations: {
      eyebrow: "Integrations",
      title: "The tools you actually use.",
      sub: "Not a US list. Gulf channels first.",
      groups: [
        { label: "Commerce", items: ["Salla (product import from URL)", "Zid (product import from URL)", "Shopify (product import from URL)", "WooCommerce"] },
        { label: "Publishing", items: ["Telegram", "WordPress (drafts)", "X (coming soon)"] },
      ],
    },
    calendar: {
      eyebrow: "The Gulf calendar",
      title: "Seasons are pre-loaded. Your weekly plan accounts for them.",
      sub: "Noor reminds you of upcoming seasons in your morning brief and works them into your plan and content.",
      items: [
        { when: "Sha'ban", name: "Pre-Ramadan", play: "Audience building, early offers, prep content" },
        { when: "Ramadan", name: "Ramadan", play: "Post after iftar, late-night ads, last-ten-nights offers" },
        { when: "Shawwal", name: "Eid al-Fitr", play: "Gifts, fast delivery, customer greetings" },
        { when: "Dhu al-Hijjah", name: "Eid al-Adha", play: "Family campaigns, post-Hajj offers" },
        { when: "22 Feb", name: "Founding Day", play: "Heritage content, limited editions" },
        { when: "23 Sep", name: "Saudi National Day", play: "Anniversary-number discount codes, green creative" },
        { when: "2 Dec", name: "UAE National Day", play: "Parallel campaigns for the UAE market" },
        { when: "November", name: "White Friday", play: "Warm-up from October, heavy retargeting" },
        { when: "Dec – Jan", name: "Dubai Shopping Festival", play: "Tourist offers, English content" },
        { when: "August", name: "Back to school", play: "Family bundles, Tabby and Tamara installments" },
      ],
    },
    pricing: {
      eyebrow: "Pricing",
      title: "Cheaper than one hire.",
      sub: "Prices in Saudi riyals, excluding VAT. Cancel anytime.",
      trial: "3-day free trial — no card",
      annual: "Pay yearly, get two months free (coming soon)",
      plans: [
        { id: "starter", name: "Starter", price: String(P.starter), period: "SAR / month", credits: `${formatCount(PLAN_CREDITS.starter)} credits / month`, tagline: "For solo sellers and creators", features: [`Unlimited brands, ${seatsText("en", PLAN_SEATS.starter)}`, "Social posts (images coming soon)", "Arabic SEO articles", "Snap & Meta ad copy suggestions", "Daily 8 AM brief", "Gulf industry playbooks", "MCP server access"], cta: "Start free" },
        { id: "pro", name: "Pro", price: String(P.pro), period: "SAR / month", credits: `${formatCount(PLAN_CREDITS.pro)} credits / month`, tagline: "For founders, stores, and clinics", highlight: true, features: ["Everything in Starter", `${seatsText("en", PLAN_SEATS.pro)} including the owner, with admin and member roles`, "Auto ad optimization within your guardrails (coming soon)", "WhatsApp campaigns + cart recovery (coming soon)", "Weekly ad audit and waste detection (coming soon)"], cta: "Start free" },
        { id: "business", name: "Business", price: String(P.business), period: "SAR / month", credits: `${formatCount(PLAN_CREDITS.business)} credits / month, reset monthly`, tagline: "For bigger teams and businesses", features: ["Everything in Pro", `${seatsText("en", PLAN_SEATS.business)} including the owner`, "White-label client reports (coming soon)", "Ad optimization every 2 hours (coming soon)"], cta: "Start free" },
        { id: "agency", name: "Agency", price: "Contact us", period: "annual billing", credits: `Custom credits, from ${formatCount(AGENCY_MIN.credits)} a month`, tagline: "For agencies and large groups", features: ["All specialist agents", "Data hosted inside Saudi Arabia (coming soon)", "CRM and data warehouse connections (coming soon)", "Model trained on your brand voice (coming soon)", "Dedicated success manager", "1-hour SLA (coming soon)", "Seats sized to your team"], cta: "Contact us" },
      ],
      creditsTitle: "What does each task cost?",
      credits: creditRows("en"),
    },
    faq: {
      eyebrow: "FAQ",
      title: "Questions? Good to know.",
      items: [
        { q: "Can't I just use ChatGPT or Claude?", a: "You can, and you'll spend your time writing prompts and copy-pasting. Noor is built for Gulf marketing: a brand file she reads every time, playbooks per industry, the Ramadan and Eid calendar, a second-pass compliance reviewer, an approval inbox, a content calendar, and publishing through integrations. And she learns from your edits." },
        { q: "Does Noor publish without permission?", a: "No. Every item waits in your inbox, and publishing is always your call. Once you trust her, you can auto-approve specific types from Governance." },
        { q: "What is the morning brief?", a: "Every day at 08:00 KSA: what waits for approval, what was approved, your balance, upcoming seasons, and team follow-ups (items due today, things waiting for two days). In the app." },
        { q: "How long until I see results?", a: "Your brand file and 90-day plan are written from your URL during onboarding, and your first content batch arrives when you ask Noor for it." },
        { q: "How much does it cost?", a: `Monthly credits by plan: Starter ${P.starter}, Pro ${P.pro}, Business ${P.business} SAR, and Agency by contract. A post is ${enCredits(perPost)}, an article ${TASK_COST.article}, a board deck ${TASK_COST.board_deck}. Chatting with the team and setting up your first brand are free; setting up each added brand from its URL is ${enCredits(ONBOARD_EXTRA_BRAND_COST)}. To change plans, contact us.` },
        { q: "What about privacy?", a: "Your data stays in your workspace, is never used by Thakeen to train models and never shared across accounts. Integration keys are encrypted. Delete your account and its workspace data yourself from Profile." },
        { q: "Does Noor learn my brand voice?", a: "Yes. From your website first, then from every edit and rejection you write, saved to preferences.md and followed." },
        { q: "Can I cancel anytime?", a: "Yes. 3-day trial with no card. Upgrade from Subscription; to change or cancel your plan, contact us." },
        { q: "Who else is on the team?", a: "Sami for sales, Razan for finance and pricing, Faris for growth, Dana for reports and decks, Majed the executive advisor, Layan for product and retention, and Reem the secretary for your to-dos and follow-ups. All in the same chat, from the same brand file." },
      ],
    },
    waitlist: {
      title: "Reserve your spot for launch.",
      sub: "The first 100 brands get two months free on Pro and personal onboarding.",
      email: "Your email",
      company: "Business name or website",
      industry: "Industry",
      industries: ["E-commerce", "Real estate", "Legal", "Startup", "Clinic", "Restaurant", "Agency", "Other"],
      submit: "Reserve my spot",
      ok: "Done. We received your details.",
      err: "Didn't send. Try again or email hello@nashr.ai",
    },
    footer: {
      tagline: "A marketing agent built for the Gulf.",
      rights: "© 2026 Thakeen. All rights reserved.",
      links: [
        { label: "Pricing", href: "/en/pricing" },
        { label: "Free tools", href: "/en/tools" },
        { label: "Blog", href: "/en/blog" },
        { label: "Affiliates", href: "/en/affiliates" },
        { label: "Help", href: "/en/help" },
        { label: "Comparisons", href: "/en/vs/enrich-labs" },
        { label: "Privacy", href: "/en/privacy" },
        { label: "Terms", href: "/en/terms" },
      ],
    },
  },
};
