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
