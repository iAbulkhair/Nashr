export type Lang = "ar" | "en";
export const LANGS: Lang[] = ["ar", "en"];

export function isLang(v: string): v is Lang {
  return v === "ar" || v === "en";
}

export type Plan = {
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
  nav: { how: string; agents: string; industries: string; pricing: string; faq: string; cta: string; switchLang: string; switchHref: string };
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
  pricing: { eyebrow: string; title: string; sub: string; trial: string; annual: string; plans: Plan[]; creditsTitle: string; credits: { action: string; cost: string }[] };
  faq: { eyebrow: string; title: string; items: { q: string; a: string }[] };
  waitlist: { title: string; sub: string; email: string; company: string; industry: string; industries: string[]; submit: string; ok: string; err: string };
  footer: { tagline: string; rights: string; links: { label: string; href: string }[] };
};

export const dict: Record<Lang, Dict> = {
  ar: {
    dir: "rtl",
    brand: "نشر",
    agent: "نور",
    nav: { how: "كيف تعمل", agents: "الوكلاء", industries: "القطاعات", pricing: "الأسعار", faq: "الأسئلة", cta: "ابدأ مجاناً", switchLang: "English", switchHref: "/en" },
    hero: {
      eyebrow: "فريق تسويق كامل يعمل بالذكاء الاصطناعي — مبني للخليج",
      title1: "وأنت نايم،",
      title2: "نور تسوّق.",
      sub: "نور وكيلة تسويق مستقلة تخطط، تكتب، تنشر، وتضبط إعلاناتك على سناب وتيك توك وميتا وقوقل — بالعربي وبالإنجليزي — ثم ترسل لك ملخص الصباح على واتساب. أنت توافق، هي تنفّذ.",
      cta: "ابدأ تجربتك المجانية",
      cta2: "شاهد ماذا فعلت الليلة",
      logTitle: "سجل نور الليلة",
      logNote: "مثال حي لليلة واحدة — كل سطر ينتظر موافقتك أو تم تنفيذه تلقائياً ضمن الحدود التي حددتها.",
      log: [
        { t: "23:40", text: "رصدت انخفاض ROAS في حملة سناب «عروض الويكند» إلى 1.8 — خفّضت الميزانية 30% ونقلتها لحملة تيك توك.", tag: "إعلانات" },
        { t: "01:15", text: "كتبت مقالاً 1,800 كلمة: «أفضل عطور رجالية للشتاء 2026» — مستهدف كلمات لا يغطيها منافسوك.", tag: "SEO" },
        { t: "02:50", text: "جهّزت 12 منشوراً للأسبوع القادم بلهجة سعودية خفيفة، مع 3 سكربتات UGC.", tag: "سوشال" },
        { t: "04:30", text: "المنافس «X» غيّر أسعار 6 منتجات. أضفت مقارنة للملخص.", tag: "منافسون" },
        { t: "06:00", text: "بنيت رسالة واتساب لاسترجاع السلات المتروكة — 214 عميل، متوقع 8-12% تحويل.", tag: "واتساب" },
        { t: "08:00", text: "أرسلت ملخص الصباح: 4 مهام بانتظار موافقتك، إيراد الأمس 18,420 ريال (+11%).", tag: "ملخص" },
      ],
    },
    proof: {
      label: "لماذا الآن",
      items: [
        { n: "+90%", l: "من مستخدمي الإنترنت في السعودية على سناب شات" },
        { n: "40+", l: "ألف متجر على سلة وزد يحتاج تسويقاً يومياً" },
        { n: "12", l: "موسم بيع خليجي في السنة — كلها في تقويم نور" },
        { n: "8:00", l: "صباحاً: ملخصك على واتساب، كل يوم" },
      ],
    },
    how: {
      eyebrow: "كيف تعمل",
      title: "اربط، وافق، وخلّها تشتغل.",
      steps: [
        { title: "اربط قنواتك", body: "سلة أو زد أو شوبيفاي، سناب، تيك توك، ميتا، قوقل، واتساب للأعمال. بضغطة واحدة عبر OAuth — بدون تصدير ملفات." },
        { title: "نور تتعلم علامتك", body: "تقرأ موقعك ومنتجاتك ومنشوراتك السابقة، وتبني ملف صوت العلامة: اللهجة، الأسلوب، الممنوعات، والمنافسين." },
        { title: "خطة أسبوعية من بياناتك", body: "من أرقامك الفعلية — لا من قوالب — تقترح خطة: ماذا ننشر، أين نعلن، ولمن نرسل. مبنية على التقويم الخليجي." },
        { title: "أنت توافق، هي تنفّذ", body: "صندوق موافقة واحد. اقبل أو عدّل أو ارفض. كل تعديل يعلّمها. نسبة القبول تصل 95% خلال شهرين." },
        { title: "ملخص الصباح على واتساب", body: "ماذا حدث، ماذا فعلت، وماذا تقترح. بدون لوحات تحكم — رسالة واحدة تقرأها في دقيقة." },
      ],
    },
    agents: {
      eyebrow: "الوكلاء",
      title: "نور تقود، والمتخصصون ينفّذون.",
      sub: "ابدأ بنور. أضف متخصصاً حين تحتاج عمقاً في قناة.",
      items: [
        { name: "نور", role: "وكيلة التسويق العامة", body: "تخطط وتنسّق وتنفّذ عبر كل القنوات. هي التي تراسلك صباحاً.", does: ["الخطة الأسبوعية", "صندوق الموافقة", "ملخص واتساب", "مراقبة المنافسين"] },
        { name: "سلطان", role: "الإعلانات المدفوعة", body: "سناب، تيك توك، ميتا، قوقل. يضبط الميزانيات كل ساعتين ضمن حدودك.", does: ["كشف الهدر", "إعادة توزيع الميزانية", "تدقيق أسبوعي", "اختبار A/B للكرييتف"] },
        { name: "ريم", role: "واتساب والرسائل", body: "حملات واتساب المرخّصة، استرجاع السلات، رسائل ما بعد الشراء.", does: ["قوالب معتمدة", "تقسيم العملاء", "أتمتة الردود", "SMS احتياطي"] },
        { name: "فيصل", role: "SEO و GEO", body: "مقالات عربية تظهر في قوقل وفي إجابات ChatGPT وGemini.", does: ["فجوات الكلمات", "مقالات 1,500-2,000 كلمة", "Google Business Profile", "Schema"] },
        { name: "لمى", role: "السوشال والمؤثرين", body: "محتوى يومي، سكربتات UGC، وفلترة المؤثرين المرخّصين (موثوق).", does: ["50 منشور/شهر", "سكربتات فيديو", "قائمة مؤثرين", "تقارير تفاعل"] },
      ],
    },
    industries: {
      eyebrow: "القطاعات",
      title: "مبنية لمن يبيع في الخليج.",
      items: [
        { name: "متاجر سلة وزد وشوبيفاي", body: "ROAS، سلات متروكة، مواسم البيع، وصف منتجات بالعربي." },
        { name: "العقار والمطورون", body: "حملات إطلاق المشاريع، تأهيل المستفسرين على واتساب، محتوى للوسطاء." },
        { name: "المكاتب القانونية", body: "محتوى توعوي ملتزم، ظهور في بحث قوقل والذكاء الاصطناعي، وتأهيل الاستشارات." },
        { name: "الشركات الناشئة", body: "إطلاق منتج، LinkedIn وX، تجارب نمو أسبوعية بميزانية محدودة." },
        { name: "العيادات والتجميل", body: "Google Business Profile، مواعيد عبر واتساب، محتوى ملتزم بلوائح الصحة." },
        { name: "المطاعم والضيافة", body: "عروض يومية، مراجعات، توصيل، محتوى مرئي بلهجة محلية." },
        { name: "وكالات التسويق", body: "إدارة عشر علامات من مكان واحد، تقارير بعلامتك، وصلاحيات فريق." },
        { name: "الخدمات المهنية", body: "محاسبة، استشارات، تعليم — ظهور محلي وعملاء عبر المحتوى." },
      ],
    },
    integrations: {
      eyebrow: "التكاملات",
      title: "الأدوات التي تستخدمها فعلاً.",
      sub: "ليست قائمة أمريكية. القنوات الخليجية أولاً.",
      groups: [
        { label: "التجارة", items: ["سلة", "زد", "Shopify", "WooCommerce"] },
        { label: "الإعلانات", items: ["Snapchat Ads", "TikTok Ads", "Meta Ads", "Google Ads", "X Ads"] },
        { label: "الرسائل", items: ["WhatsApp Business API", "SMS (Unifonic)", "Mailchimp", "Klaviyo"] },
        { label: "البيانات", items: ["Google Analytics 4", "Search Console", "Google Business Profile", "Meta Pixel"] },
        { label: "النشر", items: ["Instagram", "TikTok", "Snapchat", "X", "LinkedIn", "YouTube Shorts"] },
        { label: "الدفع والفوترة", items: ["Tap", "Moyasar", "HyperPay", "مدى، Apple Pay، تابي، تمارا"] },
      ],
    },
    calendar: {
      eyebrow: "التقويم الخليجي",
      title: "المواسم مبرمجة. الخطط جاهزة قبلها بأسابيع.",
      sub: "نور تبدأ التحضير قبل كل موسم بـ 4 أسابيع — كرييتف، ميزانيات، رسائل.",
      items: [
        { when: "شعبان", name: "ما قبل رمضان", play: "بناء الجمهور، عروض مبكرة، محتوى استعداد" },
        { when: "رمضان", name: "رمضان", play: "نشر بعد الإفطار، إعلانات ليلية، عروض العشر الأواخر" },
        { when: "شوال", name: "عيد الفطر", play: "هدايا، توصيل سريع، رسائل تهنئة للعملاء" },
        { when: "ذو الحجة", name: "عيد الأضحى", play: "حملات العائلة، عروض ما بعد الحج" },
        { when: "22 فبراير", name: "يوم التأسيس", play: "محتوى هوية، إصدارات محدودة" },
        { when: "23 سبتمبر", name: "اليوم الوطني السعودي", play: "أكبر موسم بيع بعد رمضان — خصومات 93/94" },
        { when: "2 ديسمبر", name: "اليوم الوطني الإماراتي", play: "حملات موازية للسوق الإماراتي" },
        { when: "نوفمبر", name: "الجمعة البيضاء", play: "تسخين من أكتوبر، حملات ريتارقت مكثفة" },
        { when: "ديسمبر - يناير", name: "مهرجان دبي للتسوق", play: "عروض سياحية، محتوى بالإنجليزية" },
        { when: "أغسطس", name: "العودة للمدارس", play: "حزم عائلية، تقسيط تابي وتمارا" },
      ],
    },
    pricing: {
      eyebrow: "الأسعار",
      title: "أرخص من موظف واحد. أسرع من وكالة.",
      sub: "بالريال السعودي، شامل الضريبة عند الدفع. ألغِ في أي وقت.",
      trial: "تجربة 7 أيام مجاناً — بدون بطاقة",
      annual: "ادفع سنوياً ووفّر شهرين",
      plans: [
        { name: "البداية", price: "149", period: "ريال / شهر", credits: "200 كريدت شهرياً", tagline: "للتاجر الفرد والمبدع", features: ["علامة واحدة، مستخدم واحد", "منشورات سوشال + صور", "مقالات SEO بالعربي", "حملات سناب وميتا (قراءة + اقتراحات)", "ملخص واتساب أسبوعي", "10 مهام متزامنة"], cta: "ابدأ مجاناً" },
        { name: "الاحتراف", price: "399", period: "ريال / شهر", credits: "700 كريدت شهرياً", tagline: "للمؤسس والمتجر والعيادة", highlight: true, features: ["كل ما في البداية", "ضبط الإعلانات تلقائياً ضمن حدودك", "حملات واتساب + استرجاع السلات", "تدقيق إعلانات أسبوعي وكشف الهدر", "ملخص يومي 8 صباحاً", "70+ خطة جاهزة خليجية", "مقاعد إضافية 99 ريال/مقعد", "20 مهمة متزامنة"], cta: "ابدأ مجاناً" },
        { name: "الوكالة", price: "799", period: "ريال / شهر", credits: "2,000 كريدت شهرياً — يترحّل", tagline: "للوكالات ومتعدد الفروع", features: ["كل ما في الاحتراف", "علامات متعددة (5 مشمولة)", "علامة إضافية 99 ريال", "تقارير بعلامتك للعملاء", "صلاحيات فريق وأدوار", "ضبط الإعلانات كل ساعتين", "مهام غير محدودة", "وصول MCP و API"], cta: "ابدأ مجاناً" },
        { name: "المؤسسات", price: "حسب الطلب", period: "فوترة سنوية", credits: "كريدت مخصص", tagline: "للمجموعات والجهات الكبيرة", features: ["الوكلاء المتخصصون كلهم", "استضافة البيانات داخل السعودية", "ربط CRM ومستودع البيانات", "تدريب نموذج على صوت علامتك", "مدير نجاح مخصص", "SLA ساعة واحدة", "علامات ومستخدمون بلا حد"], cta: "احجز عرضاً" },
      ],
      creditsTitle: "كم تكلّف كل مهمة؟",
      credits: [
        { action: "منشور سوشال / صورة / إعلان / محادثة", cost: "1" },
        { action: "مقال SEO", cost: "2" },
        { action: "حملة واتساب / سلايدشو تيك توك", cost: "3" },
        { action: "فيديو 4-12 ثانية", cost: "12" },
        { action: "فيديو 16-20 ثانية", cost: "24" },
      ],
    },
    faq: {
      eyebrow: "الأسئلة الشائعة",
      title: "ما يسأله الجميع قبل الاشتراك.",
      items: [
        { q: "هل تنشر نور بدون إذني؟", a: "لا، إلا إذا فعّلت ذلك. الافتراضي أن كل شيء يمر بصندوق الموافقة. يمكنك تفويض أنواع محددة (مثلاً منشورات السوشال) بعد أن تثق بها." },
        { q: "هل تعدّل ميزانيات إعلاناتي؟", a: "في خطة البداية: تقترح فقط. في الاحتراف وما فوق: تعدّل ضمن حدود تضعها أنت (حد يومي، حد أدنى ROAS، قنوات مسموحة). كل تعديل مسجّل ويمكن التراجع عنه." },
        { q: "كيف جودة العربي؟", a: "نور تكتب بالفصحى المبسّطة أو بلهجة خليجية خفيفة حسب اختيارك. تتعلم من تعديلاتك، ولديك قائمة كلمات ممنوعة ومفضّلة." },
        { q: "أين تُحفظ بياناتي؟", a: "على خوادم داخل المملكة (منطقة سحابية سعودية)، متوافقة مع نظام حماية البيانات الشخصية. لا نُدرّب نماذج عامة على بياناتك." },
        { q: "هل واتساب مسموح؟", a: "نعم، عبر WhatsApp Business API الرسمي بقوالب معتمدة من ميتا. لا نستخدم أرقاماً شخصية أو أدوات غير رسمية." },
        { q: "ماذا لو انتهت الكريدت؟", a: "تشتري رصيداً إضافياً عند الحاجة، أو ترقّي الخطة. لا نوقف حملاتك الجارية فجأة." },
        { q: "هل تحل محل وكالتي؟", a: "للأغلبية: نعم لتنفيذ اليومي. للحملات الكبرى والإنتاج الاحترافي: نور تعمل بجانب الوكالة وتوفّر عليك ساعات التنفيذ." },
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
      ok: "تم! سنراسلك خلال 48 ساعة.",
      err: "لم يتم الإرسال. جرّب مرة أخرى أو راسلنا على hello@nashr.ai",
    },
    footer: {
      tagline: "وكيلة تسويق تعمل 24/7 — مبنية في الرياض للخليج.",
      rights: "© 2026 نشر. جميع الحقوق محفوظة.",
      links: [
        { label: "الأسعار", href: "#pricing" },
        { label: "الأسئلة", href: "#faq" },
        { label: "سياسة الخصوصية", href: "#" },
        { label: "الشروط", href: "#" },
      ],
    },
  },
  en: {
    dir: "ltr",
    brand: "Nashr",
    agent: "Noor",
    nav: { how: "How it works", agents: "Agents", industries: "Industries", pricing: "Pricing", faq: "FAQ", cta: "Start free", switchLang: "العربية", switchHref: "/ar" },
    hero: {
      eyebrow: "An AI marketing team, built for the Gulf",
      title1: "While you sleep,",
      title2: "Noor markets.",
      sub: "Noor is an autonomous marketing agent that plans, writes, publishes, and tunes your ads on Snapchat, TikTok, Meta, and Google — in Arabic and English — then sends your morning brief on WhatsApp. You approve. She executes.",
      cta: "Start your free trial",
      cta2: "See what she did last night",
      logTitle: "Noor's overnight log",
      logNote: "A real-shape sample of one night. Each line is either waiting for your approval or was done automatically within limits you set.",
      log: [
        { t: "23:40", text: "Snap campaign “Weekend Deals” ROAS dropped to 1.8. Cut budget 30% and moved it to the TikTok campaign.", tag: "Ads" },
        { t: "01:15", text: "Wrote an 1,800-word article: “Best men's winter fragrances 2026” — targeting keywords your competitors don't cover.", tag: "SEO" },
        { t: "02:50", text: "Prepared 12 posts for next week in light Saudi dialect, plus 3 UGC scripts.", tag: "Social" },
        { t: "04:30", text: "Competitor “X” changed prices on 6 products. Added a comparison to your brief.", tag: "Competitors" },
        { t: "06:00", text: "Built an abandoned-cart WhatsApp message — 214 customers, expected 8–12% conversion.", tag: "WhatsApp" },
        { t: "08:00", text: "Sent morning brief: 4 tasks awaiting approval, yesterday's revenue SAR 18,420 (+11%).", tag: "Brief" },
      ],
    },
    proof: {
      label: "Why now",
      items: [
        { n: "90%+", l: "of Saudi internet users are on Snapchat" },
        { n: "40k+", l: "Salla and Zid stores that need daily marketing" },
        { n: "12", l: "Gulf selling seasons a year — all in Noor's calendar" },
        { n: "8:00", l: "AM: your brief on WhatsApp, every day" },
      ],
    },
    how: {
      eyebrow: "How it works",
      title: "Connect, approve, let it run.",
      steps: [
        { title: "Connect your channels", body: "Salla, Zid or Shopify, Snapchat, TikTok, Meta, Google, WhatsApp Business. One click via OAuth — no CSV exports." },
        { title: "Noor learns your brand", body: "She reads your site, products and past posts, then builds a brand voice file: dialect, tone, banned words, competitors." },
        { title: "A weekly plan from your data", body: "From your real numbers — not templates — she proposes what to post, where to advertise, and who to message. Built on the Gulf calendar." },
        { title: "You approve, she executes", body: "One approval inbox. Accept, edit, or reject. Every edit teaches her. Acceptance reaches 95% within two months." },
        { title: "Morning brief on WhatsApp", body: "What happened, what she did, what she suggests. No dashboards — one message you read in a minute." },
      ],
    },
    agents: {
      eyebrow: "Agents",
      title: "Noor leads. Specialists execute.",
      sub: "Start with Noor. Add a specialist when you need depth in one channel.",
      items: [
        { name: "Noor", role: "Generalist marketing agent", body: "Plans, coordinates, and executes across every channel. She's the one who messages you each morning.", does: ["Weekly plan", "Approval inbox", "WhatsApp brief", "Competitor watch"] },
        { name: "Sultan", role: "Paid ads", body: "Snapchat, TikTok, Meta, Google. Adjusts budgets every two hours inside your guardrails.", does: ["Waste detection", "Budget reallocation", "Weekly audit", "Creative A/B tests"] },
        { name: "Reem", role: "WhatsApp & messaging", body: "Licensed WhatsApp campaigns, cart recovery, post-purchase flows.", does: ["Approved templates", "Customer segments", "Reply automation", "SMS fallback"] },
        { name: "Faisal", role: "SEO & GEO", body: "Arabic articles that rank on Google and get cited by ChatGPT and Gemini.", does: ["Keyword gaps", "1,500–2,000 word articles", "Google Business Profile", "Schema"] },
        { name: "Lama", role: "Social & influencers", body: "Daily content, UGC scripts, and filtering of licensed (Mawthooq) influencers.", does: ["50 posts/month", "Video scripts", "Influencer shortlist", "Engagement reports"] },
      ],
    },
    industries: {
      eyebrow: "Industries",
      title: "Built for people who sell in the Gulf.",
      items: [
        { name: "Salla, Zid & Shopify stores", body: "ROAS, abandoned carts, selling seasons, Arabic product copy." },
        { name: "Real estate & developers", body: "Project launch campaigns, WhatsApp lead qualification, broker content." },
        { name: "Law firms", body: "Compliant educational content, visibility in Google and AI answers, consultation intake." },
        { name: "Startups", body: "Product launches, LinkedIn and X, weekly growth experiments on a tight budget." },
        { name: "Clinics & aesthetics", body: "Google Business Profile, WhatsApp bookings, MOH-compliant content." },
        { name: "Restaurants & hospitality", body: "Daily offers, reviews, delivery, visual content in local dialect." },
        { name: "Marketing agencies", body: "Ten brands from one seat, white-label reports, team roles." },
        { name: "Professional services", body: "Accounting, consulting, education — local visibility and clients from content." },
      ],
    },
    integrations: {
      eyebrow: "Integrations",
      title: "The tools you actually use.",
      sub: "Not a US list. Gulf channels first.",
      groups: [
        { label: "Commerce", items: ["Salla", "Zid", "Shopify", "WooCommerce"] },
        { label: "Ads", items: ["Snapchat Ads", "TikTok Ads", "Meta Ads", "Google Ads", "X Ads"] },
        { label: "Messaging", items: ["WhatsApp Business API", "SMS (Unifonic)", "Mailchimp", "Klaviyo"] },
        { label: "Data", items: ["Google Analytics 4", "Search Console", "Google Business Profile", "Meta Pixel"] },
        { label: "Publishing", items: ["Instagram", "TikTok", "Snapchat", "X", "LinkedIn", "YouTube Shorts"] },
        { label: "Payments & billing", items: ["Tap", "Moyasar", "HyperPay", "mada, Apple Pay, Tabby, Tamara"] },
      ],
    },
    calendar: {
      eyebrow: "The Gulf calendar",
      title: "Seasons are pre-loaded. Plans are ready weeks ahead.",
      sub: "Noor starts preparing four weeks before each season — creative, budgets, messages.",
      items: [
        { when: "Sha'ban", name: "Pre-Ramadan", play: "Audience building, early offers, prep content" },
        { when: "Ramadan", name: "Ramadan", play: "Post after iftar, late-night ads, last-ten-nights offers" },
        { when: "Shawwal", name: "Eid al-Fitr", play: "Gifts, fast delivery, customer greetings" },
        { when: "Dhu al-Hijjah", name: "Eid al-Adha", play: "Family campaigns, post-Hajj offers" },
        { when: "22 Feb", name: "Founding Day", play: "Heritage content, limited editions" },
        { when: "23 Sep", name: "Saudi National Day", play: "Biggest season after Ramadan — 93/94 discounts" },
        { when: "2 Dec", name: "UAE National Day", play: "Parallel campaigns for the UAE market" },
        { when: "November", name: "White Friday", play: "Warm-up from October, heavy retargeting" },
        { when: "Dec – Jan", name: "Dubai Shopping Festival", play: "Tourist offers, English content" },
        { when: "August", name: "Back to school", play: "Family bundles, Tabby and Tamara installments" },
      ],
    },
    pricing: {
      eyebrow: "Pricing",
      title: "Cheaper than one hire. Faster than an agency.",
      sub: "In Saudi riyals, VAT applied at checkout. Cancel anytime.",
      trial: "7-day free trial — no card",
      annual: "Pay yearly, get two months free",
      plans: [
        { name: "Starter", price: "149", period: "SAR / month", credits: "200 credits / month", tagline: "For solo sellers and creators", features: ["1 brand, 1 seat", "Social posts + images", "Arabic SEO articles", "Snap & Meta campaigns (read + suggest)", "Weekly WhatsApp brief", "10 concurrent tasks"], cta: "Start free" },
        { name: "Pro", price: "399", period: "SAR / month", credits: "700 credits / month", tagline: "For founders, stores, and clinics", highlight: true, features: ["Everything in Starter", "Auto ad optimization within your guardrails", "WhatsApp campaigns + cart recovery", "Weekly ad audit and waste detection", "Daily 8 AM brief", "70+ Gulf-ready playbooks", "Extra seats SAR 99 / seat", "20 concurrent tasks"], cta: "Start free" },
        { name: "Agency", price: "799", period: "SAR / month", credits: "2,000 credits / month — rolls over", tagline: "For agencies and multi-branch", features: ["Everything in Pro", "Multi-brand (5 included)", "Extra brand SAR 99", "White-label client reports", "Team roles and permissions", "Ad optimization every 2 hours", "Unlimited tasks", "MCP and API access"], cta: "Start free" },
        { name: "Enterprise", price: "Custom", period: "annual billing", credits: "Custom credits", tagline: "For groups and large organizations", features: ["All specialist agents", "Data hosted inside Saudi Arabia", "CRM and data warehouse connections", "Model trained on your brand voice", "Dedicated success manager", "1-hour SLA", "Unlimited brands and users"], cta: "Book a demo" },
      ],
      creditsTitle: "What does each task cost?",
      credits: [
        { action: "Social post / image / ad / chat", cost: "1" },
        { action: "SEO article", cost: "2" },
        { action: "WhatsApp campaign / TikTok slideshow", cost: "3" },
        { action: "Video 4–12s", cost: "12" },
        { action: "Video 16–20s", cost: "24" },
      ],
    },
    faq: {
      eyebrow: "FAQ",
      title: "What everyone asks before subscribing.",
      items: [
        { q: "Does Noor publish without my permission?", a: "No, unless you turn that on. By default everything goes through the approval inbox. You can delegate specific types (say, social posts) once you trust her." },
        { q: "Does she change my ad budgets?", a: "On Starter: suggestions only. On Pro and above: she adjusts within limits you set (daily cap, minimum ROAS, allowed channels). Every change is logged and reversible." },
        { q: "How good is the Arabic?", a: "Noor writes in simplified MSA or light Gulf dialect — your choice. She learns from your edits, and you keep a list of banned and preferred words." },
        { q: "Where is my data stored?", a: "On servers inside Saudi Arabia (a Saudi cloud region), compliant with the Personal Data Protection Law. We never train general models on your data." },
        { q: "Is WhatsApp allowed?", a: "Yes, through the official WhatsApp Business API with Meta-approved templates. No personal numbers or unofficial tools." },
        { q: "What if I run out of credits?", a: "Buy a top-up when you need it, or upgrade. We never stop your running campaigns abruptly." },
        { q: "Does she replace my agency?", a: "For most: yes, for daily execution. For big campaigns and professional production: Noor works alongside the agency and saves you the execution hours." },
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
      ok: "Done. We'll email you within 48 hours.",
      err: "Didn't send. Try again or email hello@nashr.ai",
    },
    footer: {
      tagline: "A marketing agent that works 24/7 — built in Riyadh for the Gulf.",
      rights: "© 2026 Nashr. All rights reserved.",
      links: [
        { label: "Pricing", href: "#pricing" },
        { label: "FAQ", href: "#faq" },
        { label: "Privacy", href: "#" },
        { label: "Terms", href: "#" },
      ],
    },
  },
};
