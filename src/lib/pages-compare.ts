import type { Lang } from "./i18n";
import { PLAN_CREDITS, PLAN_PRICE_SAR as P } from "./pricing";

// The comparison page compares Thakeen with kinds of alternative, never with a named product (rules 1740-1749, the
// founder's decision of 2026-10-13, option b). It replaces the five `/vs/{competitor}` pages, which named vendors, quoted
// their prices and put Noor first by our own reading; their addresses answer 308 here (next.config.ts, rule 1742). So
// nothing here names a company, a product, a logo or another vendor's price, and nothing ranks or scores: each group
// says where the alternative is the better choice too.
//
// Our prices and the trial credits come from src/lib/pricing.ts (rule 248). A direct Salla or Zid connection waits for
// both platforms to approve our apps (integration status "soon"), so it is called planned (rule 1743); reading a store's
// products from its public link works today for any store, Salla and Zid stores included (src/lib/catalog.ts).

export type CompareRow = { dim: string; them: string; us: string };
export type CompareGroup = { id: string; name: string; summary: string; rows: CompareRow[]; chooseThem: string[]; chooseUs: string[] };
export type ComparePage = { title: string; desc: string; intro: string; disclosure: string; groups: CompareGroup[]; choose: string; faq: { q: string; a: string }[] };

/** The four kinds of alternative, in the order the page shows them; each is an anchor on the page. */
export const COMPARE_GROUPS = ["general-ai-chat", "global-marketing-platforms", "agencies", "freelancers"] as const;

