"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Lang } from "@/lib/i18n";
import type { BillingView } from "@/lib/billing";
import { yearlyOffered } from "@/lib/pricing";
import { useConfirm } from "./ConfirmDialog";

const T = {
  ar: {
    pay: "ادفع بالبطاقة", busy: "…",
    errors: {
      need_phone: "أضف رقم جوالك في الملف الشخصي أولاً: بوابة الدفع تطلبه.", topup_needs_paid_plan: "باقات الشحن متاحة بعد الاشتراك في خطة مدفوعة.",
      agency: "خطة الوكالات بعقد، تواصل معنا.", slow_down: "محاولات كثيرة. حاول بعد ساعة.", not_enabled: "الدفع الإلكتروني غير متاح الآن.",
      paymob_error: "تعذّر فتح صفحة الدفع. حاول مرة أخرى.", forbidden: "الدفع لمالك الحساب فقط.", server: "تعذّر الطلب. حاول مرة أخرى.",
      no_card: "لا توجد بطاقة محفوظة. ادفع الشهر القادم بالبطاقة لحفظها.", no_billing: "لا يوجد اشتراك إلكتروني.",
      yearly_not_offered: "الدفع السنوي غير متاح لهذه الخطة.", yearly_active: "اشتراكك السنوي ما زال سارياً. يمكنك تغيير الخطة عند نهاية السنة المدفوعة، أو تواصل معنا.",
    } as Record<string, string>,
    yearly: "سنوي", renewYear: "ادفع السنة الآن",
    title: "اشتراكك", active: "نشط", past_due: "متأخر السداد", locked: "موقوف", paidThrough: "مدفوع حتى", grace: "مهلة السداد حتى",
    card: "البطاقة", noCard: "لا توجد بطاقة محفوظة", auto: "التجديد التلقائي", on: "مفعّل", off: "متوقف",
    cancel: "أوقف التجديد التلقائي", resume: "فعّل التجديد التلقائي", remove: "احذف البطاقة", renew: "ادفع الشهر الآن",
    lockedNote: "توقف حسابك لأن تجديد الاشتراك لم يُدفع. ادفع الشهر لتعود فوراً.",
    pastDueNote: "لم ينجح خصم التجديد. ادفع قبل نهاية المهلة حتى لا يتوقف حسابك.",
    cancelNote: "لن نخصم من بطاقتك. يبقى اشتراكك حتى نهاية الشهر المدفوع.",
    confirmCancelTitle: "إيقاف التجديد التلقائي؟", confirmCancel: "يبقى اشتراكك حتى نهاية الشهر المدفوع، ثم لن نخصم من بطاقتك: تدفع كل شهر بنفسك.",
    confirmRemoveTitle: "حذف البطاقة المحفوظة؟", confirmRemove: "يتوقف التجديد التلقائي معها، وتحتاج دفعة جديدة بالبطاقة لحفظ بطاقة أخرى.",
    keep: "تراجع", working: "يحفظ…",
    ret: {
      pending: "نتحقق من دفعتك…", plan: "وصلت دفعتك وتفعّل اشتراكك.", topup: "وصلت دفعتك وأُضيف الكريدت إلى رصيدك.",
      failed: "لم تكتمل الدفعة ولم يتغيّر اشتراكك. إن خُصم مبلغ من بطاقتك فتواصل معنا.", late: "لم يصلنا تأكيد الدفع بعد. حدّث الصفحة بعد دقيقة لترى حالته.",
    },
  },
  en: {
    pay: "Pay by card", busy: "…",
    errors: {
      need_phone: "Add your mobile number in your profile first: the payment gateway needs it.", topup_needs_paid_plan: "Top-up packs are available once you subscribe to a paid plan.",
      agency: "Agency is sold by contract: contact us.", slow_down: "Too many tries. Try again in an hour.", not_enabled: "Online payment is not available right now.",
      paymob_error: "Could not open the payment page. Try again.", forbidden: "Only the account owner can pay.", server: "Could not complete the request. Try again.",
      no_card: "No saved card. Pay the next month by card to save one.", no_billing: "No online subscription.",
      yearly_not_offered: "Yearly billing is not offered for this plan.", yearly_active: "Your yearly plan is still running. You can change plan when the paid year ends, or contact us.",
    } as Record<string, string>,
    yearly: "Yearly", renewYear: "Pay this year now",
    title: "Your subscription", active: "Active", past_due: "Payment overdue", locked: "Paused", paidThrough: "Paid through", grace: "Grace until",
    card: "Card", noCard: "No saved card", auto: "Automatic renewal", on: "On", off: "Off",
    cancel: "Turn off automatic renewal", resume: "Turn on automatic renewal", remove: "Remove card", renew: "Pay this month now",
    lockedNote: "Your account is paused because the renewal was not paid. Pay the month to continue right away.",
    pastDueNote: "The renewal charge did not go through. Pay before the grace period ends so your account is not paused.",
    cancelNote: "We will not charge your card. Your plan stays until the end of the paid month.",
    confirmCancelTitle: "Turn off automatic renewal?", confirmCancel: "Your plan stays until the end of the paid month; after that we will not charge your card, and you pay each month yourself.",
    confirmRemoveTitle: "Remove the saved card?", confirmRemove: "Automatic renewal stops with it, and saving another card takes a new card payment.",
    keep: "Go back", working: "Saving…",
    ret: {
      pending: "Checking your payment…", plan: "Your payment went through and your plan is active.", topup: "Your payment went through and the credits were added to your balance.",
      failed: "The payment was not completed and your plan did not change. If your card was charged, contact us.", late: "We have not received the payment confirmation yet. Refresh this page in a minute to see it.",
    },
  },
} as const;

