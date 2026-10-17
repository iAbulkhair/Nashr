import type { Lang } from "./i18n";

/**
 * What a workspace panel says when it has nothing to show (rule 2002, wave 1b): a title and one line of what to do, for
 * the shared `EmptyState`. The Arabic is Hijazi white dialect in the site's voice, the English beside it says the same.
 * No numbers, no customers, no promised results: only what is missing and the next step. Pure data, so the server pages,
 * the client panels and the tests read one list.
 */
export type EmptyCopy = { title: string; body: string };

export const EMPTY_KEYS = [
  "inbox", "files", "inspo", "instructions", "library", "reports", "series", "todo",
  "activity", "activityFiltered", "away", "payments", "devices",
] as const;
export type EmptyKey = (typeof EMPTY_KEYS)[number];

export const EMPTY_COPY: Record<Lang, Record<EmptyKey, EmptyCopy>> = {
  ar: {
    inbox: { title: "ما فيه شي ينتظرك دحين", body: "لما يجهّز الفريق شغل جديد، يطلع لك هنا تراجعه وتوافق عليه. تقدر تطلب من نور أول دفعة." },
    files: { title: "ما فيه ملفات لسه", body: "شغّل الإعداد من رابط موقعك، ونور تكتب أول الملفات عن علامتك." },
    inspo: { title: "ما لقينا شي يطابق بحثك", body: "جرّب كلمة ثانية، أو رجّع الفلاتر على «الكل»." },
    instructions: { title: "ما فيه تعليمات لسه", body: "أضف تعليمة، احفظها مسودة، وبعدين فعّلها." },
    library: { title: "المكتبة فاضية لسه", body: "ارفع صورة أو فيديو، أو استورد من حسابك المربوط، ويتحفظ هنا." },
    reports: { title: "ما فيه تقارير لسه", body: "اطلب من دانة التقرير الأسبوعي أو عرض، ويطلع لك هنا." },
    series: { title: "ما فيه نسخ مقفولة لسه", body: "أول ما تقفل نسخة من هذي المهمة، تلقاها هنا." },
    todo: { title: "قائمتك فاضية", body: "أضف أول مهمة من النموذج اللي تحت، أو اطلبها من ريم في الدردشة." },
    activity: { title: "ما فيه نشاط لسه", body: "كل شغل يسويه الفريق أو تسويه أنت ينكتب هنا." },
    activityFiltered: { title: "ما فيه شي بهذا الاختيار", body: "غيّر الوكيل أو النوع، أو رجّعهم على «الكل»." },
    away: { title: "ما أحد غايب دحين", body: "أضف اسم من يغيب، وريم ما تقترح متابعته لين يرجع." },
    payments: { title: "ما فيه مدفوعات لسه", body: "أول ما تدفع، يطلع الإيصال هنا." },
    devices: { title: "ما فيه أجهزة ثانية", body: "حسابك مفتوح على هذا الجهاز بس." },
  },
  en: {
    inbox: { title: "Nothing waiting for you right now", body: "When the team has new work ready, it shows up here for you to review and approve. You can ask Noor for the first batch." },
    files: { title: "No files yet", body: "Run setup from your website link and Noor writes the first files about your brand." },
    inspo: { title: "Nothing matches your search", body: "Try another word, or set the filters back to All." },
    instructions: { title: "No instructions yet", body: "Add one, save it as a draft, then switch it on." },
    library: { title: "The library is empty for now", body: "Upload a picture or a video, or import from a linked account, and it is kept here." },
    reports: { title: "No reports yet", body: "Ask Dana for the weekly report or a deck, and it shows up here." },
    series: { title: "No closed copies yet", body: "Once a copy of this task is closed, you will find it here." },
    todo: { title: "Your list is empty", body: "Add the first item with the form below, or ask Reem in chat." },
    activity: { title: "No activity yet", body: "Everything the team or you does is written here." },
    activityFiltered: { title: "Nothing for this choice", body: "Change the agent or the kind, or set them back to All." },
    away: { title: "Nobody is away right now", body: "Add whoever will be away, and Reem holds their follow-ups until they are back." },
    payments: { title: "No payments yet", body: "Once you pay, the receipt shows up here." },
    devices: { title: "No other devices", body: "Your account is open on this device only." },
  },
};

/** The empty state's words for one panel in one language. */
export const emptyCopy = (lang: Lang, key: EmptyKey): EmptyCopy => EMPTY_COPY[lang][key];