const ar: ComparePage = {
  title: "ذكين مقارنةً بالبدائل: أدوات المحادثة، المنصات العالمية، الوكالات، والمستقلون",
  desc: "مقارنة بالفئات لا بالأسماء: متى تكفيك أداة محادثة عامة، أو منصة تسويق عالمية، أو وكالة، أو مستقل، ومتى تناسبك نور من ذكين.",
  intro: "قبل ذكين، أمامك أربعة طرق شائعة لتسويق عملك: أداة محادثة عامة بالذكاء الاصطناعي، منصة تسويق عالمية، وكالة، أو مستقل. لكل طريق مكانه. هنا نقول أين يتفوق كل واحد، وأين تناسبك نور.",
  disclosure: "ذكين يبني نور، لذلك هذه المقارنة رأينا نحن. نقارن بفئات لا بأسماء، ولا نعطي درجات ولا نرتّب الخيارات، والأدوات داخل الفئة الواحدة تختلف، فتحقّق من الأداة التي تفكر بها بنفسك. وجدت معلومة غير دقيقة؟ راسلنا على hello@thakeen.com.",
  groups: [
    {
      id: "general-ai-chat",
      name: "أدوات المحادثة العامة بالذكاء الاصطناعي",
      summary: "أداة المحادثة العامة تكتب لك حين تطلب. نور تعرف علامتك ومنتجاتك ومواسمك، تخطط أسبوعك، تجهّز الدفعات، وتتعلم من تعديلاتك.",
      rows: [
        { dim: "ذاكرة العلامة", them: "تزوّدها بسياق علامتك وتحدّثه بنفسك", us: "ملف علامة ومنتجات وتفضيلات تقرؤها نور في كل مرة" },
        { dim: "التنفيذ", them: "تنسخ وتلصق لكل قناة", us: "دفعات جاهزة لكل قناة في صندوق موافقة واحد" },
        { dim: "المبادرة", them: "تنتظر طلبك", us: "خطة أسبوعية تلقائية وملخص كل صباح" },
        { dim: "المواسم", them: "تعرفها إذا ذكّرتها", us: "تقويم هجري وخليجي مدمج: رمضان، الأعياد، يوم التأسيس، اليوم الوطني" },
        { dim: "الالتزام", them: "على مسؤوليتك", us: "مراجِع ثانٍ لضوابط الإعلان في الصحة والعقار والقانون" },
      ],
      chooseThem: ["تحتاج مساعداً عاماً لكل شيء، لا للتسويق فقط", "تكتب نادراً وتعرف ما تريد"],
      chooseUs: ["تريد خطة كل أسبوع دون أن تطلبها", "تريد لهجة وصوتاً ثابتين في كل قناة", "لديك أكثر من قناة"],
    },
    {
      id: "global-marketing-platforms",
      name: "منصات التسويق العالمية",
      summary: "مساعدات الكتابة وأدوات الجدولة ووكلاء التسويق المبنية للأسواق الغربية قوية في أسواقها. نور مبنية لطريقة البيع في الخليج: اللهجة، والقنوات، والمواسم.",
      rows: [
        { dim: "اللغة", them: "الإنجليزية أولاً في الغالب", us: "عربي بلهجات (سعودي، إماراتي، كويتي) وإنجليزي" },
        { dim: "من يكتب", them: "في أدوات الجدولة: أنت تكتب وهي تنشر", us: "نور تكتب وتخطط، وأنت تعتمد" },
        { dim: "القنوات", them: "مبنية حول القنوات والتكاملات الغربية", us: "نصوص إعلانات لسناب وميتا وتيك توك، ومسودات رسائل واتساب" },
        { dim: "المتجر", them: "تكاملات مع منصات تجارة عالمية", us: "تقرأ منتجاتك من رابط متجرك؛ الربط المباشر مع سلة وزد مخطط له بعد اعتماد التطبيقين" },
        { dim: "التقويم", them: "مواسم البيع الغربية", us: "رمضان، الأعياد، يوم التأسيس، اليوم الوطني، الجمعة البيضاء" },
        { dim: "الدفع", them: "بالدولار في الغالب", us: "بالريال" },
      ],
      chooseThem: ["جمهورك في أمريكا أو أوروبا", "قناتك الأساسية الإيميل", "تحتاج تكاملات غربية كثيرة اليوم", "عندك فريق يكتب ويحتاج جدولة فقط"],
      chooseUs: ["تبيع في السعودية أو الخليج", "عملاؤك على سناب وواتساب", "تريد لهجة لا فصحى مترجمة"],
    },
    {
      id: "agencies",
      name: "وكالات التسويق",
      summary: "الوكالة تعطيك أشخاصاً واجتماعات وإنتاجاً احترافياً. نور تعطيك تنفيذاً يومياً باشتراك شهري. يناسب كثيرين: نور لليومي، والوكالة للحملات الكبرى.",
      rows: [
        { dim: "التكلفة الشهرية", them: "حسب الوكالة والعقد", us: `${P.starter}–${P.business} ريال حسب الخطة` },
        { dim: "التسليم", them: "حسب جدول الوكالة", us: "حين تطلب، في صندوق الموافقة" },
        { dim: "الاستراتيجية", them: "خبرة بشرية", us: "خطة أسبوعية من بياناتك؛ الاستراتيجية الكبرى لك" },
        { dim: "الإنتاج الاحترافي", them: "تصوير وفيديو", us: "لا إنتاج فيديو احترافي" },
        { dim: "التحكم", them: "عبر الاجتماعات والمراجعات", us: "كل عنصر ينتظر موافقتك قبل النشر" },
      ],
      chooseThem: ["حملة إطلاق كبيرة", "تصوير وإنتاج فيديو احترافي", "ميزانية إعلانات كبيرة تحتاج إدارة بشرية"],
      chooseUs: ["تحتاج محتوى كل أسبوع", "ميزانيتك الشهرية محدودة", "تريد أن توافق على كل شيء بنفسك"],
    },
    {
      id: "freelancers",
      name: "المستقلون",
      summary: "المستقل يعطيك حساً بشرياً وعلاقة مباشرة. نور تعطيك تنفيذاً يومياً ثابتاً. كثيرون يجمعون الاثنين: نور لليومي، والمستقل للإبداع والتصوير.",
      rows: [
        { dim: "التوفر", them: "حسب وقته والتزاماته الأخرى", us: "داخل التطبيق كل يوم، متى طلبت" },
        { dim: "معرفة علامتك", them: "يتعلمها مع الوقت، وتبدأ من جديد إذا تغيّر", us: "ملف علامة محفوظ، وتتعلم من كل تعديل ورفض" },
        { dim: "التكلفة", them: "بالساعة أو بالمشروع", us: `اشتراك شهري من ${P.starter} ريال` },
        { dim: "الإبداع والتصوير", them: "حس بشري وتصوير في الموقع", us: "نصوص وخطط؛ لا تصوير" },
        { dim: "المراجعة", them: "تراجع ما يرسله", us: "كل عنصر ينتظر موافقتك" },
      ],
      chooseThem: ["تحتاج شخصاً يصوّر أو يصمّم في الموقع", "مشروع واحد له بداية ونهاية", "تريد علاقة مباشرة مع شخص"],
      chooseUs: ["تحتاج محتوى كل أسبوع", "تريد صوت علامة ثابتاً", "تريد فاتورة شهرية واحدة"],
    },
  ],
  choose: "لا تعتمد على رأينا ولا على رأي غيرنا. اختبر خياراً واحداً على قناة واحدة لمدة أسبوعين، وقِس شيئاً واحداً: كم عنصراً اعتمدته بلا تعديل؟",
  faq: [
    { q: "هل تستبدل نور الوكالة أو المستقل؟", a: "في المحتوى اليومي نعم. في الحملات الكبرى والتصوير والإنتاج: نور بجانبهم." },
    { q: "أين تنشر نور اليوم؟", a: "ترسل ما تعتمده إلى Telegram، أو كمسودة إلى WordPress، حين تربطهما. لا نشر بعد على سناب أو واتساب." },
    { q: "كيف أجرّب؟", a: `تجربة 3 أيام فيها ${PLAN_CREDITS.trial} كريدت، بدون بطاقة.` },
  ],
};

