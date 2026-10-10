"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Lang } from "@/lib/i18n";
import type { BillingView } from "@/lib/billing";
import { useConfirm } from "./ConfirmDialog";

const T = {
  ar: {
    pay: "ادفع بالبطاقة", busy: "…",
    errors: {
      need_phone: "أضف رقم جوالك في الملف الشخصي أولاً: بوابة الدفع تطلبه.", topup_needs_paid_plan: "باقات الشحن متاحة بعد الاشتراك في خطة مدفوعة.",
      agency: "خطة الوكالات بعقد، تواصل معنا.", slow_down: "محاولات كثيرة. حاول بعد ساعة.", not_enabled: "الدفع الإلكتروني غير متاح الآن.",
      paymob_error: "تعذّر فتح صفحة الدفع. حاول مرة أخرى.", forbidden: "الدفع لمالك الحساب فقط.", server: "تعذّر الطلب. حاول مرة أخرى.",
      no_card: "لا توجد بطاقة محفوظة. ادفع الشهر القادم بالبطاقة لحفظها.", no_billing: "لا يوجد اشتراك إلكتروني.",
    } as Record<string, string>,
    title: "اشتراكك", active: "نشط", past_due: "متأخر السداد", locked: "موقوف", paidThrough: "مدفوع حتى", grace: "مهلة السداد حتى",
    card: "البطاقة", noCard: "لا توجد بطاقة محفوظة", auto: "التجديد التلقائي", on: "مفعّل", off: "متوقف",
    cancel: "أوقف التجديد التلقائي", resume: "فعّل التجديد التلقائي", remove: "احذف البطاقة", renew: "ادفع الشهر الآن",
    lockedNote: "توقف حسابك لأن تجديد الاشتراك لم يُدفع. ادفع الشهر لتعود فوراً.",
    pastDueNote: "لم ينجح خصم التجديد. ادفع قبل نهاية المهلة حتى لا يتوقف حسابك.",
    cancelNote: "لن نخصم من بطاقتك. يبقى اشتراكك حتى نهاية الشهر المدفوع.",
    confirmCancelTitle: "إيقاف التجديد التلقائي؟", confirmCancel: "يبقى اشتراكك حتى نهاية الشهر المدفوع، ثم لن نخصم من بطاقتك: تدفع كل شهر بنفسك.",
    confirmRemoveTitle: "حذف البطاقة المحفوظة؟", confirmRemove: "يتوقف التجديد التلقائي معها، وتحتاج دفعة جديدة بالبطاقة لحفظ بطاقة أخرى.",
    keep: "تراجع",
  },
  en: {
    pay: "Pay by card", busy: "…",
    errors: {
      need_phone: "Add your mobile number in your profile first: the payment gateway needs it.", topup_needs_paid_plan: "Top-up packs are available once you subscribe to a paid plan.",
      agency: "Agency is sold by contract: contact us.", slow_down: "Too many tries. Try again in an hour.", not_enabled: "Online payment is not available right now.",
      paymob_error: "Could not open the payment page. Try again.", forbidden: "Only the account owner can pay.", server: "Could not complete the request. Try again.",
      no_card: "No saved card. Pay the next month by card to save one.", no_billing: "No online subscription.",
    } as Record<string, string>,
    title: "Your subscription", active: "Active", past_due: "Payment overdue", locked: "Paused", paidThrough: "Paid through", grace: "Grace until",
    card: "Card", noCard: "No saved card", auto: "Automatic renewal", on: "On", off: "Off",
    cancel: "Turn off automatic renewal", resume: "Turn on automatic renewal", remove: "Remove card", renew: "Pay this month now",
    lockedNote: "Your account is paused because the renewal was not paid. Pay the month to continue right away.",
    pastDueNote: "The renewal charge did not go through. Pay before the grace period ends so your account is not paused.",
    cancelNote: "We will not charge your card. Your plan stays until the end of the paid month.",
    confirmCancelTitle: "Turn off automatic renewal?", confirmCancel: "Your plan stays until the end of the paid month; after that we will not charge your card, and you pay each month yourself.",
    confirmRemoveTitle: "Remove the saved card?", confirmRemove: "Automatic renewal stops with it, and saving another card takes a new card payment.",
    keep: "Go back",
  },
} as const;

async function post(url: string, body: unknown): Promise<{ ok?: boolean; error?: string; url?: string }> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; url?: string };
}

/**
 * Pay a plan month or a top-up pack online (POST /api/billing/checkout, rules 700-729): the server prices it and answers
 * Paymob's checkout page, where the browser goes next. Only rendered for the owner while Paymob is configured.
 */
