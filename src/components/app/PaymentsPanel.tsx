"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { adminFetch } from "@/lib/admin-fetch";
import { ksaDay, sarText } from "@/lib/partner-rules";
import { FIRST_MONTH_DISCOUNT_PCT, PLAN_PRICE_SAR, SELF_SERVE_PLANS, formatCount, type SelfServePlan } from "@/lib/pricing";

type Payment = {
  id: string; amountSar: number; plan: string; date: string; reference: string; recordedAt: string; recordedBy: string;
  offer?: "partner" | "early"; expectedSar?: number; commission?: { partner: string; sar: number }; notCounted?: string;
  voidedAt?: string; voidReason?: string;
  /** A top-up pack's payment, recorded by "Add top-up" (rule 454). */
  topup?: { lot: string; credits: number };
  /** The refund of the pack's unused credits, recorded by "Refund unused" in the Top-ups block (rule 460). */
  refund?: { credits: number; sar: number; date: string };
};
type View = {
  /** The account's live top-up packs: a top-up payment is voided with its pack while the pack is live (rule 455). */
  payments: Payment[]; livePacks?: string[]; firstPaidOn: string | null; open: boolean; until: string | null; expired: boolean; expected: Record<SelfServePlan, number> | null;
  offer: { kind: "partner" | "early"; usedAt?: string } | null;
  referredBy: { partner: string; code: string; at: string; via: string; status: string } | null;
};

const S = {
  en: {
    title: "Payments", note: "Record each plan payment received (SAR excluding VAT). It is the source of truth for partner commissions; it does not change the plan (set that above).",
    topupNote: "Top-ups: never record them here. \"Add top-up\" in the Top-ups block records the pack's payment and the partner's commission with the pack, and \"Void\" there voids both. \"Refund unused\" there records a refund of the pack's unused credits on its payment and lowers the commission in proportion. A top-up never uses the first-month offer, and the plan's first payment recorded here takes it even after a top-up. The partner's 4 months start at the plan's first payment (at the first top-up only while no plan payment is recorded).",
    topup: (n: string) => `top-up ${n}`, withPack: "void it with its pack (Top-ups)",
    offerOpen: (kind: string) => `Unused ${FIRST_MONTH_DISCOUNT_PCT}% first-month offer (${kind}). The plan's first payment recorded uses it. Expected first month:`,
    offerUsed: (kind: string) => `${FIRST_MONTH_DISCOUNT_PCT}% first-month offer (${kind}) used.`,
    until: (d: string) => `It can be used until ${d}.`,
    expired: (kind: string, d: string) => `${FIRST_MONTH_DISCOUNT_PCT}% first-month offer (${kind}) ended on ${d}: no longer shown to the customer. A payment dated on or before ${d} still uses it.`,
    kinds: { partner: "partner code", early: "early-partner offer" } as Record<string, string>,
    via: { link: "by link", code: "by code" } as Record<string, string>,
    statuses: { trial: "in its 30 days", paid: "paid in time", lapsed: "lapsed" } as Record<string, string>,
    reasons: { no_partner: "no partner", self: "self-referral", team: "same team", before_attribution: "paid before the referral", lapsed: "first payment after 30 days", window: "after the first 4 months", refunded: "refunded in full" } as Record<string, string>,
    refunded: (sar: string, credits: string, date: string) => `refunded ${sar} (${credits} unused credits) on ${date}`,
    partner: "Partner", none: "No payments recorded.", amount: "Amount SAR excl. VAT", plan: "Plan", date: "Date", reference: "Reference",
    record: "Record payment", void: "Void", voidReason: "Why is this payment voided (refund, mistake)?", voided: "voided", commission: "commission", notCounted: "not counted",
    failed: "Failed", loading: "Loading…",
  },
  ar: {
    title: "الدفعات", note: "سجّل كل دفعة اشتراك مستلمة (بالريال دون الضريبة). هي مصدر حساب عمولات الشركاء، ولا تغيّر الخطة (غيّرها من الأعلى).",
    topupNote: "باقات الشحن: لا تسجّلها هنا أبداً. «أضف باقة شحن» في قسم باقات الشحن يسجّل دفعة الباقة وعمولة الشريك مع الباقة، و«إلغاء» هناك يلغيهما معاً. و«استرداد غير المستخدم» هناك يسجّل على دفعة الباقة استرداد كريدتها غير المستخدم وينقص العمولة بالنسبة نفسها. باقة الشحن لا تستخدم عرض الشهر الأول، وأول دفعة للخطة تُسجَّل هنا تستخدمه ولو جاءت بعد باقة شحن. وتبدأ أشهر الشريك الأربعة من أول دفعة للخطة (ومن أول باقة شحن ما دامت لا دفعة خطة مسجّلة).",
    topup: (n: string) => `باقة شحن ${n}`, withPack: "تُلغى مع باقتها (باقات الشحن)",
    offerOpen: (kind: string) => `عرض خصم ${FIRST_MONTH_DISCOUNT_PCT}% على الشهر الأول غير مستخدم (${kind}). تستخدمه أول دفعة للخطة تُسجَّل. المتوقع للشهر الأول:`,
    offerUsed: (kind: string) => `استُخدم عرض خصم ${FIRST_MONTH_DISCOUNT_PCT}% على الشهر الأول (${kind}).`,
    until: (d: string) => `صالح حتى ${d}.`,
    expired: (kind: string, d: string) => `انتهى عرض خصم ${FIRST_MONTH_DISCOUNT_PCT}% على الشهر الأول (${kind}) في ${d}: لم يعد يظهر للعميل. الدفعة المؤرخة في ${d} أو قبله تستخدمه.`,
    kinds: { partner: "كود شريك", early: "عرض الشركاء الأوائل" } as Record<string, string>,
    via: { link: "عبر الرابط", code: "عبر الكود" } as Record<string, string>,
    statuses: { trial: "ضمن مهلة 30 يوماً", paid: "دفع في المهلة", lapsed: "انتهت المهلة" } as Record<string, string>,
    reasons: { no_partner: "لا شريك", self: "إحالة ذاتية", team: "الفريق نفسه", before_attribution: "دفع قبل الإحالة", lapsed: "أول دفعة بعد 30 يوماً", window: "بعد أول 4 أشهر", refunded: "استُردت كاملة" } as Record<string, string>,
    refunded: (sar: string, credits: string, date: string) => `استُرد ${sar} (${credits} كريدت غير مستخدم) في ${date}`,
    partner: "الشريك", none: "لا دفعات مسجلة.", amount: "المبلغ (ريال، دون الضريبة)", plan: "الخطة", date: "التاريخ", reference: "المرجع",
    record: "سجّل الدفعة", void: "إلغاء", voidReason: "لماذا تُلغى هذه الدفعة (استرداد، خطأ)؟", voided: "ملغاة", commission: "عمولة", notCounted: "لا تُحسب",
    failed: "فشل", loading: "جارٍ التحميل…",
  },
} as const;