const en: ComparePage = {
  title: "Thakeen compared with the alternatives: AI chat tools, global platforms, agencies and freelancers",
  desc: "A comparison by kind, not by name: when a general AI chat tool, a global marketing platform, an agency or a freelancer is enough, and when Noor from Thakeen fits.",
  intro: "Before Thakeen, you have four common ways to market your business: a general AI chat tool, a global marketing platform, an agency or a freelancer. Each has its place. Here we say where each one is stronger, and where Noor fits.",
  disclosure: "Thakeen builds Noor, so this comparison is our own opinion. We compare kinds, not names; we give no scores and we do not rank the options; and tools within one kind differ, so check the one you have in mind yourself. Found something inaccurate? Email us at hello@thakeen.com.",
  groups: [
    {
      id: "general-ai-chat",
      name: "General AI chat tools",
      summary: "A general AI chat tool writes when you ask. Noor knows your brand, products and seasons, plans your week, prepares batches and learns from your edits.",
      rows: [
        { dim: "Brand memory", them: "You supply and update your brand context yourself", us: "A brand file, products and preferences Noor reads every time" },
        { dim: "Execution", them: "Copy and paste per channel", us: "Ready batches per channel in one approval inbox" },
        { dim: "Initiative", them: "Waits for you to ask", us: "An automatic weekly plan and a morning brief" },
        { dim: "Seasons", them: "Knows them if you remind it", us: "Hijri and Gulf calendar built in: Ramadan, Eids, Founding Day, National Day" },
        { dim: "Compliance", them: "On you", us: "A second reviewer for health, real-estate and legal advertising rules" },
      ],
      chooseThem: ["You need a general assistant for everything, not only marketing", "You write rarely and know what you want"],
      chooseUs: ["You want a weekly plan without asking", "You want a consistent dialect and voice on every channel", "You run more than one channel"],
    },
    {
      id: "global-marketing-platforms",
      name: "Global marketing platforms",
      summary: "Writing assistants, schedulers and marketing agents built for Western markets are strong in those markets. Noor is built for how people sell in the Gulf: dialect, channels and seasons.",
      rows: [
        { dim: "Language", them: "Mostly English first", us: "Arabic dialects (Saudi, Emirati, Kuwaiti) and English" },
        { dim: "Who writes", them: "With schedulers, you write and they publish", us: "Noor writes and plans; you approve" },
        { dim: "Channels", them: "Built around Western channels and integrations", us: "Ad copy for Snapchat, Meta and TikTok, and WhatsApp message drafts" },
        { dim: "Store", them: "Integrations with global commerce platforms", us: "Reads your products from your store link; a direct Salla and Zid link is planned once both apps are approved" },
        { dim: "Calendar", them: "Western retail seasons", us: "Ramadan, Eids, Founding Day, National Day, White Friday" },
        { dim: "Payment", them: "Mostly in USD", us: "In SAR" },
      ],
      chooseThem: ["Your audience is in the US or Europe", "Email is your main channel", "You need many Western integrations today", "You have a team that writes and only needs scheduling"],
      chooseUs: ["You sell in Saudi Arabia or the Gulf", "Your customers are on Snapchat and WhatsApp", "You want dialect, not translated MSA"],
    },
    {
      id: "agencies",
      name: "Marketing agencies",
      summary: "An agency gives you people, meetings and professional production. Noor gives you daily execution on a monthly subscription. For many, the right mix: Noor for daily work, an agency for big campaigns.",
      rows: [
        { dim: "Monthly cost", them: "Depends on the agency and the contract", us: `SAR ${P.starter}–${P.business} by plan` },
        { dim: "Delivery", them: "On the agency's schedule", us: "When you ask, in your approval inbox" },
        { dim: "Strategy", them: "Human expertise", us: "A weekly plan from your data; the big strategy is yours" },
        { dim: "Pro production", them: "Photo and video shoots", us: "No professional video production" },
        { dim: "Control", them: "Through meetings and reviews", us: "Every item waits for your approval before it is published" },
      ],
      chooseThem: ["A big launch campaign", "Professional photo and video production", "A large ad budget that needs human management"],
      chooseUs: ["You need content every week", "Your monthly budget is limited", "You want to approve everything yourself"],
    },
    {
      id: "freelancers",
      name: "Freelancers",
      summary: "A freelancer gives you a human touch and a direct relationship. Noor gives you steady daily execution. Many use both: Noor for daily work, the freelancer for creative work and shoots.",
      rows: [
        { dim: "Availability", them: "Depends on their time and other clients", us: "In the app every day, whenever you ask" },
        { dim: "Knowing your brand", them: "Learns it over time; you start again if they change", us: "A saved brand file, and she learns from every edit and rejection" },
        { dim: "Cost", them: "By the hour or by the project", us: `A monthly subscription from SAR ${P.starter}` },
        { dim: "Creative work and shoots", them: "A human eye and on-site shoots", us: "Copy and plans; no shoots" },
        { dim: "Review", them: "You review what they send", us: "Every item waits for your approval" },
      ],
      chooseThem: ["You need someone to shoot or design on site", "A one-off project with a start and an end", "You want a direct relationship with a person"],
      chooseUs: ["You need content every week", "You want a consistent brand voice", "You want one monthly bill"],
    },
  ],
  choose: "Don't rely on our opinion or anyone else's. Test one option on one channel for two weeks, and measure one thing: how many items did you approve without editing?",
  faq: [
    { q: "Does Noor replace my agency or freelancer?", a: "For daily content, yes. For big campaigns, shoots and production: Noor works alongside them." },
    { q: "Where does Noor publish today?", a: "She sends what you approve to Telegram, or as a draft to WordPress, once you connect them. No Snapchat or WhatsApp publishing yet." },
    { q: "How do I try it?", a: `A 3-day trial with ${PLAN_CREDITS.trial} credits, no card.` },
  ],
};

export const COMPARE_PAGE: Record<Lang, ComparePage> = { ar, en };
