import type { User } from "./auth";
import { getBrand, listLite } from "./brand";
import { once, sendEmail } from "./notify";

/**
 * Lifecycle emails (plain text, from the founder). Runs inside the daily cron.
 * Day counts are since signup. Each fires once per user.
 */
const ORIGIN = () => process.env.APP_ORIGIN ?? "https://nashr-tau.vercel.app";
const WA = () => (process.env.SUPPORT_WHATSAPP ? `https://wa.me/${process.env.SUPPORT_WHATSAPP.replace(/\D/g, "")}` : "");

type Tpl = { subject: string; body: string };

function t(u: User, key: string, ctx: { firstTitle?: string; pending: number; approved: number; trialEnds: string }): Tpl | null {
  const ar = u.lang === "ar";
  const app = `${ORIGIN()}/${u.lang}/app`;
  const sig = ar ? `\n\n— [اسمك]، مؤسس نشر${WA() ? "\nواتساب: " + WA() : ""}` : `\n\n— [Your name], founder of Nashr${WA() ? "\nWhatsApp: " + WA() : ""}`;
  switch (key) {
    case "day1":
      return ar
        ? { subject: ctx.firstTitle ? `نور كتبت لك: «${ctx.firstTitle}»` : "أول يوم مع نور", body: `أهلاً ${u.name} 👋\n\n${ctx.firstTitle ? `نور جهّزت لك «${ctx.firstTitle}» وهو في صندوق موافقتك الآن. اعتمده أو عدّله — كل تعديل يعلّمها صوتك.` : "نور جاهزة. اطلب منها أول دفعة من الدردشة: «جهزي 10 منشورات للأسبوع»."}\n\nنصيحة اليوم: اطلب منها «استوردي منتجاتي» في الدردشة، وبعدها كل محتوى يذكر أسماء وأسعار حقيقية.\n\n${app}${sig}` }
        : { subject: ctx.firstTitle ? `Noor wrote: “${ctx.firstTitle}”` : "Day one with Noor", body: `Hi ${u.name} 👋\n\n${ctx.firstTitle ? `Noor prepared “${ctx.firstTitle}” and it's in your inbox. Approve or edit it — every edit teaches her your voice.` : "Noor is ready. Ask her for a first batch in chat: “prepare 10 posts for the week”."}\n\nTip for today: tell her “import my products” in chat; after that every piece uses real names and prices.\n\n${app}${sig}` };
    case "day2":
      return ar
        ? { subject: "تجربتك تنتهي غداً", body: `${u.name}، تجربتك تنتهي ${ctx.trialEnds}.\n\nحتى الآن: ${ctx.approved} عنصر معتمد، ${ctx.pending} بانتظارك.\n\nإذا نور وفّرت عليك ساعة هذا الأسبوع، خطة الاحتراف 399 ريال/شهر تعطيك 700 كريدت وضبطاً تلقائياً للإعلانات. الاشتراك من هنا: ${app}/billing\n\nوإذا فيه شيء ما عجبك، رد على هذا الإيميل وقل لي.${sig}` }
        : { subject: "Your trial ends tomorrow", body: `${u.name}, your trial ends ${ctx.trialEnds}.\n\nSo far: ${ctx.approved} approved, ${ctx.pending} waiting.\n\nIf Noor saved you an hour this week, Pro at SAR 399/mo gives you 700 credits and auto ad optimization. Subscribe: ${app}/billing\n\nIf something didn't work, reply and tell me.${sig}` };
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
  return [
    ["day1", days >= 1],
    ["day2", !paying && hoursLeft > 24 && hoursLeft <= 48],
    ["day3", !paying && hoursLeft > 0 && hoursLeft <= 24],
    ["day10", !paying && days >= 10],
  ];
}

export async function runLifecycle(u: User): Promise<string[]> {
  if (!process.env.RESEND_API_KEY) return [];
  const brand = await getBrand(u.scope ?? u.email);
  if (!brand) return []; // signup nudge handles no-brand users
  const tasks = await listLite(u.scope ?? u.email);
  const ctx = { firstTitle: tasks.at(-1)?.title, pending: tasks.filter((x) => x.status === "pending").length, approved: tasks.filter((x) => x.status === "approved").length, trialEnds: u.trialEnds.slice(0, 10) };
  const plan = lifecyclePlan(u);
  const sent: string[] = [];
  for (const [key, due] of plan) {
    if (!due) continue;
    if (!(await once(u.email, `lifecycle:${key}`))) continue;
    const tpl = t(u, key, ctx);
    if (tpl && (await sendEmail(u.email, tpl.subject, tpl.body))) sent.push(key);
  }
  return sent;
}
