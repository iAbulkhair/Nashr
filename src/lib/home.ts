import type { Lang } from "./i18n";
import type { AgentId } from "./agents";
import type { TaskType } from "./tasks";

/**
 * Copy for the Thakeen homepage. Approved by the founder on 2026-09-28, spec §5
 * (`docs/superpowers/specs/2026-09-28-thakeen-homepage-design.md`), except Reem's, which is a DRAFT (§5.2). Every
 * question below maps to a task type the agent it belongs to really performs (see `src/lib/agents.ts`), or, for Reem,
 * who owns no task type, to the free feature she runs (her to-do list); the homepage never invents a number, a
 * customer or a result promise. Type-only imports on purpose: this module is imported by client components and must
 * not pull in any server-only value (see `tests/client-bundle.test.ts`).
 */

export type L = Record<Lang, string>;

/**
 * A free feature of the app that answers a question when no task type does: `todo` is Reem's list
 * (`src/lib/secretary.ts`, the My to-dos page and the morning brief). `tests/home-copy.test.ts` ties each one to the
 * agent capability that runs it.
 */
export type Feature = "todo";

/** A question the owner asks, backed by exactly one real thing: a task type its agent delivers, or a feature it runs. */
export type Question = { ar: string; en: string } & ({ task: TaskType; feature?: never } | { feature: Feature; task?: never });

/**
 * The agents drawn on the homepage. An explicit subset of `AgentId`: an agent added to the platform joins the homepage
 * only once the founder approves its drawing, value line and questions, so adding an agent never breaks the page or its
 * tests. Reem's are on the page ahead of that approval, marked DRAFT (her colour too) until the founder signs them off
 * (spec §5.2, §10). `Extract` keeps every name here a real agent id.
 */
export type HomeAgentId = Extract<AgentId, "noor" | "sami" | "razan" | "faris" | "dana" | "majed" | "layan" | "reem">;
export type CastId = HomeAgentId | "you";

export type CastMember = { id: CastId; name: L; value: L; color: string; questions: Question[] };

export type AgentMember = CastMember & { id: HomeAgentId };

export const SLOGAN: { line1: L; line2: L } = {
  line1: { ar: "ذكين. الذكي المكين.", en: "Thakeen. Smart. Steadfast." },
  line2: {
    ar: "أسئلة كثيرة تدور في راسك كل يوم… وذكين يحلها.",
    en: "So many questions spin in your head every day… Thakeen solves them.",
  },
};

export const HOME: {
  scroll: L;
  finaleWord: L;
  finaleLine: L;
  cta: L;
  urlPlaceholder: L;
  aiLabel: L;
  motionPause: L;
  motionPlay: L;
  truthsTitle: L;
} = {
  scroll: { ar: "مرّر", en: "Scroll" },
  finaleWord: { ar: "موافق.", en: "Approved." },
  finaleLine: { ar: "هم يشتغلون. وأنت توافق.", en: "They do the work. You approve." },
  cta: { ar: "ابدأ بموقعك", en: "Start with your website" },
  urlPlaceholder: { ar: "رابط موقعك أو متجرك", en: "Your website or store URL" },
  aiLabel: { ar: "وكلاء ذكاء اصطناعي", en: "AI agents" },
  // The lineup's motion toggle (WCAG 2.2.2); the label says what pressing it will do.
  motionPause: { ar: "أوقف الحركة", en: "Pause motion" },
  motionPlay: { ar: "شغّل الحركة", en: "Play motion" },
  truthsTitle: { ar: "الموجود اليوم", en: "What's true today" },
};

