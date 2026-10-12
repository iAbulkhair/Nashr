import type { Lang } from "@/lib/i18n";
import type { AppDict } from "@/lib/app-i18n";
import { TASK_COST, TASK_COUNT, type TaskType } from "@/lib/tasks";
import { MEDIA_MODELS, type MediaKind } from "@/lib/media-catalog";
import { ONBOARD_EXTRA_BRAND_COST, formatCount } from "@/lib/pricing";
import { creditSplit, type TopupBalance } from "@/lib/topups";
import { AGENTS } from "@/lib/agents";
import type { ChatStatus } from "@/lib/chat-allowance";
import type { MonthUsage } from "@/lib/month-usage";
import { paceStart, runway, runwayLine } from "@/lib/usage-view";
import { Time } from "@/components/ui/Time";
import { formatTime } from "@/lib/format";

/** "1–2": the lowest and highest price of a media kind in the catalogue, as the pricing page shows it. */
const mediaRange = (kind: MediaKind) => {
  const c = MEDIA_MODELS.filter((m) => m.kind === kind).map((m) => m.credits);
  const lo = Math.min(...c), hi = Math.max(...c);
  return lo === hi ? String(lo) : `${lo}–${hi}`;
};

/** The account summary the card reads: what every seat may see (GET /api/profile `SUMMARY` plus the packs' balance). */
export type CreditUser = { plan: string; credits: number; trialEnds: string; createdAt: string; topups?: TopupBalance[] };

/**
 * Settings, Billing: this month's credits (rule 1153), moved from the old profile page unchanged. Used against the
 * allowance with the runway line, the balance split into plan and top-up credits with each pack's expiry (rule 456),
 * the chat messages (rule 315) and the per-action breakdown. Every seat sees it; nothing on it pays or changes anything.
 * A server component: the page hands it the figures, so the server and the browser render the same dates.
 */
/**
 * `chatBar`: the messages bar and its runway line. Off on the billing page, where the chat card above shows them; the
 * chat rows of the breakdown and the overflow credits in "used" stay either way.
 */
