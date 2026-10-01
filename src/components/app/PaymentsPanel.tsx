"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ksaDay, sarText } from "@/lib/partner-rules";
import { FIRST_MONTH_DISCOUNT_PCT, PLAN_PRICE_SAR, SELF_SERVE_PLANS, type SelfServePlan } from "@/lib/pricing";

type Payment = {
  id: string; amountSar: number; plan: string; date: string; reference: string; recordedAt: string; recordedBy: string;
  offer?: "partner" | "early"; expectedSar?: number; commission?: { partner: string; sar: number }; notCounted?: string;
  voidedAt?: string; voidReason?: string;
};
type View = {
  payments: Payment[]; firstPaidOn: string | null; open: boolean; expected: Record<SelfServePlan, number> | null;
  offer: { kind: "partner" | "early"; usedAt?: string } | null;
  referredBy: { partner: string; code: string; at: string; via: string; status: string } | null;
};

const S = {
  en: {
    title: "Payments", note: "Record each payment received (SAR excluding VAT). It is the source of truth for partner commissions; it does not change the plan (set that above).",
    offerOpen: (kind: string) => `Unused ${FIRST_MONTH_DISCOUNT_PCT}% first-month offer (${kind}). The first payment recorded uses it. Expected first month:`,
    offerUsed: (kind: string) => `${FIRST_MONTH_DISCOUNT_PCT}% first-month offer (${kind}) used.`,
    kinds: { partner: "partner code", early: "early-partner offer" } as Record<string, string>,
    via: { link: "by link", code: "by code" } as Record<string, string>,
    statuses: { trial: "in its 30 days", paid: "paid in time", lapsed: "lapsed" } as Record<string, string>,
    reasons: { no_partner: "no partner", self: "self-referral", team: "same team", before_attribution: "paid before the referral", lapsed: "first payment after 30 days", window: "after the first 4 months" } as Record<string, string>,
    partner: "Partner", none: "No payments recorded.", amount: "Amount SAR excl. VAT", plan: "Plan", date: "Date", reference: "Reference",
    record: "Record payment", void: "Void", voidReason: "Why is this payment voided (refund, mistake)?", voided: "voided", commission: "commission", notCounted: "not counted",
    failed: "Failed", loading: "Loading…",
  },
  ar: {
    title: "الدفعات", note: "سجّل كل دفعة مستلمة (بالريال دون الضريبة). هي مصدر حساب عمولات الشركاء، ولا تغيّر الخطة (غيّرها من الأعلى).",
    offerOpen: (kind: string) => `عرض خصم ${FIRST_MONTH_DISCOUNT_PCT}% على الشهر الأول غير مستخدم (${kind}). تستخدمه أول دفعة تُسجَّل. المتوقع للشهر الأول:`,
    offerUsed: (kind: string) => `استُخدم عرض خصم ${FIRST_MONTH_DISCOUNT_PCT}% على الشهر الأول (${kind}).`,
    kinds: { partner: "كود شريك", early: "عرض الشركاء الأوائل" } as Record<string, string>,
    via: { link: "عبر الرابط", code: "عبر الكود" } as Record<string, string>,
    statuses: { trial: "ضمن مهلة 30 يوماً", paid: "دفع في المهلة", lapsed: "انتهت المهلة" } as Record<string, string>,
    reasons: { no_partner: "لا شريك", self: "إحالة ذاتية", team: "الفريق نفسه", before_attribution: "دفع قبل الإحالة", lapsed: "أول دفعة بعد 30 يوماً", window: "بعد أول 4 أشهر" } as Record<string, string>,
    partner: "الشريك", none: "لا دفعات مسجلة.", amount: "المبلغ (ريال، دون الضريبة)", plan: "الخطة", date: "التاريخ", reference: "المرجع",
    record: "سجّل الدفعة", void: "إلغاء", voidReason: "لماذا تُلغى هذه الدفعة (استرداد، خطأ)؟", voided: "ملغاة", commission: "عمولة", notCounted: "لا تُحسب",
    failed: "فشل", loading: "جارٍ التحميل…",
  },
} as const;

const newPaymentId = () => `pay_${Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(16).padStart(2, "0")).join("")}`;

/**
 * Founder console, user card: "Record payment" and the account's payments (rules 396-397). The form keeps one payment
 * id until it succeeds, so pressing the button twice, or retrying after a timeout, records the payment once.
 */
export default function PaymentsPanel({ email, lang }: { email: string; lang: "ar" | "en" }) {
  const L = S[lang];
  const url = `/api/admin/payments/${encodeURIComponent(email)}`;
  const [view, setView] = useState<View | null>(null);
  const [msg, setMsg] = useState("");
  const [plan, setPlan] = useState<string>("starter");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => ksaDay());
  const [reference, setReference] = useState("");
  const [id, setId] = useState(newPaymentId);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const j = await fetch(url).then((r) => r.json()).catch(() => ({}));
    if (j.ok) setView(j);
  }, [url]);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);
  const expected = useMemo(() => {
    if (!view) return null;
    if (view.open && view.expected && (SELF_SERVE_PLANS as readonly string[]).includes(plan)) return view.expected[plan as SelfServePlan];
    return (SELF_SERVE_PLANS as readonly string[]).includes(plan) ? PLAN_PRICE_SAR[plan as SelfServePlan] : null;
  }, [view, plan]);
  async function post(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
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
      {view.referredBy && <p className="mt-1">{L.partner}: <span className="font-mono">{view.referredBy.code}</span> · <span dir="ltr">{view.referredBy.partner}</span> · {L.via[view.referredBy.via] ?? view.referredBy.via} · <span dir="ltr">{view.referredBy.at.slice(0, 10)}</span> · {L.statuses[view.referredBy.status] ?? view.referredBy.status}</p>}
      {view.offer && (view.open
        ? <p className="mt-1 text-oasis">{L.offerOpen(L.kinds[view.offer.kind] ?? view.offer.kind)} {view.expected ? SELF_SERVE_PLANS.map((k) => `${k} ${view.expected![k]}`).join(" · ") : ""}</p>
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
      {msg && <p className="mt-1 text-oasis">{msg}</p>}
      {view.payments.length === 0 ? <p className="mt-2 text-ink/60">{L.none}</p> : (
        <table className="mt-2 w-full font-mono">
          <tbody>{view.payments.map((p) => (
            <tr key={p.id} className={`border-t border-ink/5 ${p.voidedAt ? "text-ink/40" : ""}`}>
              <td className="p-1" dir="ltr">{p.date}</td><td className="p-1">{p.plan}</td><td className="p-1" dir="ltr">{sarText(p.amountSar)}</td>
              <td className="p-1">{p.offer ? `-${FIRST_MONTH_DISCOUNT_PCT}% ${L.kinds[p.offer] ?? p.offer}${p.expectedSar ? ` (${p.expectedSar})` : ""}` : ""}</td>
              <td className="p-1">{p.commission ? `${L.commission} ${sarText(p.commission.sar)}` : p.notCounted ? `${L.notCounted}: ${L.reasons[p.notCounted] ?? p.notCounted}` : ""}</td>
              <td className="p-1" dir="auto">{p.reference}</td>
              <td className="p-1">{p.voidedAt ? `${L.voided}${p.voidReason ? `: ${p.voidReason}` : ""}` : <button disabled={busy} onClick={() => { const reason = prompt(L.voidReason); if (reason !== null) void post({ action: "void", id: p.id, reason }); }} className="text-sadu underline">{L.void}</button>}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </section>
  );
}