export const AGENT_CAST: AgentMember[] = [
  {
    id: "noor",
    name: { ar: "نور", en: "Noor" },
    value: { ar: "محتوى أسبوعك جاهز، بصوت علامتك.", en: "Your week of content, ready, in your voice." },
    color: "var(--color-agent-noor)",
    questions: [
      { ar: "وش أنزّل اليوم؟", en: "What do I post today?", task: "social" },
      { ar: "وش أرسل للعملاء بالواتساب؟", en: "What do I send customers on WhatsApp?", task: "whatsapp" },
      { ar: "كيف أرجّع اللي ترك السلة؟", en: "How do I bring back abandoned carts?", task: "cart_recovery" },
      { ar: "رمضان قرّب… وش نقول؟", en: "Ramadan is close… what do we say?", task: "weekly_plan" },
      { ar: "إعلان سناب ولا تيك توك؟", en: "Snapchat ad or TikTok?", task: "ads" },
      { ar: "وش أكتب في قوقل ماب؟", en: "What do I write on Google Maps?", task: "gbp" },
    ],
  },
  {
    id: "sami",
    name: { ar: "سامي", en: "Sami" },
    value: { ar: "رد جاهز لكل عميل، ومتابعة ما تنسى أحد.", en: "A reply for every lead, a follow-up that forgets no one." },
    color: "var(--color-agent-sami)",
    questions: [
      { ar: "كيف أرد على هالعميل؟", en: "How do I answer this customer?", task: "sales_script" },
      { ar: "هذا جاد ولا يسأل وبس؟", en: "Serious buyer or just asking?", task: "lead_qualifier" },
      { ar: "كم مرة أتابعه بدون ما أزعجه؟", en: "How often can I follow up without annoying them?", task: "followup_seq" },
      { ar: "وش أقول لما يقول: غالي؟", en: 'What do I say when they say "too expensive"?', task: "sales_script" },
      { ar: "وش أكتب في العرض؟", en: "What goes in the proposal?", task: "sales_script" },
    ],
  },
  {
    id: "razan",
    name: { ar: "رزان", en: "Razan" },
    value: { ar: "أرقامك واضحة قبل ما تصرف.", en: "Your numbers, clear before you spend." },
    color: "var(--color-agent-razan)",
    questions: [
      { ar: "يستاهل الصرف؟", en: "Is it worth the spend?", task: "unit_economics" },
      { ar: "سعري صح؟", en: "Is my price right?", task: "pricing_review" },
      { ar: "كم يكلفني العميل الواحد؟", en: "What does one customer cost me?", task: "unit_economics" },
      { ar: "الكاش يكفي لآخر الشهر؟", en: "Will cash last to the end of the month?", task: "cash_forecast" },
      { ar: "هالخصم يربّح ولا يخسّر؟", en: "Does this discount make or lose money?", task: "pricing_review" },
    ],
  },
  {
    id: "faris",
    name: { ar: "فارس", en: "Faris" },
    value: { ar: "خطة نمو ٩٠ يوم، وتجارب صغيرة قبل الصرف الكبير.", en: "A 90-day growth plan, small tests before big spending." },
    color: "var(--color-agent-faris)",
    questions: [
      { ar: "وين نكبر بعدها؟", en: "Where do we grow next?", task: "gtm_plan" },
      { ar: "نفتح سوق جديد؟", en: "Do we open a new market?", task: "gtm_plan" },
      { ar: "أي قناة تستاهل؟", en: "Which channel is worth it?", task: "growth_experiments" },
      { ar: "وش نجرّب هالأسبوع؟", en: "What do we test this week?", task: "growth_experiments" },
      { ar: "كيف العميل يجيب عميل؟", en: "How does one customer bring another?", task: "retention_play" },
      { ar: "العيد جاي… وش خطتنا؟", en: "Eid is coming… what's our plan?", task: "gtm_plan" },
    ],
  },
  {
    id: "dana",
    name: { ar: "دانة", en: "Dana" },
    value: { ar: "تقرير أسبوعك من أرقامك، بدون تجميل.", en: "Your weekly report, from your numbers, no makeup." },
    color: "var(--color-agent-dana)",
    questions: [
      { ar: "طيب… نفع ولا لا؟", en: "So… did it work?", task: "weekly_report" },
      { ar: "وش صار هالأسبوع؟", en: "What happened this week?", task: "weekly_report" },
      { ar: "أي رقم أراقب؟", en: "Which number do I watch?", task: "dashboard_spec" },
      { ar: "وش أعرض على الشريك؟", en: "What do I show my partner?", task: "board_deck" },
    ],
  },
  {
    id: "majed",
    name: { ar: "ماجد", en: "Majed" },
    value: { ar: "قرار واضح، في صفحة وحدة.", en: "A clear decision, on one page." },
    color: "var(--color-agent-majed)",
    questions: [
      { ar: "وش القرار؟", en: "What's the call?", task: "decision_memo" },
      { ar: "وش أولوياتي هالربع؟", en: "What are my priorities this quarter?", task: "okrs" },
      { ar: "أوظّف ولا أنتظر؟", en: "Hire now or wait?", task: "decision_memo" },
      { ar: "نكمل ولا نوقف؟", en: "Keep going or stop?", task: "strategy_review" },
      { ar: "وش الأهم هالأسبوع؟", en: "What matters most this week?", task: "strategy_review" },
    ],
  },
  {
    id: "layan",
    name: { ar: "ليان", en: "Layan" },
    value: { ar: "تعرف وش يبي عميلك، وليش يرجع.", en: "Know what your customer wants, and why they come back." },
    color: "var(--color-agent-layan)",
    questions: [
      { ar: "ليش ما رجع العميل؟", en: "Why didn't the customer come back?", task: "feedback_synthesis" },
      { ar: "وش يقولون عنا؟", en: "What are people saying about us?", task: "feedback_synthesis" },
      { ar: "وش نطلق بعدها؟", en: "What do we launch next?", task: "roadmap" },
      { ar: "كيف أول تجربة تصير أحلى؟", en: "How do we make the first experience better?", task: "onboarding_flow" },
      { ar: "وش الميزة اللي يطلبونها؟", en: "Which feature are they asking for?", task: "prd" },
    ],
  },
  // DRAFT, pending the founder's approval (spec §5.2): Reem's colour, value line and questions. She owns no task type;
  // every question is one her free to-do list answers (today's and overdue items on My to-dos and in the morning brief).
  {
    id: "reem",
    name: { ar: "ريم", en: "Reem" },
    value: { ar: "مهامك ومواعيدك ومتابعاتك، في قائمة وحدة.", en: "Your to-dos, dates and follow-ups, in one list." },
    color: "var(--color-agent-reem)",
    questions: [
      { ar: "وش عليّ اليوم؟", en: "What's on me today?", feature: "todo" },
      { ar: "مين ما رد علي للحين؟", en: "Who still hasn't got back to me?", feature: "todo" },
      { ar: "وش المتأخر عندي؟", en: "What's overdue?", feature: "todo" },
      { ar: "متى أكلم المورّد؟", en: "When do I call the supplier?", feature: "todo" },
      { ar: "كيف ما أنسى أتابع العميل؟", en: "How do I not forget to follow up with the customer?", feature: "todo" },
    ],
  },
];

