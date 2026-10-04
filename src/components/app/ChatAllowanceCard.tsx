"use client";
import { useState } from "react";
import type { Lang } from "@/lib/i18n";
import type { ChatStatus } from "@/lib/chat-allowance";
import { runwayLine, type Runway } from "@/lib/usage-view";
import { formatCount } from "@/lib/pricing";
import ReadOnlyNote from "./ReadOnlyNote";

/**
 * The billing page's chat card (rule 315): the account's chat messages used of the plan's allowance, when they renew,
 * how long they last at this pace, and what happens when they run out. The page (a server component) reads the status
 * (src/lib/chat-allowance.ts `chatStatus`) and the runway (src/lib/usage-view.ts) and passes them in; this module only
 * imports TYPES from server-only code (tests/client-bundle.test.ts).
 *
 * The "continue on credits" switch is the owner's (`owner` = `can(u, "billing")`) on a paid plan; it posts to
 * /api/billing/chat-overflow, which checks the same role again. Everyone else sees the setting read-only. A trial has no
 * switch: its messages are granted once for the trial. Every number shown comes from the status, never the copy.
 *
 * Past the allowance with the switch on, nothing is taken before a message: it needs at least `overflow.hold` credits in
 * the balance, and after the reply it is billed what it actually cost, at most `overflow.hold` (src/lib/chat-allowance.ts).
 */
