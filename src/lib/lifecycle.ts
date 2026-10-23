import type { User } from "./auth";
import { FIRST_MONTH_DISCOUNT_PCT } from "./pricing"; // the day-3 offer (src/lib/partners.ts, rules 394, 410)
import { earlyOfferLastDay } from "./partner-rules";
import { getBrand, isWaiting, listLiteDays } from "./brand";
import { confirmedMarker, mailReady, onceKey, sendOnce, type OncePart } from "./notify";
import { db } from "./db";
import { acct } from "./account-id";
import { PLAN_CREDITS, PLAN_PRICE_SAR, formatCount } from "./pricing";
import { appOrigin } from "./origin";
import { COPY, paragraphs, renderEmail } from "../emails";
import { appHrefFor } from "@/lib/ws-href";
import { SUPPORT_EMAIL } from "./i18n";

/** The notes whose text asks for a reply (day 2 "reply and tell me", day 10 "I read every reply"): reply-to support (rule 3110). */
export const REPLY_INVITED: ReadonlySet<string> = new Set(["day2", "day10"]);

/**
 * Lifecycle emails (from the founder): a plain-text part written here, and the same words as an HTML notice
 * (`lifecycleHtml`). Runs inside the daily cron. Day counts are since signup. Each fires once per user.
 */
const WA = () => (process.env.SUPPORT_WHATSAPP ? `https://wa.me/${process.env.SUPPORT_WHATSAPP.replace(/\D/g, "")}` : "");

type Tpl = { subject: string; body: string };

/**
 * Which first-month offer the day-3 note names (rule 410): "early" when the account holds an unused early-partner offer
 * or is about to be granted one (no offer and no payment: the daily cron grants it alongside this note), "partner" when
 * it holds an unused partner code's offer (no end date, so none is named), null when its offer was used or it has paid.
 * Here rather than in src/lib/partners.ts, which imports this file.
 */
export function day3Offer(u: Pick<User, "firstMonthOffer" | "firstPaidOn">): "early" | "partner" | null {
  if (u.firstPaidOn) return null;
  if (!u.firstMonthOffer) return "early";
  return u.firstMonthOffer.usedAt ? null : u.firstMonthOffer.kind;
}

/** The lifecycle note for `key`, or null (exported for tests). */
export function lifecycleTemplate(u: User, key: string, ctx: { firstTitle?: string; pending: number; approved: number; trialEnds: string }): Tpl | null {
  const ar = u.lang === "ar";
  const app = `${appOrigin()}${appHrefFor(u, u.lang)}`;
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
    case "day3": {
      const offer = day3Offer(u);
      const code = u.referredBy?.code;
      const pitch = offer === "early"
        ? (ar
          ? `شهرك الأول عليه خصم ${FIRST_MONTH_DISCOUNT_PCT}% (عرض الشركاء الأوائل، للشهر الأول فقط، وينتهي العرض في ${earlyOfferLastDay(u.trialEnds)})`
          : `your first month is ${FIRST_MONTH_DISCOUNT_PCT}% off (the early-partner offer, first month only, ending on ${earlyOfferLastDay(u.trialEnds)})`)
        : offer === "partner"
          ? (ar
            ? `شهرك الأول عليه خصم ${FIRST_MONTH_DISCOUNT_PCT}% ${code ? `من كود الشريك ${code}` : "من كود الشريك"} (للشهر الأول فقط)`
            : `your first month is ${FIRST_MONTH_DISCOUNT_PCT}% off ${code ? `with partner code ${code}` : "with your partner code"} (first month only)`)
          : null;
      return ar
        ? { subject: "آخر يوم في التجربة", body: `${u.name}، اليوم آخر يوم.\n\nنور كتبت لك ${ctx.approved + ctx.pending} عنصراً. ${pitch ? `لو تبي تكمل، ${pitch}: تجده في صفحة الاشتراك ${app}/billing — أو راسلني على واتساب وأفعّله لك بالخصم.` : `لو تبي تكمل: ${app}/billing — أو راسلني على واتساب وأفعّله لك.`}${sig}` }
        : { subject: "Last day of your trial", body: `${u.name}, today is the last day.\n\nNoor wrote ${ctx.approved + ctx.pending} items for you. ${pitch ? `To continue, ${pitch}: it is on your billing page ${app}/billing — or WhatsApp me and I'll activate it at the discount.` : `To continue: ${app}/billing — or WhatsApp me and I'll activate it for you.`}${sig}` };
    }
    case "day10":
      return ar
        ? { subject: "ما الذي وقّفك؟", body: `${u.name}، سؤال واحد صريح: ما الذي منعك من الاستمرار مع نور؟\n\nالجودة؟ اللهجة؟ السعر؟ ميزة ناقصة؟ رد بكلمة وأنا أقرأ كل رد بنفسي.\n\nوإذا تبي تجرب من جديد بعد التحديثات: ${app}${sig}` }
        : { subject: "What stopped you?", body: `${u.name}, one honest question: what kept you from continuing with Noor?\n\nQuality? Dialect? Price? A missing feature? One word is enough — I read every reply.\n\nTo try again after the updates: ${app}${sig}` };
    default:
      return null;
  }
}