export const CAST: CastMember[] = [
  ...AGENT_CAST,
  {
    id: "you",
    name: { ar: "أنت", en: "You" },
    value: { ar: "أنت توافق.", en: "You approve." },
    color: "var(--color-agent-you)",
    questions: [],
  },
];

export const STORM: Question[] = AGENT_CAST.flatMap((a) => a.questions);

export type Banter = { lines: { who: HomeAgentId; text: L }[]; rule: string };

export const BANTER: Banter[] = [
  {
    lines: [
      { who: "faris", text: { ar: "نفتح سوق الكويت؟", en: "Open Kuwait?" } },
      { who: "razan", text: { ar: "نفتحه… بعد ما أزنها.", en: "We will… once I've weighed it." } },
    ],
    rule: "finance checks growth",
  },
  {
    lines: [
      { who: "noor", text: { ar: "لقيت ترند!", en: "Found a trend!" } },
      { who: "dana", text: { ar: "كم وصل؟", en: "How big?" } },
      { who: "noor", text: { ar: "…بدأ أمس.", en: "…it started yesterday." } },
      { who: "dana", text: { ar: "أجل ما نكتب رقم.", en: "Then we don't write a number." } },
    ],
    rule: "no invented numbers",
  },
  {
    lines: [
      { who: "layan", text: { ar: "ثلاث عملاء قالوا نفس الملاحظة.", en: "Three customers said the same thing." } },
      { who: "noor", text: { ar: "أجل هذا بوست الأسبوع.", en: "Then that's this week's post." } },
    ],
    rule: "shared memory across agents",
  },
  {
    lines: [
      { who: "sami", text: { ar: "العميل يسأل عن الخصم.", en: "The customer wants a discount." } },
      { who: "majed", text: { ar: "هذي ما نحسمها. صاحب الشغل يوافق.", en: "Not ours to decide. The owner approves." } },
    ],
    rule: "owner approval",
  },
];

/*
 * Prototype D's homepage (re-skin spec §4), copy verbatim from D in both languages except where it is untrue today:
 * step 7, its aside and the data answer name the store and ad connections only as not yet live
 * (`src/lib/integrations.ts` marks them "soon"). D's prototype notes and its start panel are left out (spec §8 C).
 */

/** The cover: issue stamp, the masthead's second line beside the wordmark, the offer and the lineup's hints. */
export const HERO: { issue: L; tbox: L; offer: L; offerSwash: L; hintMouse: L; hintTouch: L; mecap: L } = {
  issue: { ar: "العدد الأول", en: "Issue No. 1" },
  tbox: { ar: "الذكي المكين.", en: "Smart. Steadfast." },
  offer: { ar: "ثمانية وكلاء يعرفون علامتك.", en: "Eight agents who know your brand." },
  offerSwash: { ar: "هم يشتغلون، وأنت توافق.", en: "They do the work, you approve." },
  hintMouse: { ar: "مرّر الماوس على أي واحد منهم، وشوف وش يدور في باله.", en: "Hover over any of them and see what’s on their mind." },
  hintTouch: { ar: "المس أي واحد منهم، وشوف وش يدور في باله.", en: "Tap any of them and see what’s on their mind." },
  mecap: { ar: "…وهذا أنت. عليك كلمة وحدة.", en: "…and this is you. You have one word to say." },
};

/** The homepage's own nav: an anchor to each section, in page order, with D's labels. */
export const HOME_NAV: { href: string; label: L }[] = [
  { href: "#team", label: { ar: "الفريق", en: "Team" } },
  { href: "#rules", label: { ar: "القوانين", en: "Rules" } },
  { href: "#day", label: { ar: "يومك", en: "Your day" } },
  { href: "#steps", label: { ar: "كيف يعمل ذكين", en: "How Thakeen works" } },
  { href: "#price", label: { ar: "الخطط", en: "Plans" } },
  { href: "#faq", label: { ar: "أسئلة", en: "Questions" } },
];

/** The prefix a rule's caption reads with. */
export const RULE_LABEL: L = { ar: "القانون: ", en: "Rule: " };

/**
 * The plans section's own words. Prices, credits, seats and features come from the dictionary's pricing block, which is
 * built from `src/lib/pricing.ts` (rule 248).
 */
export const PLANS: { h: L; tape: L; rule: L; aside: { who: HomeAgentId; text: L } } = {
  h: { ar: "الخطط.", en: "Plans." },
  tape: { ar: "نقترح تبدأ هنا", en: "Start here" },
  rule: { ar: "وفي كل خطة نفس القاعدة: ما ينتشر شي بدون موافقتك.", en: "Every plan has the same rule: nothing goes out without your approval." },
  aside: { who: "razan", text: { ar: "قبل ما تصرف… خلّني أحسبها.", en: "Before you spend… let me run the numbers." } },
};

