/**
 * The home page's live UI gallery (UI/UX phase 5b, rules 1220-1229): its copy and the sample data its screens show, in
 * Arabic and English. The screens are the app's own components (the chat bubble, the approval card, the starter plan);
 * the data here is made up for an imaginary coffee roastery with no name, and every panel says so on screen.
 *
 * This file is separate from `src/lib/home.ts` on purpose: the scenes' heading and its line belong to that file (release
 * R1, PR #322) and the gallery never edits them. Nothing here names a customer, a logo, a quote, a number or a result,
 * and nothing names the model or its maker (tests/uiux-phase5b.test.ts).
 */
import type { ChatItem, PlanItem } from "@/lib/chat";
import type { TaskType } from "@/lib/tasks";

type L = { ar: string; en: string };
type Lang = keyof L;

/** The gallery's three screens, in tab order. */
export const GALLERY_TABS = ["chat", "plan", "inbox"] as const;
export type GalleryTab = (typeof GALLERY_TABS)[number];

export const GALLERY_COPY: {
  h: L;
  sub: L;
  label: L;
  note: L;
  tabsLabel: L;
  tabs: Record<GalleryTab, { label: L; cap: L }>;
} = {
  h: { ar: "ذكين من الداخل.", en: "Inside Thakeen." },
  sub: {
    ar: "شاشات من التطبيق نفسه، فيها بيانات مثال توضيحية لنشاط تخيّلي، مو لعملاء حقيقيين.",
    en: "Screens from the app itself, filled with illustrative sample data for an imaginary business, not real customers.",
  },
  // Rule 1221: on every panel, above the screen.
  label: { ar: "مثال توضيحي", en: "Illustrative example" },
  note: {
    ar: "الأزرار هنا للتجربة: ما تنشر ولا تحفظ شي.",
    en: "The buttons here are only to try: nothing is published or saved.",
  },
  tabsLabel: { ar: "شاشات من ذكين", en: "Thakeen screens" },
  tabs: {
    chat: {
      label: { ar: "المحادثة", en: "Chat" },
      cap: { ar: "تطلب بكلامك، ونور تكتب لك مسودة تنتظر موافقتك.", en: "Ask in your own words, and Noor writes a draft that waits for your approval." }
    },
    plan: {
      label: { ar: "الخطة", en: "Plan" },
      cap: { ar: "نور تقترح أول خطة، وأنت تختار وش يدخل قائمتك.", en: "Noor suggests a first plan, and you choose what goes on your list." }
    },
    inbox: {
      label: { ar: "صندوق الموافقة", en: "Inbox" },
      cap: { ar: "كل شي يكتبه الفريق ينتظر موافقتك هنا قبل أي نشر.", en: "Everything the team writes waits here for your approval before anything goes out." }
    },
  },
};

/** A sample approval card: an item the way the chat and the inbox receive it, in both languages. */
type SampleItem = { id: string; type: TaskType; channel: string; title: L; body: L };

const CHAT_ITEM: SampleItem = {
  id: "gallery-chat-post",
  type: "social",
  channel: "instagram",
  title: { ar: "الخلطة الجديدة", en: "The new blend" },
  body: {
    ar: "وصلت خلطة جديدة للمحمصة.\nتحميص متوسط، فيها لمسة شوكولاتة وبندق.\nجربها هالأسبوع وقل لنا وش رأيك.",
    en: "A new blend just arrived at the roastery.\nMedium roast, with a hint of chocolate and hazelnut.\nTry it this week and tell us what you think.",
  },
};

const INBOX_ITEMS: SampleItem[] = [
  {
    id: "gallery-inbox-followup",
    type: "followup_seq",
    channel: "whatsapp",
    title: { ar: "متابعة بعد الطلب", en: "Follow-up after an order" },
    body: {
      ar: "هلا، شكرًا على طلبك من المحمصة.\nوش رأيك في القهوة؟ إذا تبي نصيحة في طريقة التحضير، رد علينا هنا.",
      en: "Hi, thank you for your order from the roastery.\nHow are you finding the coffee? If you would like a tip on brewing it, reply here.",
    },
  },
  {
    id: "gallery-inbox-gbp",
    type: "gbp",
    channel: "gbp",
    title: { ar: "ركن التذوق", en: "The tasting corner" },
    body: {
      ar: "صار عندنا ركن للتذوق في المحمصة.\nمرّوا علينا وجربوا قبل لا تختارون.",
      en: "We now have a tasting corner at the roastery.\nDrop by and taste before you choose.",
    },
  },
];

const PLAN: { type: TaskType; title: L; brief: L }[] = [
  { type: "weekly_plan", title: { ar: "خطة محتوى الأسبوع", en: "This week's content plan" }, brief: { ar: "خطة منشورات الأسبوع للمحمصة.", en: "The roastery's posts for the week." } },
  { type: "social", title: { ar: "منشور عن الخلطة الجديدة", en: "A post about the new blend" }, brief: { ar: "منشور انستقرام عن الخلطة الجديدة.", en: "An Instagram post about the new blend." } },
  { type: "whatsapp", title: { ar: "رسالة واتساب للعملاء الدائمين", en: "A WhatsApp message for regular customers" }, brief: { ar: "رسالة ترحيب بالخلطة الجديدة.", en: "A message welcoming the new blend." } },
  { type: "gbp", title: { ar: "تحديث صفحة النشاط في قوقل", en: "An update for the Google Business Profile" }, brief: { ar: "خبر ركن التذوق.", en: "News of the tasting corner." } },
];

const CHAT: { ask: L; reply: L } = {
  ask: { ar: "نور، اكتبي منشور انستقرام عن الخلطة الجديدة.", en: "Noor, write an Instagram post about the new blend." },
  reply: {
    ar: "جهّزت لك مسودة. راجعها، وإذا عجبتك اعتمدها. ما ينشر شي بدون موافقتك.",
    en: "Here is a draft. Review it, and approve it if you like it. Nothing goes out without your approval.",
  },
};

const item = (s: SampleItem, lang: Lang): ChatItem => ({ id: s.id, type: s.type, channel: s.channel, title: s.title[lang], body: s.body[lang], status: "pending" });

/** One language's samples, in the shapes the app's components take. */
export type GallerySamples = {
  chat: { ask: string; reply: string; item: ChatItem };
  plan: PlanItem[];
  inbox: ChatItem[];
};

export function gallerySamples(lang: Lang): GallerySamples {
  return {
    chat: { ask: CHAT.ask[lang], reply: CHAT.reply[lang], item: item(CHAT_ITEM, lang) },
    plan: PLAN.map((p) => ({ type: p.type, title: p.title[lang], brief: p.brief[lang] })),
    inbox: INBOX_ITEMS.map((s) => item(s, lang)),
  };
}

/** Every visible string the gallery's own copy and samples hold, both languages: what the tests scan. */
export function galleryStrings(): string[] {
  const ls: L[] = [
    GALLERY_COPY.h, GALLERY_COPY.sub, GALLERY_COPY.label, GALLERY_COPY.note, GALLERY_COPY.tabsLabel,
    ...GALLERY_TABS.flatMap((k) => [GALLERY_COPY.tabs[k].label, GALLERY_COPY.tabs[k].cap]),
    CHAT.ask, CHAT.reply,
    ...[CHAT_ITEM, ...INBOX_ITEMS].flatMap((s) => [s.title, s.body]),
    ...PLAN.flatMap((p) => [p.title, p.brief]),
  ];
  return ls.flatMap((l) => [l.ar, l.en]);
}
