"use client";
import { useState } from "react";
import type { Lang } from "@/lib/i18n";
import type { ChatStatus } from "@/lib/chat-allowance";
import { runwayLine, type Runway } from "@/lib/usage-view";
import { formatCount } from "@/lib/pricing";
import ReadOnlyNote from "./ReadOnlyNote";
import Switch from "@/components/ui/Switch";
import Progress from "@/components/ui/Progress";
import { useToast } from "@/components/ui/Toast";

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
 * `overflow.hold` is the default model's. A conversation the owner set to a Premium model has its own, larger hold, which
 * the page fills in as `premiumHold` (`chatPremiumHold()`, rule 907); the card names it in one more line, only when it is
 * above `overflow.hold`.
 */
export default function ChatAllowanceCard({ lang, status, owner, nextReset, trialEnds, runway, credits, premiumHold }: {
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
  /** The hold of a conversation on a Premium model, from the server (rule 907); no line when it is not above `overflow.hold`. */
  premiumHold?: number;
}) {
  const ar = lang === "ar";
  const toast = useToast();
  const [s, setS] = useState(status);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const trial = s.period === "trial";
  const hold = formatCount(s.overflow.hold);
  const n = (v: number) => formatCount(v);
  const overflowOn = s.overflow.on && s.overflow.available;
  // The founder set this account's messages to 0 (`User.chatAllowance`): nothing renews, so no date is promised.
  const chatOff = s.allowance <= 0;
  const premium = typeof premiumHold === "number" && Number.isFinite(premiumHold) && premiumHold > s.overflow.hold ? formatCount(premiumHold) : null;
  const short = overflowOn && typeof credits === "number" && Number.isFinite(credits) && credits < s.overflow.hold;

  async function toggle(on: boolean) {
    setSaving(true);
    setMsg("");
    try {
      const res = await fetch("/api/billing/chat-overflow", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on }) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; chat?: ChatStatus };
      if (j.ok && j.chat) { setS(j.chat); toast.success(ar ? "تم الحفظ" : "Saved"); } // rule 2001
      else if (res.status === 403) setMsg(ar ? "مالك الحساب فقط يغيّر هذا." : "Only the account owner can change this.");
      else if (j.error === "trial") setMsg(ar ? "غير متاح في التجربة." : "Not available on a trial.");
      else if (j.error === "slow_down") setMsg(ar ? "تغييرات كثيرة. حاول بعد قليل." : "Too many changes. Try again shortly.");
      else toast.danger(ar ? "تعذّر الحفظ. حاول مرة أخرى." : "Could not save. Try again."); // permission and limits stay inline; a plain failure is a toast
    } catch {
      toast.danger(ar ? "تعذّر الحفظ. حاول مرة أخرى." : "Could not save. Try again.");
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
      <p className="mt-1 text-sm text-foreground-muted">{ar
        ? "الرسالة هي ما ترسله للفريق مرة واحدة، من التطبيق أو من تطبيق متصل، مهما طال الرد. الرسالة التي تتعثر لا تُحسب. توليد المنشورات والصور والفيديو من الدردشة يُخصم من الكريدت كالمعتاد."
        : "A message is one turn you send the team, in the app or from a connected app, however long the answer. A message that fails is not counted. Generating posts, images or videos from chat uses credits as usual."}</p>
      <div className="mt-3 flex items-center justify-between text-sm">
        <span>{trial ? (ar ? "المستخدم في التجربة" : "Used in your trial") : (ar ? "المستخدم هذا الشهر" : "Used this month")}</span>
        <span className="font-mono" dir="ltr" data-chat-used="">{n(s.used)} / {n(s.allowance)}</span>
      </div>
      <Progress className="mt-2" tone={s.left > 0 ? "default" : "warn"} value={s.used} max={s.allowance} label={ar ? "رسائل الدردشة المستخدمة" : "Chat messages used"} />
      <p className="mt-2 text-sm text-foreground-muted">{period}</p>
      {pace && <p className="mt-1 text-sm text-foreground-muted">{pace}</p>}
      {(s.overflow.used > 0 || s.overflow.credits > 0) && <p className="mt-1 text-sm text-foreground-muted" data-chat-overflow-used="">{ar ? `${n(s.overflow.used)} رسالة إضافية هذا الشهر على الكريدت، خُصم عليها ${n(s.overflow.credits)} كريدت.` : `${n(s.overflow.used)} more this month, continued on credits: ${n(s.overflow.credits)} ${s.overflow.credits === 1 ? "credit" : "credits"} billed.`}</p>}

      {trial ? (
        <p className="mt-3 text-sm text-foreground-muted">{ar ? "بعد الاشتراك تتجدد رسائل خطتك كل شهر، ويمكن لمالك الحساب اختيار الإكمال على الكريدت عند نفادها." : "After you subscribe, your plan's messages renew every month, and the account owner can choose to continue on credits when they run out."}</p>
      ) : s.overflow.available && (
        <div className="mt-4 border-t border-foreground/10 pt-4">
          <div className="flex items-start justify-between gap-6">
            <div>
              <h3 className="font-display font-medium">{ar ? "عند نفاد الرسائل" : "When messages run out"}</h3>
              <p className="mt-1 text-sm" data-chat-overflow={s.overflow.on ? "on" : "off"}>{state}</p>
            </div>
            {owner && (
              <Switch checked={s.overflow.on} label={label} disabled={saving} onChange={toggle} />
            )}
          </div>
          <p className="mt-2 text-xs text-foreground-muted" data-chat-overflow-terms="">{ar
            ? `على الكريدت: تحتاج كل رسالة إضافية ${hold} كريدت على الأقل في رصيدك، وتُحسب بما كلّفته فعلاً، ${hold} كريدت على الأكثر. أجزاء الكريدت تُرحَّل إلى الرسالة التالية فلا يُقرَّب شيء للأعلى، والرسالة التي تتعثر لا يُخصم عليها شيء. إذا كان رصيدك أقل من ${hold} كريدت تتوقف الدردشة.`
            : `On credits, each extra message needs at least ${hold} credits in your balance and is billed what it actually cost, at most ${hold} credits. Parts of a credit carry over to the next message, so nothing is rounded up, and a message that fails is not billed. With fewer than ${hold} credits in your balance, chat pauses.`}</p>
          {premium && (
            <p className="mt-1 text-xs text-foreground-muted" data-chat-overflow-premium="">{ar
              ? `في المحادثة التي تختار لها نموذجاً متقدّماً: تحتاج كل رسالة إضافية ${premium} كريدت على الأقل في رصيدك، وتُحسب بما كلّفته فعلاً، ${premium} كريدت على الأكثر.`
              : `In a conversation you set to a Premium model, each extra message needs at least ${premium} credits in your balance and is billed what it actually cost, at most ${premium} credits.`}</p>
          )}
          {!owner && <ReadOnlyNote text={ar ? "مالك الحساب يقرر ذلك." : "The account owner decides this."} />}
          {msg && <p role="status" className="mt-2 text-sm text-foreground">{msg}</p>}
        </div>
      )}
    </section>
  );
}