export default function CreditUsageCard({ t, lang, user, month, allowance, chat, chatBar = true }: { t: AppDict; lang: Lang; user: CreditUser; month: MonthUsage; allowance: number; chat?: ChatStatus; chatBar?: boolean }) {
  const ar = lang === "ar";
  const { usage, images, nextReset } = month;
  const mediaUsed = month.mediaCredits ?? images;
  const chatCredits = chat && Number.isFinite(chat.overflow.credits) ? Math.max(0, chat.overflow.credits) : 0;
  const usedCredits = Object.values(usage).reduce((s, x) => s + x.credits, 0) + mediaUsed + chatCredits;
  const pct = Math.min(100, Math.round((usedCredits / Math.max(1, allowance)) * 100));
  const trial = user.plan === "trial";
  const trialEnd = user.trialEnds.slice(0, 10);
  const lineOpts = { lang, trial, nextReset, trialEnds: trialEnd };
  const creditLine = runwayLine(runway({ used: usedCredits, left: user.credits, periodStart: paceStart(user.createdAt), resetAt: trial ? null : nextReset, trialEnds: user.trialEnds }), { ...lineOpts, what: "credits" });
  const chatTrial = chat?.period === "trial";
  const chatPct = chat ? Math.min(100, Math.round((chat.used / Math.max(1, chat.allowance)) * 100)) : 0;
  const overflowOn = !!chat && chat.overflow.on && chat.overflow.available;
  const chatOff = !!chat && chat.allowance <= 0;
  const short = overflowOn && user.credits < chat.overflow.hold;
  const chatLine = chat ? runwayLine(runway({ used: chat.used, left: chat.left, periodStart: chatTrial ? user.createdAt : paceStart(user.createdAt), resetAt: chatTrial ? null : nextReset, trialEnds: user.trialEnds }), { ...lineOpts, trial: chatTrial, what: "messages", overflowOn, chatOff, shortOf: short ? chat.overflow.hold : undefined }) : null;
  const chatOverflowShown = !!chat && (chat.overflow.used > 0 || chatCredits > 0);
  const rules = trial
    ? (ar ? `تجربتك تشمل ${allowance} كريدت لمدة 3 أيام. تنتهي ${formatTime(user.trialEnds, lang)}.` : `Your trial includes ${allowance} credits for 3 days. Ends ${formatTime(user.trialEnds, lang)}.`)
    : (ar ? `خطتك تشمل ${allowance} كريدت شهرياً. يتجدد كريدت الخطة في اليوم الأول من كل شهر (UTC)، وتبقى باقات الشحن السارية حتى تنتهي صلاحيتها. التجديد القادم: ${nextReset}.` : `Your plan includes ${allowance} credits per month. The plan's credits reset on the 1st of each month (UTC); top-up packs keep what is left in them until they expire. Next reset: ${nextReset}.`);
  // The balance as plan credits and top-up credits, each pack with its expiry (rule 456): the renewal on the 1st resets
  // only the plan credits, so the card never presents the whole balance as one that resets.
  const split = creditSplit(user.credits, user.topups);

  return (
    <section className="mt-6 card" aria-labelledby="credit-usage-title" data-credit-usage="">
      <h2 id="credit-usage-title" className="font-display text-lg font-bold">{ar ? "استخدام الكريدت" : "Credit usage"}</h2>
      <p className="mt-1 text-sm text-muted">{rules}</p>
      <div className="mt-3 flex items-center justify-between text-sm"><span>{ar ? "المستخدم" : "Credits used"}</span><span className="font-mono" dir="ltr">{usedCredits} / {allowance} ({pct}%)</span></div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-lilac"><div className="h-full bg-ink" style={{ width: `${pct}%` }} /></div>
      {creditLine && <p className="mt-1 text-xs text-muted" data-runway="credits">{creditLine}</p>}
      <div className="mt-3 rounded-lg bg-ink/5 p-3" data-credit-split="">
        <span className="font-display text-2xl font-bold text-ink" dir="ltr">{user.credits}</span> <span className="text-sm text-muted">{ar ? "كريدت متبقٍ" : "credits remaining"}</span>
        {split.topup > 0 && (
          <dl className="mt-2 grid gap-1 text-xs text-ink/70">
            <div className="flex justify-between gap-2" data-plan-credits=""><dt>{trial ? (ar ? "كريدت التجربة" : "Trial credits") : (ar ? `كريدت الخطة (يتجدد في ${nextReset})` : `Plan credits (reset on ${nextReset})`)}</dt><dd className="font-mono" dir="ltr">{formatCount(split.plan)}</dd></div>
            <div className="flex justify-between gap-2" data-topup-credits=""><dt>{ar ? "كريدت باقات الشحن (يُصرف بعد كريدت الخطة، ولا يتجدد)" : "Top-up credits (used after the plan credits; no reset)"}</dt><dd className="font-mono" dir="ltr">{formatCount(split.topup)}</dd></div>
            {split.packs.map((p, i) => (
              <div key={i} className="flex justify-between gap-2 ps-3 text-muted" data-pack-expiry="">
                <dt>{ar ? <>باقة <span dir="ltr">{formatCount(p.credits)}</span>: متبقٍ <span dir="ltr">{formatCount(p.left)}</span></> : `${formatCount(p.credits)}-credit pack: ${formatCount(p.left)} left`}</dt>
                <dd>{ar ? "تنتهي" : "expires"} <Time value={p.expiresAt} lang={lang} className="tnum" /></dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      {/* The account's chat messages (rule 315): counted apart from credits, shared by every seat. */}
      {chat && chatBar && (
        <div className="mt-4" data-chat-usage="">
          <div className="flex items-center justify-between text-sm"><span>{chatTrial ? (ar ? "رسائل الدردشة في التجربة" : "Chat messages in your trial") : (ar ? "رسائل الدردشة هذا الشهر" : "Chat messages this month")}</span><span className="font-mono" dir="ltr">{formatCount(chat.used)} / {formatCount(chat.allowance)}</span></div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-lilac"><div className={`h-full ${chat.left > 0 ? "bg-ink" : "bg-lemon"}`} style={{ width: `${chatPct}%` }} /></div>
          {chatLine && <p className="mt-1 text-xs text-muted" data-runway="messages">{chatLine}</p>}
          {chatOverflowShown && <p className="mt-1 text-xs text-muted" data-chat-overflow-used="">{ar ? `${formatCount(chat.overflow.used)} رسالة إضافية هذا الشهر على الكريدت، خُصم عليها ${formatCount(chatCredits)} كريدت.` : `${formatCount(chat.overflow.used)} more this month, continued on credits: ${formatCount(chatCredits)} ${chatCredits === 1 ? "credit" : "credits"} billed.`}</p>}
        </div>
      )}
      <h3 className="mt-4 text-sm font-semibold">{ar ? "تفصيل الاستخدام" : "Usage breakdown"}</h3>
      <div className="overflow-x-auto"><table className="mt-2 w-full text-sm"><thead className="text-start text-xs text-muted"><tr><th scope="col" className="py-1 text-start">{ar ? "الإجراء" : "Action"}</th><th scope="col">{ar ? "كريدت لكل دفعة" : "Credits each"}</th><th scope="col">{ar ? "دفعات" : "Used"}</th><th scope="col">{ar ? "الإجمالي" : "Total credits"}</th></tr></thead>
        <tbody>
          {AGENTS.map((a) => a.tasks.map((k: TaskType) => (
            <tr key={k} className="border-t border-ink/5"><td className="py-1"><span className="text-xs text-muted">{t.agents[a.id].name} · </span>{t.generate.types[k].t}</td><td className="text-center font-mono">{TASK_COST[k]}</td><td className="text-center font-mono">{Math.round((usage[k]?.count ?? 0) / TASK_COUNT[k])}</td><td className="text-center font-mono">{usage[k]?.credits ?? 0}</td></tr>
          )))}
          {/* The catalogue's prices (src/lib/media-catalog.ts), as the pricing page states them, and what the renders really charged. */}
          <tr className="border-t border-ink/5"><td className="py-1">{ar ? "الصور ومقاطع الفيديو" : "Images and videos"}</td><td className="text-center font-mono" dir="ltr">{mediaRange("image")} · {mediaRange("video")}</td><td className="text-center font-mono">{images}</td><td className="text-center font-mono">{mediaUsed}</td></tr>
          {/* Chat messages inside the plan's allowance cost no credits; past it, when the owner turned "continue on
              credits" on, each is billed what it actually cost, at most `overflow.hold`: the month's total is
              `overflow.credits`, counted in the credits used above. */}
          <tr className="border-t border-ink/5" data-chat-row=""><td className="py-1">{ar ? "الدردشة مع الفريق (رسائل خطتك)" : "Chat with the team (your plan's messages)"}</td><td className="text-center font-mono">0</td><td className="text-center font-mono" dir="ltr">{chat ? `${formatCount(chat.used)} / ${formatCount(chat.allowance)}` : "—"}</td><td className="text-center font-mono">0</td></tr>
          {chat && chatOverflowShown && (
            <tr className="border-t border-ink/5" data-chat-overflow-row=""><td className="py-1">{ar ? "رسائل إضافية على الكريدت" : "Extra messages on credits"}</td><td className="text-center font-mono" dir="ltr">≤ {formatCount(chat.overflow.hold)}</td><td className="text-center font-mono">{formatCount(chat.overflow.used)}</td><td className="text-center font-mono" data-chat-overflow-credits="">{formatCount(chatCredits)}</td></tr>
          )}
          <tr className="border-t border-ink/5"><td className="py-1">{ar ? "إعداد علامتك الأولى من الرابط" : "Setting up your first brand from its URL"}</td><td className="text-center font-mono">0</td><td className="text-center font-mono">—</td><td className="text-center font-mono">0</td></tr>
          {/* Not a task, so it is not in the usage counts above: the setup charge shows in the balance only. */}
          <tr className="border-t border-ink/5"><td className="py-1">{ar ? "إعداد كل علامة إضافية من رابطها" : "Setting up each added brand from its URL"}</td><td className="text-center font-mono">{ONBOARD_EXTRA_BRAND_COST}</td><td className="text-center font-mono">—</td><td className="text-center font-mono">—</td></tr>
        </tbody></table></div>
    </section>
  );
}