/** Step seven has no speaker; its connector drawing carries this label instead. */
export const STEP7_LINK: L = { ar: "الربط", en: "Connections" };

/** Section headings and their one-line subtitles, in page order. */
export const SECTIONS: Record<"rules" | "day" | "steps" | "faq", { h: L; sub?: L }> = {
  rules: {
    h: { ar: "قوانين الفريق.", en: "Team rules." },
    sub: { ar: "أربع سوالف قصيرة. كل وحدة تثبت قانون يمشون عليه.", en: "Four quick chats. Each one shows a rule the team works by." },
  },
  day: {
    h: { ar: "يومك.", en: "Your day." },
    sub: { ar: "أربع لوحات: من أول سؤال، لين كلمة وحدة.", en: "Four panels: from the first question to one word." },
  },
  steps: {
    h: { ar: "وش يصير بعد ما تلصق الرابط؟", en: "What happens after you paste the link?" },
    sub: { ar: "سبع خطوات. ثنتين منها بيدك: كلماتك، وموافقتك.", en: "Seven steps. Two of them are in your hands: your words and your approval." },
  },
  faq: { h: { ar: "أسئلة قبل ما تبدأ", en: "Questions before you start" } },
};

/** The team rules: each banter exchange above, with the rule it proves. */
const LAWS: L[] = [
  { ar: "تجارب صغيرة قبل الصرف الكبير.", en: "Small tests before big spending." },
  { ar: "الرقم اللي ما نعرفه، ما نألّفه.", en: "If we don’t know a number, we don’t make one up." },
  { ar: "الكل يشتغل من نفس ملف علامتك.", en: "Everyone works from the same brand file." },
  { ar: "القرار لك. كل شي ينتظر موافقتك.", en: "The call is yours. Everything waits for your approval." },
];
export const RULES: { law: L; lines: Banter["lines"] }[] = BANTER.map((b, i) => ({ law: LAWS[i], lines: b.lines }));

const firstQuestion = (id: HomeAgentId): Question => AGENT_CAST.find((a) => a.id === id)!.questions[0];

/**
 * The day, four panels. The morning's clouds are the first question of each agent named (no new copy); panel three
 * shows every agent's first question with its owner, so it carries only its caption.
 */
export const DAY: {
  morning: { cap: L; clouds: Question[]; note: L; msg: L; hands: L };
  peek: { cap: L; hi: L; ask: L; team: L; look: L; who: L };
  owners: { cap: L };
  word: { cap: L; stamp: L; end: L };
} = {
  morning: {
    cap: { ar: "٧:٥٨ الصبح.", en: "7:58 a.m." },
    clouds: [firstQuestion("noor"), firstQuestion("razan"), firstQuestion("layan")],
    note: { ar: "رسالة جديدة", en: "New message" },
    msg: { ar: "«كم السعر؟»", en: "“How much?”" },
    hands: { ar: "صاحب الشغل ماسك راسه", en: "The business owner, head in hands" },
  },
  peek: {
    cap: { ar: "بعدها بشوي… ثمانية يطلّون.", en: "A little later… eight faces pop up." },
    hi: { ar: "صباح الخير.", en: "Good morning." },
    ask: { ar: "…مين أنتم؟", en: "…who are you?" },
    team: { ar: "فريقك.", en: "Your team." },
    look: { ar: "صاحب الشغل يرفع راسه", en: "The business owner looks up" },
    /** Who says «صباح الخير» and «فريقك», for screen readers (D's hidden speaker label). */
    who: { ar: "الفريق", en: "The team" },
  },
  owners: { cap: { ar: "كل سؤال له صاحب.", en: "Every question has an owner." } },
  word: { cap: { ar: "وأنت؟ عليك كلمة وحدة.", en: "And you? Just one word." }, stamp: HOME.finaleWord, end: HOME.finaleLine },
};

/**
 * The seven steps after the link, explained only (spec §4: no live demo). `aside` is the line its speaker says;
 * `paused` is D's "today" note for a step the model runs, shown only while the model is paused (`CLAUDE_PAUSED` in
 * `src/lib/model.ts`), so the page stays true when it is turned back on.
 */