/**
 * The HTML part of a lifecycle note (rule 685): the template's own subject and body in the shared notice layout, so the
 * words cannot drift from the text part. The paragraph that is only the app's address becomes the button instead; the
 * trial notes (day 2 and day 3) point it at the subscription page they talk about. Every other address stays where the
 * text has it, as text kept left to right, never as a link (rule 687: links go into the app only).
 */
export function lifecycleHtml(u: Pick<User, "lang" | "id" | "email">, key: string, tpl: Tpl): string {
  return renderEmail("notice", lifecyclePart(u, key, tpl).context, u.lang);
}
/** The note as a typed template message for `sendOnce` (rule 1962); `lifecycleHtml` renders the same thing. */
export function lifecyclePart(u: Pick<User, "lang" | "id" | "email">, key: string, tpl: Tpl): OncePart<"notice"> {
  const app = `${appOrigin()}${appHrefFor(u, u.lang)}`;
  const billing = key === "day2" || key === "day3";
  return {
    template: "notice",
    locale: u.lang,
    context: {
      title: tpl.subject,
      paragraphs: paragraphs(tpl.body).filter((p) => p !== app),
      cta: billing ? { href: `${appOrigin()}${appHrefFor(u, u.lang, "/billing")}`, label: COPY[u.lang].notice.billing } : { href: app, label: COPY[u.lang].notice.open },
    },
    ...(REPLY_INVITED.has(key) ? { replyTo: SUPPORT_EMAIL } : {}),
  };
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
  const ctx = { firstTitle: tasks.at(-1)?.title, pending: tasks.filter(isWaiting).length, approved: tasks.filter((x) => x.status === "approved").length, trialEnds: u.trialEnds.slice(0, 10) };
  // Marked as sent only when Resend accepted it (src/lib/notify.ts `sendOnce`): a refused note is tried again tomorrow,
  // while its window lasts. The due notes go out side by side; rarely more than one is due.
  //
  // The one-time markers are the ACCOUNT's (`notified:{acct}:lifecycle:*`, rule 3033), not the address's: a person who
  // owns two workspaces gets each workspace's notes, and the account deletion (`wipeAccount(acct)`) finds them. The note
  // still goes to the owner's ADDRESS (`sendOnce`'s `to`). Expand (rule 679): a note marked sent under the address
  // before this release (the only key while the account id was the address; a moved legacy owner's notes since the
  // move) counts as sent, so nobody is mailed twice; that read is skipped when the two keys are the same. Contract:
  // the address read goes once every note window open at the expand release has closed (13 days).
  const due = plan.filter(([, d]) => d).map(([key]) => key);
  const owner = acct(u);
  const results = await Promise.all(due.map(async (key) => {
    const tpl = lifecycleTemplate(u, key, ctx);
    if (!tpl) return null;
    const name = `lifecycle:${key}`;
    if (owner !== u.email && confirmedMarker(await db.get<unknown>(onceKey(u.email, name)))) return null;
    return (await sendOnce(owner, name, tpl.subject, tpl.body, lifecyclePart(u, key, tpl), u.email)) === "sent" ? key : null;
  }));
  return results.filter((k): k is string => k !== null);
}
