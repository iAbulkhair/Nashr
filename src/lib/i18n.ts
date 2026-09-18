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
  land: {
    hero: { eyebrow: string; title: string; sub: string; urlPlaceholder: string; urlCta: string; assess: string; trial: string };
    highlights: { title: string; sub: string; items: { t: string; d: string }[] };
    teammate: { title: string; body: string; cards: { label: string; title: string; body: string }[] };
    oldway: { title: string; sub: string; old: { label: string; items: string[] }; new: { label: string; items: string[] } };
    runs: { title: string; sub: string; items: { tag: string; quote: string; does: string; proof: string }[]; callout: string };
    deliverables: { eyebrow: string; title: string; sub: string; items: { n: string; l: string }[]; note: string };
    pillars: { title: string; sub: string; items: { t: string; d: string; chips: string[] }[] };
    cta: { title: string; sub: string; button: string };
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
    nav: { how: "كيف تعمل", agents: "الوكلاء", industries: "القطاعات", pricing: "الأسعار", faq: "الأسئلة", cta: "ابدأ مجاناً", switchLang: "English", switchHref: "/en", tools: "أدوات مجانية", blog: "المدونة" },
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
    land: {
      hero: {
        eyebrow: "نقدّم لك نور وفريقها",
        title: "فريق تسويق ومبيعات كامل. يشتغل قبل ما تصحى.",
        sub: "تقرأ. تخطط. تكتب. تتعلم من كل تعديل. كل صباح، قبل أن يبدأ يومك، وبلهجتك.",
        urlPlaceholder: "ضع رابط موقعك أو متجرك",
        urlCta: "ابدأ",
        assess: "أول تقييم لعلامتك خلال دقيقتين.",
        trial: "تجربة 3 أيام. بدون بطاقة. ألغِ متى شئت.",
      },
      highlights: {
        title: "الخلاصة.",
        sub: "عملية تسويقك كلها. نور واحدة. دائماً شغالة.",
        items: [
          { t: "ملخص الصباح كل يوم", d: "08:00 بتوقيت السعودية: ما ينتظر موافقتك، ما نُشر، رصيدك، والمواسم القريبة. في التطبيق وعلى إيميلك." },
          { t: "تتعلم صوت علامتك", d: "من موقعك أولاً، ثم من كل تعديل ورفض. النبرة واللهجة والكلمات الممنوعة تُكتب في ملف تقرؤه في كل مرة." },
          { t: "محتوى السوشال جاهز للنشر", d: "إنستقرام، سناب، تيك توك، X. 10 منشورات في الدفعة، مع الهاشتاقات وسكربتات الفيديو والصور." },
          { t: "الإعلانات والواتساب", d: "5 نسخ إعلانية بجمهور وميزانية مقترحة بالريال، و3 رسائل واتساب لاسترجاع السلات والعروض والشكر." },
          { t: "خطة الأسبوع كل أحد", d: "ماذا تنشر، متى، وأين تعلن، مبنية على تقويم الخليج: رمضان، الأعياد، اليوم الوطني، الجمعة البيضاء." },
          { t: "تقارير وأرقام صادقة", d: "لوحة مؤشرات لمساحة عملك، تقرير أسبوعي، وعرض مجلس إدارة يُحمَّل PowerPoint. بلا أرقام مخترعة." },
        ],
      },
      teammate: {
        title: "تشتغل وأنت نايم.",
        body: "زميلة حقيقية لا موظفة مؤقتة: تعرف منتجاتك وعملاءك ومنافسيك، تعمل بالليل، وتسلّمك الصباح كل شيء جاهزاً للموافقة. لا اجتماعات، لا متابعة، لا عذر.",
        cards: [
          { label: "مراقبة المواسم", title: "تعرف ما تغيّر الليلة.", body: "الأيام المتبقية على رمضان والأعياد واليوم الوطني، وما يجب أن يتغيّر في محتواك قبلها بأسابيع." },
          { label: "تنفيذ أسبوعي", title: "أسبوع كامل، في طريقه للتنفيذ.", body: "خطة، منشورات، رسائل، إعلانات ومقالات، كلها في صندوق واحد تعتمده بضغطة." },
        ],
      },
      oldway: {
        title: "ما عاد تحتاج وكالة.",
        sub: "الوكالة تطلب اجتماعاً لكل تعديل وتفوتها المواسم. نور تعرف موسمك قبل أن تسألها.",
        old: { label: "الطريقة القديمة", items: ["وكالة بـ 8,000+ ريال شهرياً أو موظف بـ 10,000+", "10 لوحات لا تفتحها و25 ساعة متابعة كل أسبوع", "محتوى متأخر عن الموسم، ولهجة غير لهجتك", "لا أحد يقرأ تعديلاتك ويتعلم منها"] },
        new: { label: "طريقة نور", items: ["فريق كامل من 149 ريالاً شهرياً", "كل شيء في صندوق موافقة واحد، وملخص صباحي", "محتوى بلهجتك، مبني على تقويم الخليج", "تتعلم من كل تعديل ورفض وتتحسن كل أسبوع"] },
      },
      runs: {
        title: "تدير كل شيء.",
        sub: "التسويق، ثم المبيعات والمالية والنمو والتقارير. من ملف علامة واحد.",
        items: [
          { tag: "استراتيجية", quote: "ما عندي وقت أفكر، أنا أطفّي حرائق.", does: "نور تقرأ موقعك وسوقك ومنافسيك وتكتب ملف علامتك وخطة 90 يوماً، ثم خطة كل أسبوع.", proof: "ملف العلامة والخطة خلال دقيقة من رابط موقعك." },
          { tag: "بحث", quote: "ما نظهر في قوقل، والـ SEO دايماً مؤجّل.", does: "مقالات عربية 1,200-1,600 كلمة مهيكلة مع أسئلة شائعة، ومنشورات Google Business، مبنية على فجوات منافسيك.", proof: "مقال جاهز للنشر بكريدتين." },
          { tag: "واتساب", quote: "قائمة عملائي باردة لأني ما أراسلها.", does: "رسائل استرجاع السلة والعروض الموسمية والشكر بعد الشراء، بقوالب جاهزة لواتساب للأعمال وبنبرة محترمة.", proof: "3 رسائل جاهزة في كل دفعة." },
          { tag: "إعلانات", quote: "أصرف، وما أدري وش اللي يشتغل.", does: "نسخ إعلانية لسناب وميتا وتيك توك مع جمهور مقترح وميزانية يومية بالريال، وتجارب نمو بتقييم ICE.", proof: "5 إعلانات في كل دفعة." },
          { tag: "سوشال", quote: "الفيد وحش جوعان وأنا دايماً متأخر.", does: "10 منشورات في الدفعة: كابشنات، سكربتات سناب وتيك توك، منشور X، وصور مولّدة على ذوق الخليج.", proof: "حتى 50 منشوراً في الشهر على الخطة الاحترافية." },
          { tag: "مبيعات ومالية", quote: "التسويق يجيب اهتمام، لكن من يقفل الصفقة ويحسب الأرقام؟", does: "سامي يكتب سكربتات وتأهيل العملاء والمتابعة، رزان تراجع التسعير والتدفق النقدي، دانة تكتب التقرير والعرض.", proof: "7 وكلاء من ملف علامة واحد." },
        ],
        callout: "استرجع 25 ساعة كل أسبوع، بلا توظيف ولا إدارة ولا مطاردة مصمم حر.",
      },
      deliverables: {
        eyebrow: "أول 30 يوماً",
        title: "شغل حقيقي، من اليوم الأول.",
        sub: "هذا ما تجده في صندوق موافقتك خلال شهرك الأول على الخطة الاحترافية.",
        items: [
          { n: "40+", l: "منشور سوشال بلهجتك" },
          { n: "4", l: "مقالات SEO عربية" },
          { n: "12", l: "رسالة واتساب جاهزة" },
          { n: "20", l: "نسخة إعلانية بميزانيتها" },
        ],
        note: "كل عنصر ينتظر موافقتك. لا يُنشر شيء بدونك إلا ما تفوّضه من صفحة الحوكمة.",
      },
      pillars: {
        title: "بناها مسوّقون. وتضبطها أنت.",
        sub: "كتيّبات مجرّبة لكل قطاع، وصوت علامتك، وحلقة تعلّم من كل موافقة.",
        items: [
          { t: "من مسوّقين", d: "كتيّبات لكل قطاع: تجارة إلكترونية، عيادات، مطاعم، عقار، قانون، شركات ناشئة، وكالات. لا تخمينات ذكاء اصطناعي عامة.", chips: ["كتيّبات القطاعات", "حواجز الالتزام السعودية", "مراجع ثانٍ لكل عنصر", "تقويم الخليج"] },
          { t: "علامتك، متعلَّمة", d: "النبرة واللهجة والمنتجات والعملاء والكلمات الممنوعة تشكّل كل قطعة. تعدّلها في ملف، أو تقولها لنور في الدردشة.", chips: ["سعودي خفيف", "فصحى مبسطة", "إماراتي", "عربي + إنجليزي"] },
          { t: "تتحسن وحدها", d: "كل تعديل ورفض يُكتب في ذاكرتها ويُقرأ في كل توليد. وحَكَم آلي يقيّم كل عنصر من 100 قبل أن يصلك.", chips: ["preferences.md", "درجة جودة لكل عنصر", "نسبة الاعتماد", "تنبيهات المتابعة"] },
        ],
      },
      cta: { title: "جاهز تشتغل مع نور؟", sub: "تجربة 3 أيام · بدون بطاقة · ألغِ متى شئت", button: "ابدأ مجاناً" },
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
      title: "نور تقود التسويق. وفريقها يغطي المبيعات والمالية والنمو والتقارير.",
      sub: "فريق كامل يعمل من ملف علامتك نفسه. كل عنصر ينتظر موافقتك.",
      items: [
        { name: "نور", role: "التسويق", body: "تخطط وتكتب وتنسّق عبر كل القنوات. هي التي تراسلك صباحاً.", does: ["الخطة الأسبوعية", "منشورات ومقالات SEO", "واتساب وإعلانات", "Google Business"] },
        { name: "سامي", role: "تمكين المبيعات", body: "يحوّل الاهتمام إلى صفقات: تأهيل العملاء، سكربتات، اعتراضات، متابعة.", does: ["بطاقة تأهيل العملاء", "سكربت مكالمة وواتساب", "جدول الاعتراضات", "سلسلة متابعة 7 رسائل"] },
        { name: "رزان", role: "المالية والتسعير", body: "تسعير بالريال شامل الضريبة، اقتصاديات الوحدة، وتدفق نقدي لـ 90 يوماً.", does: ["مراجعة التسعير", "اقتصاديات الوحدة", "توقع التدفق النقدي", "مراجعة الإيرادات"] },
        { name: "فارس", role: "الدخول للسوق والنمو", body: "التموضع، خطة 90 يوماً، تجارب نمو بتقييم ICE، والاحتفاظ والإحالة.", does: ["خطة GTM", "5 تجارب نمو", "3 خطط احتفاظ", "برامج الإحالة"] },
        { name: "دانة", role: "التقارير والعروض", body: "تقرير أسبوعي صادق من بياناتك، مواصفة لوحة المؤشرات، وعرض مجلس إدارة يُحمَّل PowerPoint.", does: ["التقرير الأسبوعي", "لوحة المؤشرات", "عرض المستثمرين", "الملخص التنفيذي"] },
        { name: "ماجد", role: "المستشار التنفيذي", body: "فريقك التنفيذي في شخص واحد: مراجعة استراتيجية، أهداف الربع، مذكرات قرار، قرارات محفظة المنتجات، وأين يفيدك الذكاء الاصطناعي فعلاً.", does: ["مراجعة 90 يوماً", "OKRs", "مذكرة قرار", "محفظة المنتجات", "خطة تبنّي الذكاء الاصطناعي"] },
        { name: "ليان", role: "المنتج والاحتفاظ", body: "من فكرة إلى PRD وخارطة طريق، ومن عميل جديد إلى عميل يعود: التفعيل والاحتفاظ والمتابعة.", does: ["PRD", "خارطة طريق RICE", "تحليل آراء العملاء", "رحلة التفعيل"] },
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
      trial: "تجربة 3 أيام مجاناً — بدون بطاقة",
      annual: "ادفع سنوياً ووفّر شهرين",
      plans: [
        { name: "البداية", price: "149", period: "ريال / شهر", credits: "200 كريدت شهرياً", tagline: "للتاجر الفرد والمبدع", features: ["علامة واحدة، مستخدم واحد", "منشورات سوشال + صور", "مقالات SEO بالعربي", "حملات سناب وميتا (قراءة + اقتراحات)", "ملخص واتساب أسبوعي", "10 مهام متزامنة"], cta: "ابدأ مجاناً" },
        { name: "الاحتراف", price: "399", period: "ريال / شهر", credits: "700 كريدت شهرياً", tagline: "للمؤسس والمتجر والعيادة", highlight: true, features: ["كل ما في البداية", "ضبط الإعلانات تلقائياً ضمن حدودك", "حملات واتساب + استرجاع السلات", "تدقيق إعلانات أسبوعي وكشف الهدر", "ملخص يومي 8 صباحاً", "70+ خطة جاهزة خليجية", "مقاعد إضافية 99 ريال/مقعد", "20 مهمة متزامنة"], cta: "ابدأ مجاناً" },
        { name: "الوكالة", price: "799", period: "ريال / شهر", credits: "2,000 كريدت شهرياً — يترحّل", tagline: "للوكالات ومتعدد الفروع", features: ["كل ما في الاحتراف", "علامات متعددة (5 مشمولة)", "علامة إضافية 99 ريال", "تقارير بعلامتك للعملاء", "صلاحيات فريق وأدوار", "ضبط الإعلانات كل ساعتين", "مهام غير محدودة", "وصول MCP و API"], cta: "ابدأ مجاناً" },
        { name: "المؤسسات", price: "حسب الطلب", period: "فوترة سنوية", credits: "كريدت مخصص", tagline: "للمجموعات والجهات الكبيرة", features: ["الوكلاء المتخصصون كلهم", "استضافة البيانات داخل السعودية", "ربط CRM ومستودع البيانات", "تدريب نموذج على صوت علامتك", "مدير نجاح مخصص", "SLA ساعة واحدة", "علامات ومستخدمون بلا حد"], cta: "احجز عرضاً" },
      ],
      creditsTitle: "كم تكلّف كل مهمة؟",
      credits: [
        { action: "منشور سوشال / إعلان / رسالة واتساب / صورة", cost: "1" },
        { action: "مقال SEO / بطاقة تأهيل / تقرير أسبوعي", cost: "2" },
        { action: "اقتصاديات الوحدة / سلسلة متابعة", cost: "3" },
        { action: "سكربتات مبيعات / مراجعة تسعير / تدفق نقدي / تجارب نمو", cost: "4" },
        { action: "خطة دخول للسوق / عرض مجلس الإدارة / مراجعة استراتيجية", cost: "5" },
        { action: "الدردشة مع الفريق والإعداد من رابط موقعك", cost: "مجاناً" },
      ],
    },
    faq: {
      eyebrow: "الأسئلة الشائعة",
      title: "أسئلة؟ خذ الخلاصة.",
      items: [
        { q: "ليش ما أستخدم ChatGPT أو Claude مباشرة؟", a: "تقدر، وستقضي وقتك تكتب الأوامر وتنسخ وتلصق. نور مبنية للتسويق الخليجي: ملف علامة تقرؤه في كل مرة، كتيّبات لكل قطاع، تقويم رمضان والأعياد، مراجع ثانٍ للالتزام، صندوق موافقة، جدولة، ونشر عبر التكاملات. وتتعلم من تعديلاتك." },
        { q: "هل تنشر نور بدون إذني؟", a: "لا. كل عنصر ينتظر موافقتك في الصندوق. بعد أن تثق بها، تفوّض أنواعاً محددة من صفحة الحوكمة." },
        { q: "وش يعني ملخص الصباح؟", a: "كل يوم 08:00 بتوقيت السعودية: ما ينتظر موافقتك، ما اعتُمد، رصيدك، المواسم القريبة، ومتابعات الفريق (عناصر موعدها اليوم، أشياء تنتظرك من يومين). في التطبيق وعلى إيميلك." },
        { q: "متى أشوف نتائج؟", a: "ملف العلامة وخطة 90 يوماً خلال دقيقة من رابط موقعك، وأول دفعة محتوى خلال دقيقتين. المقالات والـ SEO تتراكم عادةً خلال 2-3 أشهر." },
        { q: "كم تكلّف؟", a: "كريدت شهري حسب الخطة: البداية 149، الاحتراف 399، الوكالة 799 ريال. منشور = 1 كريدت، مقال = 2، عرض مجلس إدارة = 5. الدردشة مع الفريق مجانية. تغيّر الخطة متى شئت." },
        { q: "الخصوصية؟", a: "بياناتك لمساحة عملك فقط، لا تُستخدم لتدريب نماذج ولا تُشارك بين الحسابات. مفاتيح التكاملات مشفّرة. تحذف حسابك وكل بياناته بنفسك من صفحة الملف الشخصي." },
        { q: "هل تتعلم صوت علامتي؟", a: "نعم. من موقعك أولاً، ثم من كل تعديل ورفض تكتبه، يُحفظ في preferences.md وتلتزم به. عادةً 20 تعديلاً تكفي لتثبيت صوتك." },
        { q: "أقدر ألغي؟", a: "نعم. تجربة 3 أيام بدون بطاقة، وبعدها ترقّي أو تخفّض أو تلغي من صفحة الاشتراك. السنوي يوفّر شهرين." },
        { q: "من هم بقية الفريق؟", a: "سامي للمبيعات، رزان للمالية والتسعير، فارس للنمو، دانة للتقارير والعروض، ماجد المستشار التنفيذي، ليان للمنتج والاحتفاظ. كلهم في الدردشة نفسها ومن ملف العلامة نفسه." },
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
    brand: "Nashr",
    agent: "Noor",
    nav: { how: "How it works", agents: "Agents", industries: "Industries", pricing: "Pricing", faq: "FAQ", cta: "Start free", switchLang: "العربية", switchHref: "/ar", tools: "Free tools", blog: "Blog" },
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
    land: {
      hero: {
        eyebrow: "Introducing Noor and her team",
        title: "Your whole marketing team. Working before you wake up.",
        sub: "Reads. Plans. Writes. Learns from every edit. Every morning, before your day starts, in your dialect.",
        urlPlaceholder: "Enter your website or store URL",
        urlCta: "Start",
        assess: "Get your first brand assessment in 2 minutes.",
        trial: "3-day free trial. No card. Cancel anytime.",
      },
      highlights: {
        title: "Get the highlights.",
        sub: "Your entire marketing operation. One Noor. Always on.",
        items: [
          { t: "Daily morning brief", d: "08:00 KSA: what waits for your approval, what went out, your balance, upcoming seasons. In the app and in your inbox." },
          { t: "Brand voice, learned", d: "From your website first, then from every edit and rejection. Tone, dialect and banned words live in a file she reads every time." },
          { t: "Social content, ready to post", d: "Instagram, Snapchat, TikTok, X. Ten posts per batch with hashtags, video scripts and generated visuals." },
          { t: "Ads and WhatsApp", d: "Five ad variants with a suggested audience and daily budget in SAR, and three WhatsApp messages for cart recovery, offers and thanks." },
          { t: "Weekly plan every Sunday", d: "What to post, when, and where to advertise, built on the Gulf calendar: Ramadan, Eids, National Day, White Friday." },
          { t: "Honest reports and numbers", d: "A live dashboard of your workspace, a weekly report, and a board deck that downloads as PowerPoint. No invented figures." },
        ],
      },
      teammate: {
        title: "She works while you sleep.",
        body: "A real teammate, not a contractor: she knows your products, customers and competitors, works overnight, and hands you the morning with everything ready to approve. No meetings, no chasing, no excuses.",
        cards: [
          { label: "Season watch", title: "Know what changed overnight.", body: "Days left to Ramadan, Eid and National Day, and what should change in your content weeks before." },
          { label: "Weekly execution", title: "A full week, already in motion.", body: "Plan, posts, messages, ads and articles, all in one inbox you approve with a click." },
        ],
      },
      oldway: {
        title: "Never hire another agency again.",
        sub: "An agency needs a meeting for every edit and misses your seasons. Noor knows your season before you ask.",
        old: { label: "The old way", items: ["An agency at SAR 8,000+/month or a hire at 10,000+", "10 dashboards you never open, 25 hours of follow-up a week", "Content late for the season, in someone else's dialect", "Nobody reads your edits and learns from them"] },
        new: { label: "The Noor way", items: ["A full team from SAR 149/month", "Everything in one approval inbox, plus a morning brief", "Content in your dialect, on the Gulf calendar", "Learns from every edit and rejection, better every week"] },
      },
      runs: {
        title: "She runs the whole thing.",
        sub: "Marketing first, then sales, finance, growth and reporting. From one brand file.",
        items: [
          { tag: "Strategy", quote: "I have no time to think, I'm putting out fires.", does: "Noor reads your site, market and competitors, writes your brand file and a 90-day plan, then a plan every week.", proof: "Brand file and plan within a minute of your URL." },
          { tag: "Search", quote: "We're invisible on Google and SEO never gets done.", does: "Arabic articles of 1,200-1,600 words with FAQs, plus Google Business posts, built on your competitors' gaps.", proof: "A publish-ready article for two credits." },
          { tag: "WhatsApp", quote: "My customer list goes cold because I never message it.", does: "Cart recovery, seasonal offers and post-purchase thanks, as WhatsApp Business templates in a respectful tone.", proof: "Three ready messages per batch." },
          { tag: "Ads", quote: "I'm spending, but can't tell what's working.", does: "Ad copy for Snapchat, Meta and TikTok with a suggested audience and daily budget in SAR, and ICE-scored growth experiments.", proof: "Five ads per batch." },
          { tag: "Social", quote: "The feed is a hungry beast and I'm always behind.", does: "Ten posts per batch: captions, Snapchat and TikTok scripts, an X post, and generated visuals with Gulf taste.", proof: "Up to 50 posts a month on Pro." },
          { tag: "Sales and finance", quote: "Marketing brings attention, but who closes and who counts?", does: "Sami writes scripts, qualification and follow-ups, Razan reviews pricing and cash flow, Dana writes the report and the deck.", proof: "Seven agents from one brand file." },
        ],
        callout: "Get back 25 hours every week, without hiring, managing, or chasing a single freelancer.",
      },
      deliverables: {
        eyebrow: "The first 30 days",
        title: "Already doing the work.",
        sub: "What lands in your approval inbox in the first month on the Pro plan.",
        items: [
          { n: "40+", l: "social posts in your dialect" },
          { n: "4", l: "Arabic SEO articles" },
          { n: "12", l: "WhatsApp messages, ready" },
          { n: "20", l: "ad variants with budgets" },
        ],
        note: "Every item waits for your approval. Nothing goes out without you, unless you delegate it in Governance.",
      },
      pillars: {
        title: "Built by marketers. Tuned by you.",
        sub: "Proven playbooks per industry, your brand voice, and a learning loop from every approval.",
        items: [
          { t: "By marketers", d: "Playbooks per industry: e-commerce, clinics, restaurants, real estate, legal, startups, agencies. Not generic AI guesses.", chips: ["Industry playbooks", "Saudi compliance guardrails", "Second-pass reviewer", "Gulf calendar"] },
          { t: "Your brand, learned", d: "Tone, dialect, products, customers and banned words shape every piece. Edit them in a file, or just tell Noor in chat.", chips: ["Light Saudi", "Simple MSA", "Emirati", "Arabic + English"] },
          { t: "Self-improving", d: "Every edit and rejection is written to her memory and read on every generation. An automated judge scores each item out of 100 before it reaches you.", chips: ["preferences.md", "Quality score per item", "Approval rate", "Follow-up alerts"] },
        ],
      },
      cta: { title: "Ready to work with Noor?", sub: "3-day free trial · No card · Cancel anytime", button: "Start free" },
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
      title: "Noor runs marketing. Her team covers sales, finance, growth and reporting.",
      sub: "One team working from the same brand file. Every item waits for your approval.",
      items: [
        { name: "Noor", role: "Marketing", body: "Plans, writes and coordinates across every channel. She's the one who messages you each morning.", does: ["Weekly plan", "Posts and SEO articles", "WhatsApp and ads", "Google Business"] },
        { name: "Sami", role: "Sales enablement", body: "Turns attention into deals: lead qualification, scripts, objections, follow-ups.", does: ["Lead qualification card", "Call and WhatsApp scripts", "Objection sheet", "7-touch follow-up cadence"] },
        { name: "Razan", role: "Finance and pricing", body: "SAR pricing with VAT in mind, unit economics, and a 90-day cash-flow forecast.", does: ["Pricing review", "Unit economics", "Cash-flow forecast", "Revenue review"] },
        { name: "Faris", role: "Go-to-market and growth", body: "Positioning, a 90-day plan, ICE-scored growth experiments, retention and referrals.", does: ["GTM plan", "5 growth experiments", "3 retention plays", "Referral programs"] },
        { name: "Dana", role: "Reports and decks", body: "An honest weekly report from your data, a dashboard spec, and a board deck that downloads as PowerPoint.", does: ["Weekly report", "Dashboard spec", "Investor deck", "Executive summary"] },
        { name: "Majed", role: "Executive advisor", body: "Your executive team in one person: strategy review, quarterly OKRs, decision memos, product portfolio calls, and where AI actually pays off.", does: ["90-day review", "OKRs", "Decision memo", "Product portfolio", "AI adoption plan"] },
        { name: "Layan", role: "Product and retention", body: "From idea to PRD and roadmap, and from new customer to returning customer: activation, retention, follow-ups.", does: ["PRD", "RICE roadmap", "Feedback synthesis", "Activation flow"] },
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
      trial: "3-day free trial — no card",
      annual: "Pay yearly, get two months free",
      plans: [
        { name: "Starter", price: "149", period: "SAR / month", credits: "200 credits / month", tagline: "For solo sellers and creators", features: ["1 brand, 1 seat", "Social posts + images", "Arabic SEO articles", "Snap & Meta campaigns (read + suggest)", "Weekly WhatsApp brief", "10 concurrent tasks"], cta: "Start free" },
        { name: "Pro", price: "399", period: "SAR / month", credits: "700 credits / month", tagline: "For founders, stores, and clinics", highlight: true, features: ["Everything in Starter", "Auto ad optimization within your guardrails", "WhatsApp campaigns + cart recovery", "Weekly ad audit and waste detection", "Daily 8 AM brief", "70+ Gulf-ready playbooks", "Extra seats SAR 99 / seat", "20 concurrent tasks"], cta: "Start free" },
        { name: "Agency", price: "799", period: "SAR / month", credits: "2,000 credits / month — rolls over", tagline: "For agencies and multi-branch", features: ["Everything in Pro", "Multi-brand (5 included)", "Extra brand SAR 99", "White-label client reports", "Team roles and permissions", "Ad optimization every 2 hours", "Unlimited tasks", "MCP and API access"], cta: "Start free" },
        { name: "Enterprise", price: "Custom", period: "annual billing", credits: "Custom credits", tagline: "For groups and large organizations", features: ["All specialist agents", "Data hosted inside Saudi Arabia", "CRM and data warehouse connections", "Model trained on your brand voice", "Dedicated success manager", "1-hour SLA", "Unlimited brands and users"], cta: "Book a demo" },
      ],
      creditsTitle: "What does each task cost?",
      credits: [
        { action: "Social post / ad / WhatsApp message / image", cost: "1" },
        { action: "SEO article / lead qualification card / weekly report", cost: "2" },
        { action: "Unit economics / follow-up cadence", cost: "3" },
        { action: "Sales scripts / pricing review / cash forecast / growth experiments", cost: "4" },
        { action: "Go-to-market plan / board deck / strategy review", cost: "5" },
        { action: "Chatting with the team and onboarding from your URL", cost: "Free" },
      ],
    },
    faq: {
      eyebrow: "FAQ",
      title: "Questions? Good to know.",
      items: [
        { q: "Can't I just use ChatGPT or Claude?", a: "You can, and you'll spend your time writing prompts and copy-pasting. Noor is built for Gulf marketing: a brand file she reads every time, playbooks per industry, the Ramadan and Eid calendar, a second-pass compliance reviewer, an approval inbox, scheduling, and publishing through integrations. And she learns from your edits." },
        { q: "Does Noor publish without permission?", a: "No. Every item waits in your inbox. Once you trust her, delegate specific types from Governance." },
        { q: "What is the morning brief?", a: "Every day at 08:00 KSA: what waits for approval, what was approved, your balance, upcoming seasons, and team follow-ups (items due today, things waiting for two days). In the app and by email." },
        { q: "How long until I see results?", a: "Brand file and 90-day plan within a minute of your URL, first content batch within two minutes. Articles and SEO typically compound over 2-3 months." },
        { q: "How much does it cost?", a: "Monthly credits by plan: Starter 149, Pro 399, Agency 799 SAR. A post is 1 credit, an article 2, a board deck 5. Chatting with the team is free. Switch plans anytime." },
        { q: "What about privacy?", a: "Your data stays in your workspace, is never used to train models and never shared across accounts. Integration keys are encrypted. Delete your account and all its data yourself from Profile." },
        { q: "Does Noor learn my brand voice?", a: "Yes. From your website first, then from every edit and rejection you write, saved to preferences.md and followed. About 20 edits usually lock in your voice." },
        { q: "Can I cancel anytime?", a: "Yes. 3-day trial with no card, then upgrade, downgrade or cancel from Subscription. Annual saves two months." },
        { q: "Who else is on the team?", a: "Sami for sales, Razan for finance and pricing, Faris for growth, Dana for reports and decks, Majed the executive advisor, Layan for product and retention. All in the same chat, from the same brand file." },
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