export function PaymobPayButton({ lang, kind, plan, credits, label, className }: { lang: Lang; kind: "plan" | "topup"; plan?: string; credits?: number; label?: string; className?: string }) {
  const S = T[lang];
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function pay() {
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      const j = await post("/api/billing/checkout", kind === "plan" ? { kind, plan, lang } : { kind, credits, lang });
      if (j.ok && typeof j.url === "string" && j.url.startsWith("https://")) {
        window.location.assign(j.url);
        return;
      }
      setErr(S.errors[j.error ?? "server"] ?? S.errors.server);
    } catch {
      setErr(S.errors.server);
    }
    setBusy(false);
  }
  return (
    <div className="mt-4 grid gap-1">
      <button type="button" onClick={pay} disabled={busy} data-paymob-pay={kind} className={className ?? "rounded-full bg-ink px-4 py-2 text-center text-sm font-semibold text-lilac"}>{busy ? S.busy : label ?? S.pay}</button>
      {err && <p role="alert" className="text-xs text-danger">{err}</p>}
    </div>
  );
}

/** The owner's view of the online subscription (rules 710-716): its state, the saved card, and the renewal settings. */
export function PaymobPlanCard({ lang, billing }: { lang: Lang; billing: BillingView }) {
  const S = T[lang];
  const r = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // Turning renewal off and removing the card ask first, in the app's own dialog (rule 970); resuming does not.
  const [ask, confirmDialog] = useConfirm();
  async function act(action: "cancel" | "resume" | "remove_card") {
    if (busy) return;
    if (action !== "resume") {
      const sure = await ask(action === "cancel"
        ? { title: S.confirmCancelTitle, message: S.confirmCancel, confirmLabel: S.cancel, cancelLabel: S.keep, destructive: true }
        : { title: S.confirmRemoveTitle, message: S.confirmRemove, confirmLabel: S.remove, cancelLabel: S.keep, destructive: true });
      if (!sure) return;
    }
    setBusy(true);
    setErr("");
    try {
      const j = await post("/api/billing/renewal", { action });
      if (!j.ok) setErr(S.errors[j.error ?? "server"] ?? S.errors.server);
      else r.refresh();
    } catch {
      setErr(S.errors.server);
    } finally {
      setBusy(false);
    }
  }
  const b = billing;
  return (
    <section className="mt-6 card text-sm" data-paymob-plan={b.status} aria-labelledby="paymob-plan-title">
      <h2 id="paymob-plan-title" className="font-display text-lg font-bold">{S.title}</h2>
      <dl className="mt-3 grid gap-3 sm:grid-cols-4">
        <div><dt className="text-muted">{S.title}</dt><dd className={b.status === "active" ? "font-medium" : "font-medium text-danger"}>{S[b.status]}</dd></div>
        <div><dt className="text-muted">{S.paidThrough}</dt><dd className="font-mono" dir="ltr">{b.paidThrough}</dd></div>
        <div><dt className="text-muted">{S.card}</dt><dd>{b.card ? <span dir="ltr">{b.card.brand} •••• {b.card.last4}</span> : S.noCard}</dd></div>
        <div><dt className="text-muted">{S.auto}</dt><dd>{b.autoRenew ? S.on : S.off}</dd></div>
      </dl>
      {b.status === "locked" && <p className="mt-3 text-danger" data-paymob-locked="">{S.lockedNote}</p>}
      {b.status === "past_due" && <p className="mt-3 text-danger">{S.pastDueNote}{b.graceUntil && <> ({S.grace} <span className="font-mono" dir="ltr">{b.graceUntil}</span>)</>}</p>}
      {b.status === "active" && !b.autoRenew && <p className="mt-3 text-muted">{S.cancelNote}</p>}
      {b.status !== "active" && <PaymobPayButton lang={lang} kind="plan" plan={b.plan} label={S.renew} />}
      <div className="mt-4 flex flex-wrap gap-2">
        {b.autoRenew ? (
          <button type="button" disabled={busy} onClick={() => act("cancel")} className="rounded-full border border-ink/20 px-4 py-2" data-paymob-action="cancel">{S.cancel}</button>
        ) : b.card ? (
          <button type="button" disabled={busy} onClick={() => act("resume")} className="rounded-full border border-ink/20 px-4 py-2" data-paymob-action="resume">{S.resume}</button>
        ) : null}
        {b.card && <button type="button" disabled={busy} onClick={() => act("remove_card")} className="rounded-full border border-ink/20 px-4 py-2" data-paymob-action="remove_card">{S.remove}</button>}
      </div>
      {err && <p role="alert" className="mt-2 text-sm text-danger">{err}</p>}
      {confirmDialog}
    </section>
  );
}
