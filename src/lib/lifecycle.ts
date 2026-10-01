import type { User } from "./auth";
import { getBrand, listLiteDays } from "./brand";
import { mailReady, sendOnce } from "./notify";
import { PLAN_CREDITS, PLAN_PRICE_SAR, formatCount } from "./pricing";
import { appOrigin } from "./origin";

/**
 * Lifecycle emails (plain text, from the founder). Runs inside the daily cron.
 * Day counts are since signup. Each fires once per user.
 */
const WA = () => (process.env.SUPPORT_WHATSAPP ? `https://wa.me/${process.env.SUPPORT_WHATSAPP.replace(/\D/g, "")}` : "");

type Tpl = { subject: string; body: string };

function t(u: User, key: string, ctx: { firstTitle?: string; pending: number; approved: number; trialEnds: string }): Tpl | null {
  const ar = u.lang === "ar";
  const app = `${appOrigin()}/${u.lang}/app`;
  const sig = ar ? `\n\n— مؤسس ذكين${WA() ? "\nواتساب: " + WA() : ""}` : `\n\n— Founder of Thakeen${WA() ? "\nWhatsApp: " + WA() : ""}`;
  switch (key) {
    case "day1":
      return ar
        ? { subject: ctx.firstTitle ? `نور كتبت لك: «${ctx.firstTitle}»` : "أول يوم مع نور", body: `أهلاً ${u.name} 👋\n\n${ctx.firstTitle ? `نور جهّزت لك «${ctx.firstTitle}» وهو في صندوق موافقتك الآن. اعتمده أو عدّله — كل تعديل يعلّمها صوتك.` : "نور جاهزة. اطلب منها أول دفعة من الدردشة: «جهزي 10 منشورات للأسبوع»."}\n\nنصيحة اليوم: اطلب منها «استوردي منتجاتي» في الدردشة، وبعدها تستطيع نور أن تكتب بأسماء منتجاتك وأسعارها كما ظهرت في متجرك.\n\n${app}${sig}` }
        : { subject: ctx.firstTitle ? `Noor wrote: “${ctx.firstTitle}”` : "Day one with Noor", body: `Hi ${u.name} 👋\n\n${ctx.firstTitle ? `Noor prepared “${ctx.firstTitle}” and it's in your inbox. Approve or edit it — every edit teaches her your voice.` : "Noor is ready. Ask her for a first batch in chat: “prepare 10 posts for the week”."}\n\nTip for today: tell her “import my products” in chat; after that she can write with your real product names and the prices your store showed.\n\n${app}${sig}` };
    case "day2":
      return ar
        ? { subject: "تجربتك تنتهي غداً", body: `${u.name}، تجربتك تنتهي ${ctx.trialEnds}.\n\nحتى الآن: ${ctx.approved} عنصر معتمد، ${ctx.pending} بانتظارك.\n\nإذا نور وفّرت عليك ساعة هذا الأسبوع، خطة الاحتراف ${PLAN_PRICE_SAR.pro} ريال/شهر تعطيك ${formatCount(PLAN_CREDITS.pro)} كريدت شهرياً وضبطاً تلقائياً للإعلانات (قريباً). الاشتراك من هنا: ${app}/billing\n\nوإذا فيه شيء ما عجبك، رد على هذا الإيميل وقل لي.${sig}` }
        : { subject: "Your trial ends tomorrow", body: `${u.name}, your trial ends ${ctx.trialEnds}.\n\nSo far: ${ctx.approved} approved, ${ctx.pending} waiting.\n\nIf Noor saved you an hour this week, Pro at SAR ${PLAN_PRICE_SAR.pro}/mo gives you ${formatCount(PLAN_CREDITS.pro)} credits a month and auto ad optimization (coming soon). Subscribe: ${app}/billing\n\nIf something didn't work, reply and tell me.${sig}` };
    case "day3":
      return ar
        ? { subject: "آخر يوم في التجربة", body: `${u.name}، اليوم آخر يوم.\n\nنور كتبت لك ${ctx.approved + ctx.pending} عنصراً. لو تبي تكمل: ${app}/billing — أو راسلني على واتساب وأفعّل لك شهراً بخصم الشركاء الأوائل.${sig}` }
        : { subject: "Last day of your trial", body: `${u.name}, today is the last day.\n\nNoor wrote ${ctx.approved + ctx.pending} items for you. To continue: ${app}/billing — or WhatsApp me and I'll activate a month at the early-partner discount.${sig}` };
    case "day10":
      return ar
        ? { subject: "ما الذي وقّفك؟", body: `${u.name}، سؤال واحد صريح: ما الذي منعك من الاستمرار مع نور؟\n\nالجودة؟ اللهجة؟ السعر؟ ميزة ناقصة؟ رد بكلمة وأنا أقرأ كل رد بنفسي.\n\nوإذا تبي تجرب من جديد بعد التحديثات: ${app}${sig}` }
        : { subject: "What stopped you?", body: `${u.name}, one honest question: what kept you from continuing with Noor?\n\nQuality? Dialect? Price? A missing feature? One word is enough — I read every reply.\n\nTo try again after the updates: ${app}${sig}` };
    default:
      return null;
  }
}

/**
 * Which lifecycle emails are due for this account right now.
 *
 * The trial-deadline notes are gated on the time LEFT, not on days elapsed since signup. Elapsed days were wrong for
 * every account that did not sign up at the cron hour: the daily job runs at 05:00 UTC, so someone who signed up at
 * 10:00 got "your trial ends tomorrow" on the morning it actually expired, and "today is your last day" nineteen hours
 * AFTER it had already ended. The onboarding note (day1) and the win-back (day10) stay on elapsed days, because those
 * are about how long the account has existed, not about the deadline.
 */
export function lifecyclePlan(u: Pick<User, "createdAt" | "trialEnds" | "plan">, now: number = Date.now()): [string, boolean][] {
  const days = Math.floor((now - new Date(u.createdAt).getTime()) / 864e5);
  const paying = u.plan !== "trial";
  const hoursLeft = (new Date(u.trialEnds).getTime() - now) / 36e5;
  // Both elapsed-day rules are windows, not thresholds. `days >= 1` stayed true for the rest of the account's life:
  // `once()` stopped the mail going out a second time, but only after the workspace had been read, so every account
  // that ever existed cost a task-history read on every daily run for ever. The cron runs once a day, so a few days
  // of slack is enough for a missed run without keeping the account due indefinitely.
  return [
    ["day1", days >= 1 && days <= 3],
    ["day2", !paying && hoursLeft > 24 && hoursLeft <= 48],
    ["day3", !paying && hoursLeft > 0 && hoursLeft <= 24],
    ["day10", !paying && days >= 10 && days <= 13],
  ];
}

export async function runLifecycle(u: User): Promise<string[]> {
  // Mail that can reach the customer, not merely a key: without MAIL_FROM Resend refuses every address but its owner's,
  // so each due note would be refused (and logged as refused) on every run until the sender is set.
  if (!mailReady()) return [];
  // Decide first, read second. On most days nothing is due for a given account, and this runs for every brand on
  // every daily cron: reading each workspace's task history to then send nothing is what exhausted the chain's 30
  // hops at roughly 2,232 brands, leaving everyone past that point with no lifecycle mail at all.
  const plan = lifecyclePlan(u);
  if (!plan.some(([, due]) => due)) return [];
  const brand = await getBrand(u.scope ?? u.email);
  if (!brand) return []; // signup nudge handles no-brand users
  // 90 days, not all of history. Every message here goes to an account in its first ten days, so the window cannot
  // change what any of them say; it only stops the read growing with the age of the workspace.
  const tasks = await listLiteDays(u.scope ?? u.email, 90);
  const ctx = { firstTitle: tasks.at(-1)?.title, pending: tasks.filter((x) => x.status === "pending").length, approved: tasks.filter((x) => x.status === "approved").length, trialEnds: u.trialEnds.slice(0, 10) };
  // Marked as sent only when Resend accepted it (src/lib/notify.ts `sendOnce`): a refused note is tried again tomorrow,
  // while its window lasts. The due notes go out side by side; rarely more than one is due.
  const due = plan.filter(([, d]) => d).map(([key]) => key);
  const results = await Promise.all(due.map(async (key) => {
    const tpl = t(u, key, ctx);
    return tpl && (await sendOnce(u.email, `lifecycle:${key}`, tpl.subject, tpl.body)) === "sent" ? key : null;
  }));
  return results.filter((k): k is string => k !== null);
}