export const STEPS: { title: L; body: L; aside: L; who?: CastId; paused?: L }[] = [
  {
    title: { ar: "براندك", en: "Your brand" },
    body: {
      ar: "الصق رابط موقعك أو متجرك أو إنستقرامك. نور تقراه وتجهّز لك ملف علامتك، وأنت تراجعه وتعدّله.",
      en: "Paste your website, store or Instagram link. Noor reads it and prepares your brand file, and you review and edit it.",
    },
    aside: { ar: "واللي أخمّنه، أكتب جنبه: تخمين.", en: "If I’m guessing, I write “guess” next to it." },
    who: "noor",
    paused: { ar: "اليوم: القراءة التلقائية متوقفة. تقدر تعبّي ملفك بنفسك.", en: "Today: automatic reading is paused. You can fill in your file yourself." },
  },
  {
    title: { ar: "كلماتك", en: "Your words" },
    body: {
      ar: "الكلمات اللي تمنعها نطبّقها في الكود. المسودة اللي فيها وحدة منها ما تنقبل ولا تنتشر لين تعدّلها.",
      en: "The words you ban are enforced in code. A draft that contains one can’t be approved or published until you edit it.",
    },
    aside: { ar: "الكلمة اللي ما أبيها، ما تمرّ.", en: "A word I don’t want doesn’t get through." },
    who: "you",
  },
  {
    title: { ar: "خطة", en: "Plan" },
    body: {
      ar: "كل أحد الصبح تكتب نور خطة أسبوعك على مواسم الخليج، وتنتظرك في صندوقك. وفارس وماجد يكتبون خطة ٩٠ يوم لما تطلب.",
      en: "Every Sunday morning Noor writes your week’s plan around Gulf seasons, and it waits in your inbox. Faris and Majed write a 90-day plan when you ask.",
    },
    aside: { ar: "كل أحد الصبح، خطة أسبوعك تنتظرك.", en: "Every Sunday morning, your week’s plan is waiting." },
    who: "noor",
    paused: { ar: "اليوم: الخطة الأسبوعية متوقفة مؤقتاً.", en: "Today: the weekly plan is paused." },
  },
  {
    title: { ar: "مسودة", en: "Draft" },
    body: {
      ar: "مسودات بلهجتك من ملف علامتك. مراجع ثاني يشيك على كل وحدة، وكلها تنتظرك.",
      en: "Drafts in your dialect, from your brand file. A second reviewer checks each one, and they all wait for you.",
    },
    aside: { ar: "الرقم اللي ما نعرفه، ما نألّفه.", en: "If we don’t know a number, we don’t make one up." },
    who: "noor",
    paused: { ar: "اليوم: كتابة المسودات متوقفة مؤقتاً.", en: "Today: draft writing is paused." },
  },
  {
    title: { ar: "موافقتك", en: "Your approval" },
    body: {
      ar: "وافق، أو عدّل، أو ارفض وقل السبب. النشر زر ثاني تضغطه أنت، وما فيه شي ينتشر على جدول.",
      en: "Approve, edit, or reject and say why. Publishing is a separate button you press, and nothing goes out on a schedule.",
    },
    aside: { ar: "هذي ما نحسمها. أنت توافق.", en: "That’s not ours to decide. You approve." },
    who: "majed",
    paused: {
      ar: "والموافقة التلقائية مطفّاة، وما يشغّلها إلا أنت. اليوم: شغّالة، بس ما فيه مسودات جديدة لين ترجع الكتابة.",
      en: "Auto-approval is off, and only you can turn it on. Today: working, but there are no new drafts until writing is back.",
    },
  },
  {
    title: { ar: "تحليل", en: "Analysis" },
    body: {
      ar: "نقارن إعلاناتك ببعض من نتايجك أنت، ونوريك العينة ورا كل نتيجة. واللي نفع يدخل في المسودات الجاية.",
      en: "We compare your ads with each other using your own results, and show you the sample size behind each result. What worked goes into the next drafts.",
    },
    aside: { ar: "واللي دليله ضعيف، نقول لك إنه ضعيف.", en: "And when the evidence is weak, we tell you it’s weak." },
    who: "dana",
    paused: { ar: "اليوم: المقارنة شغّالة. تقرير دانة المكتوب متوقف مؤقتاً.", en: "Today: the comparison works. Dana’s written report is paused." },
  },
  {
    title: { ar: "قياس", en: "Measurement" },
    body: {
      ar: "نقيس من اللي تربطه: ملف CSV اليوم، ونتايج إعلانات ميتا وسناب ومبيعات سلة وشوبيفاي وزد لما ينطلق ربطها قريب.",
      en: "We measure from what you connect: a CSV file today, and Meta and Snapchat ad results and Salla, Shopify and Zid sales once those connections launch (coming soon).",
    },
    aside: { ar: "حساب إعلاناتك، لما تربطه، نقراه بس وما نعدّل فيه.", en: "Once you connect your ad account, we only read it. We never change anything in it." },
  },
];

export const HOME_FAQ: { q: L; a: L }[] = [
  {
    q: { ar: "ينشر شي بدون موافقتي؟", en: "Does anything get published without my approval?" },
    a: {
      ar: "لا. كل مسودة تنتظر موافقتك. والموافقة التلقائية مطفّاة من البداية، وما يشغّلها لأنواع محددة إلا أنت.",
      en: "No. Every draft waits for your approval. Auto-approval is off from the start, and only you can turn it on, for the types you choose.",
    },
  },
  {
    q: { ar: "وافقت… ينتشر على طول؟", en: "I approved… does it go out right away?" },
    a: {
      ar: "لا. النشر زر ثاني تضغطه أنت، عن طريق التكاملات اللي ربطتها. وما فيه نشر على جدول.",
      en: "No. Publishing is a separate button you press, through the integrations you connected. And there is no scheduled publishing.",
    },
  },
  {
    q: { ar: "وش تسوون ببياناتي؟", en: "What do you do with my data?" },
    a: {
      ar: "بياناتك لمساحة عملك بس، وما تنشارك بين الحسابات. لما تربط حساب إعلاناتك نقراه وما نعدّل فيه، ولما تربط متجرك ناخذ المجاميع بدون بيانات المتسوقين. وتحذف حسابك وبياناتك بنفسك من صفحة «حسابك».",
      en: "Your data stays in your workspace and is never shared between accounts. Once you connect your ad account we read it and don’t change it, and once you connect your store we take totals without shopper data. You can delete your account and data yourself from the “Your account” page.",
    },
  },
];