async function post(url: string, body: unknown): Promise<{ ok?: boolean; error?: string; url?: string }> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; url?: string };
}

/**
 * Pay a plan period or a top-up pack online (POST /api/billing/checkout, rules 700-729): the server prices it and answers
 * Paymob's checkout page, where the browser goes next. Only rendered for the owner while Paymob is configured.
 * `interval="year"` (rule 3536) asks for the yearly price; without it the body is exactly the monthly one it always was.
 * The server refuses a year the founder has not priced, whatever this button sends.
 */
export function PaymobPayButton({ lang, kind, plan, credits, label, className, interval }: { lang: Lang; kind: "plan" | "topup"; plan?: string; credits?: number; label?: string; className?: string; interval?: "year" }) {
  const S = T[lang];
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function pay() {
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      const j = await post("/api/billing/checkout", kind === "plan" ? { kind, plan, lang, ...(interval ? { interval } : {}) } : { kind, credits, lang });
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
      <button type="button" onClick={pay} disabled={busy} data-paymob-pay={kind} data-paymob-interval={interval} className={className ?? "rounded-full bg-inverse px-4 py-2 text-center text-sm font-semibold text-inverse-muted"}>{busy ? S.busy : label ?? S.pay}</button>
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
  // Turning renewal off and removing the card ask first, in the app's own dialog (rule 974); resuming does not.
  const [ask, confirmDialog] = useConfirm();
  async function act(action: "cancel" | "resume" | "remove_card") {
    if (busy) return;
    if (action !== "resume") {
      // The dialog runs the change itself (rule 1157, B-9): its button turns busy, a refusal shows inside it, and it
      // closes only once the change is saved.
      const run = async () => {
        const j = await post("/api/billing/renewal", { action });
        if (!j.ok) return S.errors[j.error ?? "server"] ?? S.errors.server;
        r.refresh();
      };
      const common = { cancelLabel: S.keep, destructive: true, run, busyLabel: S.working, failLabel: S.errors.server };
      await ask(action === "cancel"
        ? { title: S.confirmCancelTitle, message: S.confirmCancel, confirmLabel: S.cancel, ...common }
        : { title: S.confirmRemoveTitle, message: S.confirmRemove, confirmLabel: S.remove, ...common });
      return;
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
        <div><dt className="text-foreground-muted">{S.title}</dt><dd className={b.status === "active" ? "font-medium" : "font-medium text-danger"}>{S[b.status]}</dd></div>
        <div><dt className="text-foreground-muted">{S.paidThrough}</dt><dd className="font-mono" dir="ltr">{b.paidThrough}</dd>{b.interval === "year" && <dd className="text-foreground-muted" data-paymob-yearly="">{S.yearly}</dd>}</div>
        <div><dt className="text-foreground-muted">{S.card}</dt><dd>{b.card ? <span dir="ltr">{b.card.brand} •••• {b.card.last4}</span> : S.noCard}</dd></div>
        <div><dt className="text-foreground-muted">{S.auto}</dt><dd>{b.autoRenew ? S.on : S.off}</dd></div>
      </dl>
      {b.status === "locked" && <p className="mt-3 text-danger" data-paymob-locked="">{S.lockedNote}</p>}
      {b.status === "past_due" && <p className="mt-3 text-danger">{S.pastDueNote}{b.graceUntil && <> ({S.grace} <span className="font-mono" dir="ltr">{b.graceUntil}</span>)</>}</p>}
      {b.status === "active" && !b.autoRenew && <p className="mt-3 text-foreground-muted">{S.cancelNote}</p>}
      {b.status !== "active" && (b.interval === "year" && yearlyOffered(b.plan)
        ? <PaymobPayButton lang={lang} kind="plan" plan={b.plan} interval="year" label={S.renewYear} />
        : <PaymobPayButton lang={lang} kind="plan" plan={b.plan} label={S.renew} />)}
      <div className="mt-4 flex flex-wrap gap-2">
        {b.autoRenew ? (
          <button type="button" disabled={busy} onClick={() => act("cancel")} className="min-h-[var(--hit-min)] rounded-full border border-border px-4 py-2" data-paymob-action="cancel">{S.cancel}</button>
        ) : b.card ? (
          <button type="button" disabled={busy} onClick={() => act("resume")} className="min-h-[var(--hit-min)] rounded-full border border-border px-4 py-2" data-paymob-action="resume">{S.resume}</button>
        ) : null}
        {b.card && <button type="button" disabled={busy} onClick={() => act("remove_card")} className="min-h-[var(--hit-min)] rounded-full border border-border px-4 py-2" data-paymob-action="remove_card">{S.remove}</button>}
      </div>
      {err && <p role="alert" className="mt-2 text-sm text-danger">{err}</p>}
      {confirmDialog}
    </section>
  );
}

/**
 * The page Paymob sends the owner back to (`?paymob=return`, rule 1155): asks GET /api/billing/status every few seconds
 * until the latest checkout is paid or failed, for about a minute, and says so in a live region. A paid checkout refreshes
 * the page once, so the plan, the balance and the subscription card show it. It reads only; the payment itself is applied
 * by Paymob's callback, never by this page.
 */
export function PaymobReturnStatus({ lang, every = 3000, tries = 20 }: { lang: Lang; every?: number; tries?: number }) {
  const S = T[lang].ret;
  const r = useRouter();
  const [text, setText] = useState<string>(S.pending);
  const [tone, setTone] = useState<"wait" | "ok" | "bad">("wait");
  useEffect(() => {
    // Per run of the effect, so a remount (React strict mode) starts its own polling and the old one stops.
    let done = false;
    let n = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = (t: string, k: "ok" | "bad") => { done = true; setText(t); setTone(k); };
    async function tick() {
      if (done) return;
      n += 1;
      const j = await fetch("/api/billing/status", { cache: "no-store" }).then((x) => x.json()).catch(() => null) as
        | { ok?: boolean; enabled?: boolean; checkout?: { state?: string; kind?: string } } | null;
      if (done) return;
      const state = j?.ok && j.enabled ? j.checkout?.state : undefined;
      if (state === "success") { stop(j?.checkout?.kind === "topup" ? S.topup : S.plan, "ok"); r.refresh(); return; }
      if (state === "failed") { stop(S.failed, "bad"); return; }
      // A dropped request (no answer) tries again like a pending one; an answer with no checkout to wait for stops.
      if (n >= tries || (j !== null && state !== "pending")) { stop(S.late, "bad"); return; }
      timer = setTimeout(() => { void tick(); }, every);
    }
    void tick();
    return () => { done = true; if (timer) clearTimeout(timer); };
  }, [S, every, tries, r]);
  return (
    <p role="status" aria-live="polite" className={`mt-4 card text-sm ${tone === "bad" ? "border-danger" : ""}`} data-paymob-return={tone}>{text}</p>
  );
}