/** A new payment id, `pay_` and 18 hex characters: the form's, and the console's "Add top-up" (rule 454). */
export const newPaymentId = () => `pay_${Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(16).padStart(2, "0")).join("")}`;

/**
 * Founder console, user card: "Record payment" and the account's payments (rules 396-397). The form keeps one payment
 * id until it succeeds, so pressing the button twice, or retrying after a timeout, records the payment once. Plan
 * payments only: a top-up's payment is recorded by "Add top-up" with its pack and shows here as "top-up N", voided with
 * the pack while the pack is live (rules 454-455). The console remounts the panel after a top-up changes (its `key`).
 */
export default function PaymentsPanel({ email, lang }: { email: string; lang: "ar" | "en" }) {
  const L = S[lang];
  const who = encodeURIComponent(email);
  const [view, setView] = useState<View | null>(null);
  const [msg, setMsg] = useState("");
  const [plan, setPlan] = useState<string>("starter");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => ksaDay());
  const [reference, setReference] = useState("");
  const [id, setId] = useState(newPaymentId);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    // Through adminFetch (rule 436): once the key session ends, a 401 shows the console's message, not an empty panel.
    const j = await adminFetch(`/api/admin/payments/${who}`).then((r) => r.json()).catch(() => ({}));
    if (j.ok) setView(j);
  }, [who]);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);
  const expected = useMemo(() => {
    if (!view) return null;
    if (view.open && view.expected && (SELF_SERVE_PLANS as readonly string[]).includes(plan)) return view.expected[plan as SelfServePlan];
    return (SELF_SERVE_PLANS as readonly string[]).includes(plan) ? PLAN_PRICE_SAR[plan as SelfServePlan] : null;
  }, [view, plan]);
  async function post(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const r = await adminFetch(`/api/admin/payments/${who}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      setMsg(j.ok ? `${String(body.action)} ✓` : `${L.failed}: ${j.error ?? r.status}`);
      if (j.ok) await load();
      return !!j.ok;
    } finally {
      setBusy(false);
    }
  }
  if (!view) return <p className="mt-4 text-xs text-ink/50">{L.loading}</p>;
  return (
    <section className="mt-4 rounded border border-ink/10 p-3 text-xs" data-payments>
      <p className="font-semibold">{L.title}</p>
      <p className="text-ink/60">{L.note}</p>
      {/* One entry point for a top-up's payment (rule 454): the Top-ups block, never this form. */}
      <p className="text-ink/60" data-topup-note>{L.topupNote}</p>
      {view.referredBy && <p className="mt-1">{L.partner}: <span className="font-mono">{view.referredBy.code}</span> · <span dir="ltr">{view.referredBy.partner}</span> · {L.via[view.referredBy.via] ?? view.referredBy.via} · <span dir="ltr">{view.referredBy.at.slice(0, 10)}</span> · {L.statuses[view.referredBy.status] ?? view.referredBy.status}</p>}
      {view.offer && (view.open
        ? <p className="mt-1 text-ink">{L.offerOpen(L.kinds[view.offer.kind] ?? view.offer.kind)} {view.expected ? SELF_SERVE_PLANS.map((k) => `${k} ${view.expected![k]}`).join(" · ") : ""}{view.until ? ` ${L.until(view.until)}` : ""}</p>
        : view.expired && view.until
          ? <p data-offer-expired className="mt-1 text-danger">{L.expired(L.kinds[view.offer.kind] ?? view.offer.kind, view.until)}</p>
          : <p className="mt-1 text-ink/60">{L.offerUsed(L.kinds[view.offer.kind] ?? view.offer.kind)}</p>)}
      <form onSubmit={async (e) => { e.preventDefault(); if (busy) return; if (await post({ action: "record", id, amountSar: Number(amount), plan, date, reference })) { setId(newPaymentId()); setAmount(""); setReference(""); } }} className="mt-2 flex flex-wrap items-end gap-2">
        <label className="grid gap-0.5"><span className="text-ink/60">{L.plan}</span>
          <select value={plan} onChange={(e) => setPlan(e.target.value)} className="input">{[...SELF_SERVE_PLANS, "agency"].map((p) => <option key={p} value={p}>{p}</option>)}</select>
        </label>
        <label className="grid gap-0.5"><span className="text-ink/60">{L.amount}</span><input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" dir="ltr" placeholder={expected !== null ? String(expected) : ""} className="input w-28" /></label>
        <label className="grid gap-0.5"><span className="text-ink/60">{L.date}</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="input" /></label>
        <label className="grid gap-0.5"><span className="text-ink/60">{L.reference}</span><input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={80} dir="auto" className="input w-40" /></label>
        <button disabled={busy || !amount} className="btn btn-primary btn-xs">{L.record}</button>
      </form>
      {msg && <p className="mt-1 text-ink">{msg}</p>}
      {view.payments.length === 0 ? <p className="mt-2 text-ink/60">{L.none}</p> : (
        <table className="mt-2 w-full font-mono">
          <tbody>{view.payments.map((p) => (
            <tr key={p.id} className={`border-t border-ink/5 ${p.voidedAt ? "text-ink/40" : ""}`}>
              <td className="p-1" dir="ltr">{p.date}</td><td className="p-1">{p.topup ? L.topup(formatCount(p.topup.credits)) : p.plan}</td><td className="p-1" dir="ltr">{sarText(p.amountSar)}{p.refund && <span className="block text-danger" dir="auto" data-payment-refund>{L.refunded(sarText(p.refund.sar), formatCount(p.refund.credits), p.refund.date)}</span>}</td>
              <td className="p-1">{p.offer ? `-${FIRST_MONTH_DISCOUNT_PCT}% ${L.kinds[p.offer] ?? p.offer}${p.expectedSar ? ` (${p.expectedSar})` : ""}` : ""}</td>
              <td className="p-1">{p.commission ? `${L.commission} ${sarText(p.commission.sar)}` : p.notCounted ? `${L.notCounted}: ${L.reasons[p.notCounted] ?? p.notCounted}` : ""}</td>
              <td className="p-1" dir="auto">{p.reference}</td>
              <td className="p-1">{p.voidedAt ? `${L.voided}${p.voidReason ? `: ${p.voidReason}` : ""}` : p.topup && view.livePacks?.includes(p.topup.lot) ? <span className="text-ink/50" data-void-with-pack>{L.withPack}</span> : <button disabled={busy} onClick={() => { const reason = prompt(L.voidReason); if (reason !== null) void post({ action: "void", id: p.id, reason }); }} className="text-danger underline">{L.void}</button>}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </section>
  );
}