export default function ChatAllowanceCard({ lang, status, owner, nextReset, trialEnds, runway, credits }: {
  lang: Lang;
  status: ChatStatus;
  owner: boolean;
  /** YYYY-MM-DD, the 1st of next month (UTC). */
  nextReset: string;
  /** YYYY-MM-DD, the trial's last day. */
  trialEnds: string;
  runway: Runway | null;
  /** The account's credit balance now: below `overflow.hold`, chat past the allowance is paused even with the switch on. */
  credits?: number;
}) {
  const ar = lang === "ar";
  const [s, setS] = useState(status);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const trial = s.period === "trial";
  const pct = Math.min(100, Math.round((s.used / Math.max(1, s.allowance)) * 100));
  const hold = formatCount(s.overflow.hold);
  const n = (v: number) => formatCount(v);
  const overflowOn = s.overflow.on && s.overflow.available;
  // The founder set this account's messages to 0 (`User.chatAllowance`): nothing renews, so no date is promised.
  const chatOff = s.allowance <= 0;
  const short = overflowOn && typeof credits === "number" && Number.isFinite(credits) && credits < s.overflow.hold;

  async function toggle(on: boolean) {
    setSaving(true);
    setMsg("");
    try {
      const res = await fetch("/api/billing/chat-overflow", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on }) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; chat?: ChatStatus };
      if (j.ok && j.chat) { setS(j.chat); setMsg(ar ? "تم الحفظ" : "Saved"); }
      else setMsg(res.status === 403 ? (ar ? "مالك الحساب فقط يغيّر هذا." : "Only the account owner can change this.")
        : j.error === "trial" ? (ar ? "غير متاح في التجربة." : "Not available on a trial.")
        : j.error === "slow_down" ? (ar ? "تغييرات كثيرة. حاول بعد قليل." : "Too many changes. Try again shortly.")
        : (ar ? "تعذّر الحفظ. حاول مرة أخرى." : "Could not save. Try again."));
    } catch {
      setMsg(ar ? "تعذّر الحفظ. حاول مرة أخرى." : "Could not save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  const period = trial
    ? (ar ? `تجربتك تشمل ${n(s.allowance)} رسالة لفترة التجربة كلها (تنتهي ${trialEnds}).` : `Your trial includes ${n(s.allowance)} messages for the whole trial (ends ${trialEnds}).`)
    : (ar ? `تتجدد في اليوم الأول من كل شهر (UTC). التجديد القادم: ${nextReset}.` : `They renew on the 1st of each month (UTC). Next renewal: ${nextReset}.`);

  const pace = runwayLine(runway, { lang, what: "messages", trial, nextReset, trialEnds, overflowOn, chatOff, shortOf: short ? s.overflow.hold : undefined });

  const label = ar ? "أكمل على الكريدت عند نفاد الرسائل" : "Continue on credits when messages run out";
  const state = s.overflow.on
    ? (ar ? "مفعّل: عند نفاد الرسائل تستمر الدردشة على كريدت الحساب." : "On: when the messages run out, chat continues on the account's credits.")
    : chatOff
      ? (ar ? "متوقف: لا يشمل هذا الحساب رسائل دردشة حالياً." : "Off: this account has no chat messages at the moment.")
      : (ar ? "متوقف (الافتراضي): عند نفاد الرسائل تتوقف الدردشة حتى اليوم الأول من الشهر (UTC)." : "Off (the default): when the messages run out, chat pauses until the 1st of the month (UTC).");

  return (
    <section className="mt-6 card" aria-labelledby="chat-allowance-title" data-chat-allowance="">
      <h2 id="chat-allowance-title" className="font-display text-lg font-bold">{ar ? "رسائل الدردشة" : "Chat messages"}</h2>
      <p className="mt-1 text-sm text-muted">{ar
        ? "الرسالة هي ما ترسله للفريق مرة واحدة، من التطبيق أو من تطبيق متصل، مهما طال الرد. الرسالة التي تتعثر لا تُحسب. توليد المنشورات والصور والفيديو من الدردشة يُخصم من الكريدت كالمعتاد."
        : "A message is one turn you send the team, in the app or from a connected app, however long the answer. A message that fails is not counted. Generating posts, images or videos from chat uses credits as usual."}</p>
      <div className="mt-3 flex items-center justify-between text-sm">
        <span>{trial ? (ar ? "المستخدم في التجربة" : "Used in your trial") : (ar ? "المستخدم هذا الشهر" : "Used this month")}</span>
        <span className="font-mono" dir="ltr" data-chat-used="">{n(s.used)} / {n(s.allowance)}</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-lilac" role="progressbar" aria-valuemin={0} aria-valuemax={s.allowance} aria-valuenow={s.used} aria-label={ar ? "رسائل الدردشة المستخدمة" : "Chat messages used"}>
        <div className={`h-full ${s.left > 0 ? "bg-ink" : "bg-lemon"}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2 text-sm text-ink/70">{period}</p>
      {pace && <p className="mt-1 text-sm text-ink/70">{pace}</p>}
      {(s.overflow.used > 0 || s.overflow.credits > 0) && <p className="mt-1 text-sm text-ink/70" data-chat-overflow-used="">{ar ? `${n(s.overflow.used)} رسالة إضافية هذا الشهر على الكريدت، خُصم عليها ${n(s.overflow.credits)} كريدت.` : `${n(s.overflow.used)} more this month, continued on credits: ${n(s.overflow.credits)} ${s.overflow.credits === 1 ? "credit" : "credits"} billed.`}</p>}

      {trial ? (
        <p className="mt-3 text-sm text-muted">{ar ? "بعد الاشتراك تتجدد رسائل خطتك كل شهر، ويمكن لمالك الحساب اختيار الإكمال على الكريدت عند نفادها." : "After you subscribe, your plan's messages renew every month, and the account owner can choose to continue on credits when they run out."}</p>
      ) : s.overflow.available && (
        <div className="mt-4 border-t border-ink/10 pt-4">
          <div className="flex items-start justify-between gap-6">
            <div>
              <h3 className="font-display font-medium">{ar ? "عند نفاد الرسائل" : "When messages run out"}</h3>
              <p className="mt-1 text-sm" data-chat-overflow={s.overflow.on ? "on" : "off"}>{state}</p>
            </div>
            {owner && (
              <button type="button" role="switch" aria-checked={s.overflow.on} aria-label={label} disabled={saving} onClick={() => toggle(!s.overflow.on)} className={`relative mt-1 h-6 w-11 shrink-0 rounded-full transition disabled:cursor-not-allowed disabled:opacity-60 ${s.overflow.on ? "bg-ink" : "bg-ink/20"}`}>
                <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${s.overflow.on ? "start-[22px]" : "start-0.5"}`} />
              </button>
            )}
          </div>
          <p className="mt-2 text-xs text-muted" data-chat-overflow-terms="">{ar
            ? `على الكريدت: تحتاج كل رسالة إضافية ${hold} كريدت على الأقل في رصيدك، وتُحسب بما كلّفته فعلاً، ${hold} كريدت على الأكثر. أجزاء الكريدت تُرحَّل إلى الرسالة التالية فلا يُقرَّب شيء للأعلى، والرسالة التي تتعثر لا يُخصم عليها شيء. إذا كان رصيدك أقل من ${hold} كريدت تتوقف الدردشة.`
            : `On credits, each extra message needs at least ${hold} credits in your balance and is billed what it actually cost, at most ${hold} credits. Parts of a credit carry over to the next message, so nothing is rounded up, and a message that fails is not billed. With fewer than ${hold} credits in your balance, chat pauses.`}</p>
          {!owner && <ReadOnlyNote text={ar ? "مالك الحساب يقرر ذلك." : "The account owner decides this."} />}
          {msg && <p role="status" className="mt-2 text-sm text-ink">{msg}</p>}
        </div>
      )}
    </section>
  );
}
