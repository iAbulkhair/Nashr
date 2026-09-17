import type { Lang } from "./i18n";

const ar = {
  appName: "نشر",
  nav: { inbox: "صندوق الموافقة", generate: "اطلب من نور", brand: "ملف العلامة", billing: "الاشتراك", logout: "خروج", credits: "كريدت" },
  login: { title: "تسجيل الدخول", email: "البريد الإلكتروني", password: "كلمة المرور", submit: "دخول", noAccount: "ما عندك حساب؟", signup: "أنشئ حساباً", invalid: "البريد أو كلمة المرور غير صحيحة." },
  signup: { title: "ابدأ تجربتك المجانية", sub: "7 أيام، 50 كريدت، بدون بطاقة.", name: "اسمك", phone: "رقم الجوال (واتساب)", email: "البريد الإلكتروني", password: "كلمة المرور (8 أحرف أو أكثر)", submit: "أنشئ الحساب", have: "عندك حساب؟", login: "سجّل دخول", exists: "هذا البريد مسجّل مسبقاً.", bad_phone: "رقم الجوال غير صحيح.", weak_password: "كلمة المرور قصيرة (8 أحرف على الأقل).", bad_email: "البريد غير صحيح." },
  onboarding: {
    title: "عرّفي نور على علامتك", sub: "دقيقتان. كل ما تكتبه هنا تستخدمه نور في كل محتوى.",
    name: "اسم النشاط", website: "الموقع أو رابط المتجر (سلة / زد / شوبيفاي)", industry: "القطاع", city: "المدينة / السوق",
    industries: ["متجر إلكتروني", "عقار", "مكتب قانوني", "شركة ناشئة", "عيادة / تجميل", "مطعم / كافيه", "وكالة تسويق", "خدمات مهنية", "أخرى"],
    dialect: "اللهجة", dialects: { saudi: "سعودي خفيف", msa: "فصحى مبسطة", emirati: "إماراتي خفيف", kuwaiti: "كويتي خفيف", english: "إنجليزي فقط" },
    languages: "لغات المحتوى", ar: "عربي", en: "إنجليزي",
    tone: "الأسلوب (مثال: ودود، فاخر، مباشر، شبابي)", products: "المنتجات / الخدمات الرئيسية", audience: "الجمهور المستهدف", offers: "العروض الحالية (اختياري)", competitors: "المنافسون (اختياري)", banned: "كلمات ممنوعة (اختياري)", preferred: "كلمات مفضلة (اختياري)",
    channels: "القنوات النشطة", save: "احفظ وابدأ", saved: "تم الحفظ",
  },
  generate: {
    title: "ماذا تريد من نور اليوم؟", sub: "كل طلب يُنتج عناصر جاهزة في صندوق الموافقة.",
    notes: "ملاحظات لهذه الدفعة (اختياري): موسم، منتج معين، عرض…", run: "نفّذي يا نور", running: "نور تعمل… (30-90 ثانية)", done: "جاهز! العناصر في صندوق الموافقة.",
    types: {
      weekly_plan: { t: "خطة الأسبوع", d: "خطة 7 أيام: ماذا ننشر، متى، وأين نعلن." },
      social: { t: "10 منشورات سوشال", d: "إنستقرام، سناب، تيك توك، X — جاهزة للنشر." },
      article: { t: "مقال SEO", d: "1,200-1,600 كلمة، مهيكل، مع FAQ." },
      whatsapp: { t: "3 رسائل واتساب", d: "سلة متروكة، عرض موسمي، شكر بعد الشراء." },
      ads: { t: "5 إعلانات مدفوعة", d: "سناب، ميتا، تيك توك — نص + جمهور + ميزانية." },
      gbp: { t: "3 منشورات Google Business", d: "عرض، تحديث، مناسبة." },
    },
    cost: "كريدت", noCredits: "الكريدت غير كافي. رقّ خطتك.", trialOver: "انتهت التجربة. اشترك للمتابعة.", failed: "تعذّر التوليد. حاول مرة أخرى.", noBrand: "أكمل ملف العلامة أولاً.",
  },
  inbox: {
    title: "صندوق الموافقة", empty: "لا يوجد شيء بانتظارك. اطلب من نور أول دفعة.", pending: "بانتظارك", approved: "معتمد", rejected: "مرفوض", all: "الكل",
    approve: "اعتمد", reject: "ارفض", edit: "عدّل", save: "احفظ التعديل", cancel: "إلغاء", copy: "انسخ", copied: "تم النسخ", why: "سبب الرفض (تتعلم منه نور)", regenerate: "اطلب دفعة جديدة",
  },
  billing: {
    title: "الاشتراك", current: "خطتك الحالية", credits: "الكريدت المتبقي", trialEnds: "تنتهي التجربة",
    sub: "ادفع عبر الرابط، ثم يُفعَّل حسابك خلال ساعات العمل. أرسل إيصال الدفع على واتساب لتفعيل أسرع.",
    pay: "اشترك الآن", contact: "تواصل معنا على واتساب", plans: { starter: "البداية", pro: "الاحتراف", agency: "الوكالة", trial: "تجربة", enterprise: "مؤسسات" },
  },
};