export const TRUTHS: { title: L; body: L }[] = [
  {
    title: { ar: "يبدأ من موقعك", en: "It starts from your website" },
    body: {
      ar: "تلصق الرابط، وتطلع لك ملفات علامتك وفرصها واستراتيجيتها.",
      en: "Paste the URL and get your brand file, guidelines, opportunities, market research and a strategy.",
    },
  },
  {
    title: { ar: "كل شي ينتظر موافقتك", en: "Everything waits for your yes" },
    body: {
      ar: "كل مسودة تنتظر موافقتك، والنشر قرارك دائماً.",
      en: "Drafts sit in Approvals. Publishing is always your call.",
    },
  },
  {
    title: { ar: "يشتغل على جدول", en: "It runs on a schedule" },
    body: {
      ar: "خطة أسبوعية صباح كل أحد، وموجز يومي الساعة ٨ الصبح.",
      en: "A weekly plan every Sunday morning and a brief every day at 08:00.",
    },
  },
  {
    title: { ar: "مصنوع للخليج", en: "Made for the Gulf" },
    body: {
      ar: "عربي أولاً، بمواسم الخليج وقنواته.",
      en: "Arabic first, Gulf seasons, and the channels people here use.",
    },
  },
];

/**
 * How a person in a scene is drawn (`src/components/home/Person.tsx`): what covers the head, the beard, glasses, the
 * eyes and the colour of the clothing. Every face smiles.
 */
export type Look = {
  head: "shayla" | "ghutra" | "shemagh" | "hair" | "curls";
  beard?: "short" | "full";
  glasses?: true;
  /** Laughing eyes (closed arcs) or open dots. */
  eyes: "laugh" | "dot";
  /** A colour token: the shayla and clothing, the shemagh, or the shirt. */
  tone: "noor" | "sami" | "razan" | "faris" | "dana" | "majed" | "layan" | "reem";
};

/** What the line is: something the person likes, a habit they recommend, or a suggestion. */
export type SceneKind = "like" | "tip" | "idea";

/**
 * One scene under the cover (rule 775): an illustrative person, never a named customer, saying how they work with one
 * agent. Each line is backed like a question: a task type that agent really performs, or a feature it really runs
 * (`tests/home-copy.test.ts`). No digits, no result promises.
 */
export type Scene = { role: L; line: L; kind: SceneKind; agent: HomeAgentId; look: Look } & ({ task: TaskType; feature?: never } | { feature: Feature; task?: never });

export const SCENES_COPY: { h: L; sub: L; kinds: Record<SceneKind, L>; with: L; prev: L; next: L; slide: L; pause: L; play: L } = {
  // Rule 926: the line under the heading marks the scenes as illustrative examples in both languages. The Arabic heading
  // «عملاء جربوا ذكين.» is kept by founder decision 2026-10-11. Rule 775: the scenes stay role-only illustrations, not
  // reviews: no names, no digits.
  h: { ar: "عملاء جربوا ذكين.", en: "How owners work with Thakeen." },
  sub: { ar: "أمثلة توضيحية: وش عجبهم، وش تعلّموا، ووش ينصحون غيرهم فيه.", en: "Illustrative examples: what they like, what they learned, and what they recommend." },
  kinds: {
    like: { ar: "يعجبني", en: "What I like" },
    tip: { ar: "نصيحة", en: "Tip" },
    idea: { ar: "اقتراح", en: "Suggestion" },
  },
  with: { ar: "مع", en: "with" },
  prev: { ar: "السابق", en: "Previous" },
  next: { ar: "التالي", en: "Next" },
  slide: { ar: "مجموعة", en: "Set" },
  // The slider moves by itself; this button's label says what pressing it does.
  pause: { ar: "أوقف التمرير التلقائي", en: "Pause auto-slide" },
  play: { ar: "شغّل التمرير التلقائي", en: "Play auto-slide" },
};

