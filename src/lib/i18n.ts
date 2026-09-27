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
    land: {
      hero: {
        eyebrow: "نقدّم لك نور وفريقها",
        title: "فريق تسويقك. مسودات جاهزة لموافقتك.",
        sub: "تقرأ. تخطط. تكتب. تتعلم من كل تعديل. بلهجتك.",
        urlPlaceholder: "ضع رابط موقعك أو متجرك",
        urlCta: "ابدأ",
        assess: "أول تقييم لعلامتك من رابط موقعك.",
        trial: "تجربة 3 أيام. بدون بطاقة. ألغِ متى شئت.",
      },
      highlights: {
        title: "الخلاصة.",
        sub: "خطط ومحتوى وتقارير لتسويقك. نور واحدة.",
        items: [
          { t: "ملخص الصباح كل يوم", d: "08:00 بتوقيت السعودية: ما ينتظر موافقتك، ما اعتمدته، رصيدك، والمواسم القريبة. في التطبيق." },
          { t: "تتعلم صوت علامتك", d: "من موقعك أولاً، ثم من كل تعديل ورفض. النبرة واللهجة والكلمات الممنوعة تُكتب في ملف تقرؤه في كل مرة." },
          { t: "محتوى السوشال جاهز للنشر", d: "إنستقرام، سناب، تيك توك، X. 10 منشورات في الدفعة، مع الهاشتاقات وسكربتات الفيديو." },
          { t: "الإعلانات والواتساب", d: "5 نسخ إعلانية بجمهور وميزانية مقترحة بالريال، و3 رسائل واتساب لاسترجاع السلات والعروض والشكر." },
          { t: "خطة الأسبوع كل أحد", d: "ماذا تنشر، متى، وأين تعلن، مبنية على تقويم الخليج: رمضان، الأعياد، اليوم الوطني، الجمعة البيضاء." },
          { t: "تقارير وأرقام صادقة", d: "لوحة مؤشرات لمساحة عملك، تقرير أسبوعي، وعرض مجلس إدارة يُحمَّل PowerPoint. بلا أرقام مخترعة." },
        ],
      },
      teammate: {
        title: "تخطط أسبوعك كل أحد.",
        body: "زميلة لا موظفة مؤقتة: تقرأ ملف علامتك ومنتجاتك وملاحظات سوقك قبل كل مهمة، وتترك لك ملخصاً صباحياً بما ينتظر موافقتك. لا اجتماعات، لا متابعة.",
        cards: [
          { label: "مراقبة المواسم", title: "تعرف المواسم القادمة.", body: "الأيام المتبقية على رمضان واليوم الوطني والمواسم القريبة، وما يجب أن يتغيّر في محتواك قبلها." },
          { label: "تنفيذ أسبوعي", title: "أسبوع كامل، بخطة جاهزة.", body: "خطة، منشورات، رسائل، إعلانات ومقالات، كلها في صندوق واحد تعتمده بضغطة." },
        ],
      },
      oldway: {
        title: "الطريقة القديمة، وطريقة نور.",
        sub: "نور تعرف موسمك قبل أن تسألها.",
        old: { label: "الطريقة القديمة", items: ["وكالة برسوم شهرية أو موظف براتب كامل", "لوحات لا تفتحها وساعات متابعة كل أسبوع", "محتوى متأخر عن الموسم، ولهجة غير لهجتك", "لا أحد يقرأ تعديلاتك ويتعلم منها"] },
        new: { label: "طريقة نور", items: ["فريق كامل من 149 ريالاً شهرياً", "كل شيء في صندوق موافقة واحد، وملخص صباحي", "محتوى بلهجتك، مبني على تقويم الخليج", "تتعلم من كل تعديل، وكل رفض مع سببه"] },
      },
      runs: {
        title: "تغطي التسويق وما بعده.",
        sub: "التسويق، ثم المبيعات والمالية والنمو والتقارير. من ملف علامة واحد.",
        items: [
          { tag: "استراتيجية", quote: "ما عندي وقت أفكر، أنا أطفّي حرائق.", does: "نور تقرأ موقعك وتكتب ملف علامتك وملاحظات عن سوقك ومنافسيك وخطة 90 يوماً، ثم خطة كل أسبوع.", proof: "ملف العلامة والخطة من رابط موقعك، مجاناً." },
          { tag: "بحث", quote: "ما نظهر في قوقل، والـ SEO دايماً مؤجّل.", does: "مقالات عربية 1,200-1,600 كلمة مهيكلة مع أسئلة شائعة، ومنشورات Google Business.", proof: "مقال جاهز للنشر بكريدتين." },
          { tag: "واتساب", quote: "قائمة عملائي باردة لأني ما أراسلها.", does: "رسائل استرجاع السلة والعروض الموسمية والشكر بعد الشراء، بقوالب جاهزة لواتساب للأعمال وبنبرة محترمة.", proof: "3 رسائل جاهزة في كل دفعة." },
          { tag: "إعلانات", quote: "أصرف، وما أدري وش اللي يشتغل.", does: "نسخ إعلانية لسناب وميتا وتيك توك مع جمهور مقترح وميزانية يومية بالريال، وتجارب نمو بتقييم ICE.", proof: "5 إعلانات في كل دفعة." },
          { tag: "سوشال", quote: "الفيد وحش جوعان وأنا دايماً متأخر.", does: "10 منشورات في الدفعة: كابشنات، سكربتات سناب وتيك توك، ومنشور X.", proof: "كل منشور بكريدت واحد." },
          { tag: "مبيعات ومالية", quote: "التسويق يجيب اهتمام، لكن من يقفل الصفقة ويحسب الأرقام؟", does: "سامي يكتب سكربتات وتأهيل العملاء والمتابعة، رزان تراجع التسعير والتدفق النقدي، دانة تكتب التقرير والعرض.", proof: "7 وكلاء من ملف علامة واحد." },
        ],
        callout: "مسودات تسويقك، بلا توظيف ولا إدارة ولا مطاردة مصمم حر.",
      },
      deliverables: {
        eyebrow: "في كل دفعة",
        title: "جاهز عندما تطلب.",
        sub: "ما يصل إلى صندوق موافقتك في كل مرة تطلب، على أي خطة.",
        items: [
          { n: "10", l: "منشورات سوشال في الدفعة، بلهجتك" },
          { n: "1", l: "مقال SEO في الدفعة" },
          { n: "3", l: "رسائل واتساب في الدفعة" },
          { n: "5", l: "نسخ إعلانية في الدفعة، بميزانياتها" },
        ],
        note: "كل عنصر ينتظر موافقتك إلا الأنواع التي تفوّضها من صفحة الحوكمة، ولا يُنشر شيء إلا بطلبك.",
      },
      pillars: {
        title: "كتيّبات خليجية. وتضبطها أنت.",
        sub: "كتيّبات لكل قطاع، وصوت علامتك، وحلقة تعلّم من تعديلاتك وأسباب رفضك.",
        items: [
          { t: "من مسوّقين", d: "كتيّبات لكل قطاع: تجارة إلكترونية، عيادات، مطاعم، عقار، قانون، شركات ناشئة، وكالات. لا تخمينات ذكاء اصطناعي عامة.", chips: ["كتيّبات القطاعات", "حواجز الالتزام السعودية", "مراجع ثانٍ لكل عنصر", "تقويم الخليج"] },
          { t: "علامتك، متعلَّمة", d: "النبرة واللهجة والمنتجات والعملاء والكلمات الممنوعة تشكّل كل قطعة. تعدّلها في ملف، أو تقولها لنور في الدردشة.", chips: ["سعودي خفيف", "فصحى مبسطة", "إماراتي", "عربي + إنجليزي"] },
          { t: "تتحسن وحدها", d: "كل تعديل، وكل رفض مع سببه، يُكتب في ذاكرتها ويُقرأ في كل توليد. وحَكَم آلي يقيّم كل عنصر من 100.", chips: ["preferences.md", "درجة جودة لكل عنصر", "نسبة الاعتماد", "تنبيهات المتابعة"] },
        ],
      },
      cta: { title: "جاهز تشتغل مع نور؟", sub: "تجربة 3 أيام · بدون بطاقة · ألغِ متى شئت", button: "ابدأ مجاناً" },
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
        { name: "وكالات التسويق", body: "عدة علامات من حساب واحد على خطة الوكالة، ولكل علامة ملفها وصندوق موافقتها." },
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
        { name: "البداية", price: "149", period: "ريال / شهر", credits: "200 كريدت شهرياً", tagline: "للتاجر الفرد والمبدع", features: ["علامة واحدة، مستخدم واحد", "منشورات سوشال (الصور قريباً)", "مقالات SEO بالعربي", "نسخ إعلانية لسناب وميتا", "ملخص يومي 8 صباحاً", "كتيّبات جاهزة لقطاعات الخليج", "وصول MCP"], cta: "ابدأ مجاناً" },
        { name: "الاحتراف", price: "399", period: "ريال / شهر", credits: "700 كريدت شهرياً", tagline: "للمؤسس والمتجر والعيادة", highlight: true, features: ["كل ما في البداية", "ضبط الإعلانات تلقائياً ضمن حدودك (قريباً)", "حملات واتساب + استرجاع السلات (قريباً)", "تدقيق إعلانات أسبوعي وكشف الهدر (قريباً)", "مقاعد إضافية 99 ريال/مقعد (قريباً)"], cta: "ابدأ مجاناً" },
        { name: "الوكالة", price: "799", period: "ريال / شهر", credits: "2,000 كريدت شهرياً — يتجدد كل شهر ولا يترحّل", tagline: "للوكالات ومتعدد الفروع", features: ["كل ما في الاحتراف", "علامات متعددة (5 مشمولة)", "علامة إضافية 99 ريال (قريباً)", "تقارير بعلامتك للعملاء (قريباً)", "صلاحيات فريق وأدوار (قريباً)", "ضبط الإعلانات كل ساعتين (قريباً)"], cta: "ابدأ مجاناً" },
        { name: "المؤسسات", price: "حسب الطلب", period: "فوترة سنوية", credits: "كريدت مخصص", tagline: "للمجموعات والجهات الكبيرة", features: ["الوكلاء المتخصصون كلهم", "استضافة البيانات داخل السعودية (قريباً)", "ربط CRM ومستودع البيانات (قريباً)", "تدريب نموذج على صوت علامتك (قريباً)", "مدير نجاح مخصص", "SLA ساعة واحدة (قريباً)", "علامات ومستخدمون بلا حد (قريباً)"], cta: "احجز عرضاً" },
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
        { q: "ليش ما أستخدم ChatGPT أو Claude مباشرة؟", a: "تقدر، وستقضي وقتك تكتب الأوامر وتنسخ وتلصق. نور مبنية للتسويق الخليجي: ملف علامة تقرؤه في كل مرة، كتيّبات لكل قطاع، تقويم رمضان والأعياد، مراجع ثانٍ للالتزام، صندوق موافقة، تقويم نشر، ونشر عبر التكاملات. وتتعلم من تعديلاتك." },
        { q: "هل تنشر نور بدون إذني؟", a: "لا. كل عنصر ينتظر موافقتك في الصندوق، والنشر دائماً بقرار منك. بعد أن تثق بها، تقدر تعتمد أنواعاً محددة تلقائياً من صفحة الحوكمة." },
        { q: "وش يعني ملخص الصباح؟", a: "كل يوم 08:00 بتوقيت السعودية: ما ينتظر موافقتك، ما اعتُمد، رصيدك، المواسم القريبة، ومتابعات الفريق (عناصر موعدها اليوم، أشياء تنتظرك من يومين). في التطبيق." },
        { q: "متى أشوف نتائج؟", a: "تكتب نور ملف العلامة وخطة 90 يوماً من رابط موقعك أثناء الإعداد، ثم تصلك أول دفعة محتوى عندما تطلبها." },
        { q: "كم تكلّف؟", a: "كريدت شهري حسب الخطة: البداية 149، الاحتراف 399، الوكالة 799 ريال. منشور = 1 كريدت، مقال = 2، عرض مجلس إدارة = 5. الدردشة مع الفريق مجانية. ولتغيير الخطة تواصل معنا." },
        { q: "الخصوصية؟", a: "بياناتك لمساحة عملك فقط: لا تستخدمها منصة نشر لتدريب النماذج، ولا تشاركها بين الحسابات. مفاتيح التكاملات مشفّرة. تحذف حسابك وبيانات مساحة عملك بنفسك من صفحة «حسابك»." },
        { q: "هل تتعلم صوت علامتي؟", a: "نعم. من موقعك أولاً، ثم من كل تعديل ورفض تكتبه، يُحفظ في preferences.md وتلتزم به." },
        { q: "أقدر ألغي؟", a: "نعم. تجربة 3 أيام بدون بطاقة، وبعدها تختار خطتك من صفحة الاشتراك. ولتغيير خطتك أو إلغائها، تواصل معنا." },
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
      ok: "تم! وصلتنا بياناتك.",
      err: "لم يتم الإرسال. جرّب مرة أخرى أو راسلنا على hello@nashr.ai",
    },
    footer: {
      tagline: "وكيلة تسويق مبنية للخليج.",
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
    land: {
      hero: {
        eyebrow: "Introducing Noor and her team",
        title: "Your marketing team. Drafts ready for your approval.",
        sub: "Reads. Plans. Writes. Learns from every edit. In your dialect.",
        urlPlaceholder: "Enter your website or store URL",
        urlCta: "Start",
        assess: "Get your first brand assessment from your website URL.",
        trial: "3-day free trial. No card. Cancel anytime.",
      },
      highlights: {
        title: "Get the highlights.",
        sub: "Plans, content and reports for your marketing. One Noor.",
        items: [
          { t: "Daily morning brief", d: "08:00 KSA: what waits for your approval, what you approved, your balance, upcoming seasons. In the app." },
          { t: "Brand voice, learned", d: "From your website first, then from every edit and rejection. Tone, dialect and banned words live in a file she reads every time." },
          { t: "Social content, ready to post", d: "Instagram, Snapchat, TikTok, X. Ten posts per batch with hashtags and video scripts." },
          { t: "Ads and WhatsApp", d: "Five ad variants with a suggested audience and daily budget in SAR, and three WhatsApp messages for cart recovery, offers and thanks." },
          { t: "Weekly plan every Sunday", d: "What to post, when, and where to advertise, built on the Gulf calendar: Ramadan, Eids, National Day, White Friday." },
          { t: "Honest reports and numbers", d: "A live dashboard of your workspace, a weekly report, and a board deck that downloads as PowerPoint. No invented figures." },
        ],
      },
      teammate: {
        title: "She plans your week every Sunday.",
        body: "A teammate, not a contractor: she reads your brand file, products and market notes before every task, and leaves a morning brief of what waits for your approval. No meetings, no chasing.",
        cards: [
          { label: "Season watch", title: "Know which season is coming.", body: "Days left to Ramadan, National Day and other upcoming seasons, and what should change in your content before them." },
          { label: "Weekly execution", title: "A full week, planned.", body: "Plan, posts, messages, ads and articles, all in one inbox you approve with a click." },
        ],
      },
      oldway: {
        title: "The old way, and the Noor way.",
        sub: "Noor knows your season before you ask.",
        old: { label: "The old way", items: ["An agency retainer or a full-time hire", "Dashboards you never open and hours of follow-up every week", "Content late for the season, in someone else's dialect", "Nobody reads your edits and learns from them"] },
        new: { label: "The Noor way", items: ["A full team from SAR 149/month", "Everything in one approval inbox, plus a morning brief", "Content in your dialect, on the Gulf calendar", "Learns from every edit and every rejection with a reason"] },
      },
      runs: {
        title: "She covers marketing and beyond.",
        sub: "Marketing first, then sales, finance, growth and reporting. From one brand file.",
        items: [
          { tag: "Strategy", quote: "I have no time to think, I'm putting out fires.", does: "Noor reads your site, writes your brand file, market notes and a 90-day plan, then a plan every week.", proof: "Brand file and plan from your URL, free." },
          { tag: "Search", quote: "We're invisible on Google and SEO never gets done.", does: "Arabic articles of 1,200-1,600 words with FAQs, plus Google Business posts.", proof: "A publish-ready article for two credits." },
          { tag: "WhatsApp", quote: "My customer list goes cold because I never message it.", does: "Cart recovery, seasonal offers and post-purchase thanks, as WhatsApp Business templates in a respectful tone.", proof: "Three ready messages per batch." },
          { tag: "Ads", quote: "I'm spending, but can't tell what's working.", does: "Ad copy for Snapchat, Meta and TikTok with a suggested audience and daily budget in SAR, and ICE-scored growth experiments.", proof: "Five ads per batch." },
          { tag: "Social", quote: "The feed is a hungry beast and I'm always behind.", does: "Ten posts per batch: captions, Snapchat and TikTok scripts, and an X post.", proof: "One credit per post." },
          { tag: "Sales and finance", quote: "Marketing brings attention, but who closes and who counts?", does: "Sami writes scripts, qualification and follow-ups, Razan reviews pricing and cash flow, Dana writes the report and the deck.", proof: "Seven agents from one brand file." },
        ],
        callout: "Your marketing drafts, without hiring, managing, or chasing a single freelancer.",
      },
      deliverables: {
        eyebrow: "Per batch",
        title: "Ready when you ask.",
        sub: "What lands in your approval inbox each time you ask, on any plan.",
        items: [
          { n: "10", l: "social posts per batch, in your dialect" },
          { n: "1", l: "SEO article per batch" },
          { n: "3", l: "WhatsApp messages per batch" },
          { n: "5", l: "ad variants per batch, with budgets" },
        ],
        note: "Every item waits for your approval. Types you delegate in Governance are the exception, and nothing is published unless you ask.",
      },
      pillars: {
        title: "Gulf playbooks. Tuned by you.",
        sub: "Playbooks per industry, your brand voice, and a learning loop from your edits and the reasons you give for rejections.",
        items: [
          { t: "By marketers", d: "Playbooks per industry: e-commerce, clinics, restaurants, real estate, legal, startups, agencies. Not generic AI guesses.", chips: ["Industry playbooks", "Saudi compliance guardrails", "Second-pass reviewer", "Gulf calendar"] },
          { t: "Your brand, learned", d: "Tone, dialect, products, customers and banned words shape every piece. Edit them in a file, or just tell Noor in chat.", chips: ["Light Saudi", "Simple MSA", "Emirati", "Arabic + English"] },
          { t: "Self-improving", d: "Every edit, and every rejection with a reason, is written to her memory and read on every generation. An automated judge scores each item out of 100.", chips: ["preferences.md", "Quality score per item", "Approval rate", "Follow-up alerts"] },
        ],
      },
      cta: { title: "Ready to work with Noor?", sub: "3-day free trial · No card · Cancel anytime", button: "Start free" },
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
        { name: "Marketing agencies", body: "Several brands from one account on the Agency plan, each with its own brand file and approval inbox." },
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
        { name: "Starter", price: "149", period: "SAR / month", credits: "200 credits / month", tagline: "For solo sellers and creators", features: ["1 brand, 1 seat", "Social posts (images coming soon)", "Arabic SEO articles", "Snap & Meta ad copy suggestions", "Daily 8 AM brief", "Gulf industry playbooks", "MCP server access"], cta: "Start free" },
        { name: "Pro", price: "399", period: "SAR / month", credits: "700 credits / month", tagline: "For founders, stores, and clinics", highlight: true, features: ["Everything in Starter", "Auto ad optimization within your guardrails (coming soon)", "WhatsApp campaigns + cart recovery (coming soon)", "Weekly ad audit and waste detection (coming soon)", "Extra seats SAR 99 / seat (coming soon)"], cta: "Start free" },
        { name: "Agency", price: "799", period: "SAR / month", credits: "2,000 credits / month, reset monthly", tagline: "For agencies and multi-branch", features: ["Everything in Pro", "Multi-brand (5 included)", "Extra brand SAR 99 (coming soon)", "White-label client reports (coming soon)", "Team roles and permissions (coming soon)", "Ad optimization every 2 hours (coming soon)"], cta: "Start free" },
        { name: "Enterprise", price: "Custom", period: "annual billing", credits: "Custom credits", tagline: "For groups and large organizations", features: ["All specialist agents", "Data hosted inside Saudi Arabia (coming soon)", "CRM and data warehouse connections (coming soon)", "Model trained on your brand voice (coming soon)", "Dedicated success manager", "1-hour SLA (coming soon)", "Unlimited brands and users (coming soon)"], cta: "Book a demo" },
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
        { q: "Can't I just use ChatGPT or Claude?", a: "You can, and you'll spend your time writing prompts and copy-pasting. Noor is built for Gulf marketing: a brand file she reads every time, playbooks per industry, the Ramadan and Eid calendar, a second-pass compliance reviewer, an approval inbox, a content calendar, and publishing through integrations. And she learns from your edits." },
        { q: "Does Noor publish without permission?", a: "No. Every item waits in your inbox, and publishing is always your call. Once you trust her, you can auto-approve specific types from Governance." },
        { q: "What is the morning brief?", a: "Every day at 08:00 KSA: what waits for approval, what was approved, your balance, upcoming seasons, and team follow-ups (items due today, things waiting for two days). In the app." },
        { q: "How long until I see results?", a: "Your brand file and 90-day plan are written from your URL during onboarding, and your first content batch arrives when you ask Noor for it." },
        { q: "How much does it cost?", a: "Monthly credits by plan: Starter 149, Pro 399, Agency 799 SAR. A post is 1 credit, an article 2, a board deck 5. Chatting with the team is free. To change plans, contact us." },
        { q: "What about privacy?", a: "Your data stays in your workspace, is never used by Nashr to train models and never shared across accounts. Integration keys are encrypted. Delete your account and its workspace data yourself from Profile." },
        { q: "Does Noor learn my brand voice?", a: "Yes. From your website first, then from every edit and rejection you write, saved to preferences.md and followed." },
        { q: "Can I cancel anytime?", a: "Yes. 3-day trial with no card. Upgrade from Subscription; to change or cancel your plan, contact us." },
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
      ok: "Done. We received your details.",
      err: "Didn't send. Try again or email hello@nashr.ai",
    },
    footer: {
      tagline: "A marketing agent built for the Gulf.",
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