const en: typeof ar = {
  appName: "Nashr",
  nav: { inbox: "Approval inbox", generate: "Ask Noor", brand: "Brand file", billing: "Subscription", logout: "Log out", credits: "credits" },
  login: { title: "Log in", email: "Email", password: "Password", submit: "Log in", noAccount: "No account?", signup: "Create one", invalid: "Wrong email or password." },
  signup: { title: "Start your free trial", sub: "7 days, 50 credits, no card.", name: "Your name", phone: "Mobile number (WhatsApp)", email: "Email", password: "Password (8+ characters)", submit: "Create account", have: "Have an account?", login: "Log in", exists: "This email is already registered.", bad_phone: "Invalid mobile number.", weak_password: "Password too short (8+ characters).", bad_email: "Invalid email." },
  onboarding: {
    title: "Introduce Noor to your brand", sub: "Two minutes. Everything here shapes every piece Noor writes.",
    name: "Business name", website: "Website or store URL (Salla / Zid / Shopify)", industry: "Industry", city: "City / market",
    industries: ["E-commerce", "Real estate", "Law firm", "Startup", "Clinic / aesthetics", "Restaurant / café", "Marketing agency", "Professional services", "Other"],
    dialect: "Dialect", dialects: { saudi: "Light Saudi", msa: "Simple MSA", emirati: "Light Emirati", kuwaiti: "Light Kuwaiti", english: "English only" },
    languages: "Content languages", ar: "Arabic", en: "English",
    tone: "Tone (e.g. friendly, premium, direct, youthful)", products: "Main products / services", audience: "Target audience", offers: "Current offers (optional)", competitors: "Competitors (optional)", banned: "Banned words (optional)", preferred: "Preferred words (optional)",
    channels: "Active channels", save: "Save and start", saved: "Saved",
  },
  generate: {
    title: "What do you need from Noor today?", sub: "Every request lands as ready items in your approval inbox.",
    notes: "Notes for this batch (optional): season, specific product, offer…", run: "Go, Noor", running: "Noor is working… (30–90 s)", done: "Done. Items are in your inbox.",
    types: {
      weekly_plan: { t: "Weekly plan", d: "7-day plan: what to post, when, where to advertise." },
      social: { t: "10 social posts", d: "Instagram, Snapchat, TikTok, X — ready to publish." },
      article: { t: "SEO article", d: "1,200–1,600 words, structured, with FAQ." },
      whatsapp: { t: "3 WhatsApp messages", d: "Abandoned cart, seasonal offer, post-purchase thanks." },
      ads: { t: "5 paid ads", d: "Snapchat, Meta, TikTok — copy + audience + budget." },
      gbp: { t: "3 Google Business posts", d: "Offer, update, event." },
    },
    cost: "credits", noCredits: "Not enough credits. Upgrade your plan.", trialOver: "Trial ended. Subscribe to continue.", failed: "Generation failed. Try again.", noBrand: "Complete your brand file first.",
  },
  inbox: {
    title: "Approval inbox", empty: "Nothing waiting. Ask Noor for a first batch.", pending: "Waiting", approved: "Approved", rejected: "Rejected", all: "All",
    approve: "Approve", reject: "Reject", edit: "Edit", save: "Save edit", cancel: "Cancel", copy: "Copy", copied: "Copied", why: "Why? (Noor learns from this)", regenerate: "Ask for a new batch",
  },
  billing: {
    title: "Subscription", current: "Current plan", credits: "Credits left", trialEnds: "Trial ends",
    sub: "Pay via the link; your account is activated within business hours. Send the receipt on WhatsApp for faster activation.",
    pay: "Subscribe", contact: "Contact us on WhatsApp", plans: { starter: "Starter", pro: "Pro", agency: "Agency", trial: "Trial", enterprise: "Enterprise" },
  },
};

export const appDict: Record<Lang, typeof ar> = { ar, en };
export type AppDict = typeof ar;