export const SCENES: Scene[] = [
  {
    role: { ar: "صاحبة متجر عطور", en: "Perfume shop owner" },
    line: { ar: "خلّيت نور تكتب لي منشورات الأسبوع بصوت متجري، وأنا عدّلت عليها بس واعتمدت المحتوى.", en: "I had Noor write my week of posts in my shop's voice. I only tweaked them and approved." },
    kind: "like", agent: "noor", task: "social",
    look: { head: "shayla", eyes: "laugh", tone: "noor" },
  },
  {
    role: { ar: "صاحب مقهى", en: "Café owner" },
    line: { ar: "قبل ما أغيّر سعر القهوة، رزان أعطتني التكلفة الصح، وصرت أشوف الربح بعيني.", en: "Before I changed the coffee price, Razan gave me the real cost, and I could see the margin myself." },
    kind: "like", agent: "razan", task: "pricing_review",
    look: { head: "ghutra", beard: "full", eyes: "laugh", tone: "razan" },
  },
  {
    role: { ar: "مصممة عبايات", en: "Abaya designer" },
    line: { ar: "ليان جمعت تعليقات العميلات في صفحة، وعرفت وش يبون في التشكيلة الجاية.", en: "Layan gathered my customers' comments on one page, and I knew what they want next season." },
    kind: "like", agent: "layan", task: "feedback_synthesis",
    look: { head: "shayla", glasses: true, eyes: "dot", tone: "sami" },
  },
  {
    role: { ar: "وسيط عقاري", en: "Real-estate broker" },
    line: { ar: "خلّيت سامي يتابع العملاء معي من أول يوم، وصار كل عميل يوصله رد في وقته.", en: "I had Sami follow up with customers alongside me from day one, so every customer hears back on time." },
    kind: "like", agent: "sami", task: "followup_seq",
    look: { head: "shemagh", beard: "short", eyes: "laugh", tone: "sami" },
  },
  {
    role: { ar: "صاحبة مخبز", en: "Bakery owner" },
    line: { ar: "نور جهّزت لي رسالة الواتساب للعملاء كل خميس، وأنا أراجعها وأرسلها.", en: "Noor gets my WhatsApp message to customers ready every Thursday. I review it and send it." },
    kind: "like", agent: "noor", task: "whatsapp",
    look: { head: "shayla", eyes: "dot", tone: "reem" },
  },
  {
    role: { ar: "مدرب لياقة", en: "Fitness coach" },
    line: { ar: "فارس ساعدني أجرّب السوق بأفكار صغيرة، وصار يعطيني تجربة وحدة كل أسبوع.", en: "Faris helped me test the market with small ideas, and now he gives me one test a week." },
    kind: "like", agent: "faris", task: "growth_experiments",
    look: { head: "hair", eyes: "laugh", tone: "layan" },
  },
  {
    role: { ar: "صاحبة متجر إلكتروني", en: "Online store owner" },
    line: { ar: "أحب إن رسائل السلة المتروكة من نور صارت بلهجتنا وبهوية متجري. كفو يا نور!", en: "I love that Noor's abandoned-cart messages sound like us and carry my shop's identity. Well done, Noor!" },
    kind: "like", agent: "noor", task: "cart_recovery",
    look: { head: "shayla", eyes: "laugh", tone: "razan" },
  },
  {
    role: { ar: "مدير مطعم", en: "Restaurant manager" },
    line: { ar: "دانة تجمع لي أرقام الأسبوع في تقرير واحد، بدل ما أدوّر عليها كل يوم.", en: "Dana pulls the week's numbers into one report for me, instead of me hunting for them every day." },
    kind: "like", agent: "dana", task: "weekly_report",
    look: { head: "ghutra", beard: "full", glasses: true, eyes: "dot", tone: "dana" },
  },
  {
    role: { ar: "صاحبة محل ورد", en: "Flower shop owner" },
    line: { ar: "ريم تحط مهامي ومتابعات الفريق في قائمة وحدة. أفتحها الصبح وأعرف وش عليّ ووش ينتظرني.", en: "Reem keeps my tasks and my team's follow-ups in one list. I open it in the morning and know what's on me and what's waiting." },
    kind: "like", agent: "reem", feature: "todo",
    look: { head: "shayla", eyes: "laugh", tone: "layan" },
  },
  {
    role: { ar: "مسوّقة عيادة", en: "Clinic marketer" },
    line: { ar: "أحدّث صفحة قوقل ماب مع كل عرض. نور تكتب النص، وأنا أنسخه.", en: "I update my Google Maps page with every offer. Noor writes the text, I paste it." },
    kind: "tip", agent: "noor", task: "gbp",
    look: { head: "shayla", glasses: true, eyes: "laugh", tone: "faris" },
  },
  {
    role: { ar: "صاحب مغسلة سيارات", en: "Car wash owner" },
    line: { ar: "مع رزان صرت أعرف من أول الشهر إذا الكاش يكفي، قبل ما أتفاجأ.", en: "With Razan, I know at the start of the month whether cash will last, before it surprises me." },
    kind: "like", agent: "razan", task: "cash_forecast",
    look: { head: "hair", beard: "short", eyes: "dot", tone: "razan" },
  },
  {
    role: { ar: "صاحب محل خياطة", en: "Tailor shop owner" },
    line: { ar: "لما العميل يقول «غالي»، سامي عنده رد محترم ما يكسر السعر ويخلّي الباب مفتوح.", en: "When a customer says “too expensive”, Sami has a polite answer that keeps the price and keeps the door open." },
    kind: "like", agent: "sami", task: "sales_script",
    look: { head: "shemagh", beard: "full", eyes: "laugh", tone: "sami" },
  },
  {
    role: { ar: "مؤسسة محمصة قهوة", en: "Coffee roastery founder" },
    line: { ar: "كنت محتارة أفتح فرع ولا لا. ماجد حطّ لي الخطة في صفحة وحدة، وقررت.", en: "I couldn't decide on a new branch. Majed put the plan on one page for me, and I made the call." },
    kind: "like", agent: "majed", task: "decision_memo",
    look: { head: "shayla", eyes: "dot", tone: "majed" },
  },
  {
    role: { ar: "صاحبة علامة عناية بالبشرة", en: "Skincare brand owner" },
    line: { ar: "اكتب فكرتك مرة وحدة واضحة لنور، وهي تفصّلها لإعلان سناب وتيك توك.", en: "Give Noor your idea once, clearly, and she shapes it into Snapchat and TikTok ads." },
    kind: "idea", agent: "noor", task: "ads",
    look: { head: "shayla", eyes: "laugh", tone: "sami" },
  },
  {
    role: { ar: "صاحب مركز تدريب", en: "Training center owner" },
    line: { ar: "خطة النمو من فارس مقسومة أسابيع، وكل أسبوع أعرف وش أسوي.", en: "Faris's growth plan is split into weeks, so every week I know what to do." },
    kind: "like", agent: "faris", task: "gtm_plan",
    look: { head: "ghutra", beard: "short", glasses: true, eyes: "laugh", tone: "faris" },
  },
  {
    role: { ar: "صاحبة متجر هدايا يدوية", en: "Handmade gifts seller" },
    line: { ar: "سألت ليان عن أول تجربة وانطباع لعميلنا، وبعدها غيّرنا رسالة الترحيب.", en: "I asked Layan about our customer's first experience and impression, then we rewrote our welcome message." },
    kind: "like", agent: "layan", task: "onboarding_flow",
    look: { head: "shayla", glasses: true, eyes: "dot", tone: "noor" },
  },
  {
    role: { ar: "صاحب مغسلة ملابس", en: "Laundry owner" },
    line: { ar: "دانة قالت لي أي رقم أراقب في الحملات، وتجاهلت الباقي. ارتحت.", en: "Dana told me which number to watch in my campaigns, and I ignored the rest. What a relief." },
    kind: "like", agent: "dana", task: "dashboard_spec",
    look: { head: "curls", eyes: "laugh", tone: "reem" },
  },
  {
    role: { ar: "منظمة مناسبات", en: "Events planner" },
    line: { ar: "كل ما وعدت أحد بشي، اكتبه في قائمة ريم على طول، لا تخليه في راسك.", en: "Whenever you promise someone something, put it on Reem's list right away, not in your head." },
    kind: "tip", agent: "reem", feature: "todo",
    look: { head: "shayla", eyes: "laugh", tone: "dana" },
  },
  {
    role: { ar: "شريك في محل حلويات", en: "Sweets shop partner" },
    line: { ar: "قبل اجتماع الإدارة، دانة تجهّز لي وش أعرض عليهم.", en: "Before the management meeting, Dana prepares what I'll present to them." },
    kind: "like", agent: "dana", task: "board_deck",
    look: { head: "ghutra", beard: "full", eyes: "laugh", tone: "noor" },
  },
  {
    role: { ar: "صاحب استوديو تصوير", en: "Photo studio owner" },
    line: { ar: "سامي يفرز لي مين جاد ومين يسأل وبس، فأرد على الجاد أول.", en: "Sami sorts who's serious from who's just asking, so I answer the serious ones first." },
    kind: "like", agent: "sami", task: "lead_qualifier",
    look: { head: "hair", glasses: true, eyes: "dot", tone: "faris" },
  },
  {
    role: { ar: "صاحبة متجر أزياء", en: "Fashion store owner" },
    line: { ar: "اختر أولويات قليلة حسب الخطة اللي سويتها مع ماجد، وقل لا لأي شي ثاني.", en: "Pick a few priorities from the plan you made with Majed, and say no to anything else." },
    kind: "tip", agent: "majed", task: "okrs",
    look: { head: "shayla", eyes: "laugh", tone: "majed" },
  },
  {
    role: { ar: "بائع عسل", en: "Honey seller" },
    line: { ar: "رزان حسبت كم يكلفني العميل الواحد، وعرفت أي إعلان أوقّف.", en: "Razan worked out what one customer costs me, and I knew which ad to stop." },
    kind: "like", agent: "razan", task: "unit_economics",
    look: { head: "shemagh", beard: "short", eyes: "dot", tone: "sami" },
  },
  {
    role: { ar: "صاحبة صالون", en: "Salon owner" },
    line: { ar: "أحلى عادة: كل سبت أوافق على خطة نور للأسبوع، وبعدها أركّز على صالوني.", en: "Best habit: every Saturday I approve Noor's plan for the week, then I focus on my salon." },
    kind: "tip", agent: "noor", task: "weekly_plan",
    look: { head: "shayla", glasses: true, eyes: "laugh", tone: "razan" },
  },
  {
    role: { ar: "مؤسس تطبيق", en: "App founder" },
    line: { ar: "خلّيت ليان تكتب وش يطلب العملاء قبل ما أبرمج أي ميزة.", en: "I had Layan write up what customers ask for before I built any feature." },
    kind: "like", agent: "layan", task: "prd",
    look: { head: "hair", beard: "short", eyes: "laugh", tone: "dana" },
  },
];
