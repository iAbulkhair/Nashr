"use client";
import { useCallback, useEffect, useState } from "react";
import { adminFetch } from "@/lib/admin-fetch";
import { useAdminForm } from "./AdminForm";
import { SELF_SERVE_PLANS } from "@/lib/pricing";
import Badge from "@/components/ui/Badge";
import { Time } from "@/components/ui/Time";
// Rules 2002 empty state, 2003 skeleton while the panel loads.
import { PanelSkeleton } from "@/components/ui/Skeleton";
import Callout from "@/components/ui/Callout";
import { STR } from "./shared";
import EmptyState from "@/components/ui/EmptyState";

type Seat = { at: string; by: string; endedAt: string | null } | null;
type Lock = { plan: string; sar: number; from: string; until: string; months: number; founding: boolean; endedAt: string | null } | null;
type Refund = { lastDay: string; inWindow: boolean; usedCredits: number; deductionHalalas: number; amountHalalas: number } | null;
type Row = { email: string; missing: boolean; inSeats: boolean; plan?: string; seat: Seat; lock: Lock; refund: Refund };
type View = {
  rules: { seats: number; lockAccounts: number; foundingMonths: number; laterMonths: number; saleStart: string; refundDays: number };
  paymentsOn: boolean; started: boolean; seats: { taken: number; left: number }; locks: { taken: number }; rows: Row[];
};
type Action = "grant_seat" | "end_seat" | "grant_lock" | "end_lock";

const S = {
  en: {
    title: "Founding seats and price locks",
    note: (v: View) => `${v.rules.seats} founding seats (lock ${v.rules.foundingMonths} months), then the first ${v.rules.lockAccounts} paying accounts (lock ${v.rules.laterMonths} months). Sale starts ${v.rules.saleStart} Riyadh. A seat is taken by a paid first month that asked for the offer. The refund proposal is a figure to check: the refund button stays the full refund.`,
    off: "Online payment is off: nothing is claimed automatically and the public counter is closed. Hand changes still work.",
    notStarted: "The sale has not started: nothing is claimed automatically yet.",
    seats: "Seats taken", left: "left", locks: "Accounts locked",
    email: "Email", seat: "Seat", lock: "Lock", refund: "7-day refund proposal", none: "No seats or locks yet.",
    ended: "ended", missing: "no account record", sar: "SAR",
    inWindow: (amount: string, used: number, last: string) => `${amount} SAR (credits used ${used}), until ${last}`,
    outWindow: (last: string) => `window ended ${last}`,
    actions: { grant_seat: "Grant seat", end_seat: "End seat", grant_lock: "Grant lock", end_lock: "End lock" } as Record<Action, string>,
    account: "Account email", plan: "Plan (lock)", planHint: "Empty: the subscription's plan", from: "First paid day (lock)", fromHint: "YYYY-MM-DD, empty: today",
    failed: "Failed", loading: "Loading…",
  },
  ar: {
    title: "المقاعد المؤسسة وتثبيت السعر",
    note: (v: View) => `${v.rules.seats} مقعداً مؤسساً (تثبيت ${v.rules.foundingMonths} شهراً)، ثم أول ${v.rules.lockAccounts} حساباً دافعاً (تثبيت ${v.rules.laterMonths} أشهر). يبدأ البيع ${v.rules.saleStart} بتوقيت الرياض. يُحجز المقعد عند دفع الشهر الأول بطلب العرض. مبلغ الاسترجاع المقترح رقم للمراجعة، وزر الاسترجاع يبقى استرجاعاً كاملاً.`,
    off: "الدفع الإلكتروني متوقف: لا يُحجز شيء تلقائياً والعدّاد العام مغلق. التعديل اليدوي يعمل.",
    notStarted: "لم يبدأ البيع بعد: لا يُحجز شيء تلقائياً.",
    seats: "المقاعد المحجوزة", left: "متبقٍ", locks: "الحسابات المثبّت سعرها",
    email: "البريد", seat: "المقعد", lock: "التثبيت", refund: "مقترح استرجاع 7 أيام", none: "لا مقاعد ولا تثبيت بعد.",
    ended: "منتهٍ", missing: "لا سجل حساب", sar: "ريال",
    inWindow: (amount: string, used: number, last: string) => `${amount} ريال (كريدت مستهلك ${used})، حتى ${last}`,
    outWindow: (last: string) => `انتهت المهلة ${last}`,
    actions: { grant_seat: "منح مقعد", end_seat: "إنهاء المقعد", grant_lock: "منح تثبيت", end_lock: "إنهاء التثبيت" } as Record<Action, string>,
    account: "بريد الحساب", plan: "الخطة (للتثبيت)", planHint: "فارغ: خطة الاشتراك", from: "يوم أول دفعة (للتثبيت)", fromHint: "YYYY-MM-DD، فارغ: اليوم",
    failed: "فشل", loading: "جارٍ التحميل…",
  },
} as const;

const sar = (halalas: number) => (halalas / 100).toFixed(2);

/**
 * Founder console, Billing: the founding seats and price locks (rules 1709-1710). Reads GET /api/admin/founding; every
 * hand change goes through the console's form (a reason, and the second factor through `adminFetch`) to POST.
 */
export default function FoundingPanel({ lang }: { lang: "ar" | "en" }) {
  const L = S[lang];
  const [askForm, formDialog] = useAdminForm(lang);
  const [view, setView] = useState<View | null>(null);
  const [msg, setMsg] = useState("");
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    const j = await adminFetch("/api/admin/founding").then((r) => r.json()).catch(() => ({}));
    if (j.ok) { setView(j); setFailed(false); } else setFailed(true);
  }, []);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  async function change(action: Action, email = "") {
    const lock = action === "grant_lock";
    const v = await askForm<{ email: string; plan?: string; from?: string }>({
      title: L.actions[action], subject: email || undefined, destructive: action.startsWith("end_"), submitLabel: L.actions[action],
      fields: [
        ...(email ? [] : [{ name: "email", label: L.account, ltr: true, maxLength: 200 }]),
        ...(lock ? [
          { name: "plan", label: L.plan, kind: "select" as const, initial: "", options: [{ value: "", label: L.planHint }, ...SELF_SERVE_PLANS.map((p) => ({ value: p, label: p }))] },
          { name: "from", label: L.from, ltr: true, hint: L.fromHint, maxLength: 10 },
        ] : []),
      ],
      parse: (f) => {
        const e = (email || f.email || "").trim();
        if (!/^[^\s@]+@[^\s@]+$/.test(e)) return { ok: false, error: "bad_email" };
        return { ok: true, value: { email: e, ...(lock ? { plan: f.plan || undefined, from: f.from?.trim() || undefined } : {}) } };
      },
    });
    if (!v) return;
    const r = await adminFetch("/api/admin/founding", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...v }) });
    const j = await r.json().catch(() => ({}));
    setMsg(j.ok ? `${L.actions[action]} ✓` : `${L.failed}: ${j.error ?? r.status}`);
    if (j.ok) await load();
  }

  if (!view) return <section className="card card-sm">{failed ? <Callout tone="danger">{STR[lang].loadFailed}</Callout> : <PanelSkeleton label={L.loading} shape="line" />}</section>;
  return (
    <section className="card card-sm text-xs" data-founding>
      {formDialog}
      <h2 className="font-semibold uppercase tracking-wide text-foreground-muted">{L.title}</h2>
      <p className="mt-1 text-foreground-muted">{L.note(view)}</p>
      {!view.paymentsOn ? <p className="mt-1 text-foreground">{L.off}</p> : !view.started && <p className="mt-1 text-foreground">{L.notStarted}</p>}
      <p className="mt-2">{L.seats}: <b className="tnum">{view.seats.taken}/{view.rules.seats}</b> ({L.left} <b className="tnum">{view.seats.left}</b>) · {L.locks}: <b className="tnum">{view.locks.taken}/{view.rules.lockAccounts}</b></p>
      <div className="mt-2 flex flex-wrap gap-2">
        {(["grant_seat", "grant_lock"] as const).map((a) => <button key={a} type="button" onClick={() => change(a)} className="btn btn-secondary btn-xs">{L.actions[a]}</button>)}
      </div>
      {msg && <p className="mt-1 text-foreground">{msg}</p>}
      {view.rows.length === 0 ? <EmptyState compact title={L.none} className="mt-2" /> : (
        <div className="overflow-x-auto">
          <table className="mt-2 w-full">
            <thead className="text-foreground-muted"><tr><th className="p-1 text-start">{L.email}</th><th className="p-1 text-start">{L.seat}</th><th className="p-1 text-start">{L.lock}</th><th className="p-1 text-start">{L.refund}</th><th /></tr></thead>
            <tbody>{view.rows.map((r) => (
              <tr key={r.email} className="border-t border-foreground/5">
                <td className="p-1 font-mono" dir="ltr">{r.email}{r.missing && <Badge tone="danger" className="ms-1">{L.missing}</Badge>}</td>
                <td className="p-1">{r.seat ? <><Time value={r.seat.at} lang={lang} /> <span dir="ltr">{r.seat.by}</span>{r.seat.endedAt ? ` · ${L.ended}` : ""}</> : r.inSeats ? "✓" : "—"}</td>
                <td className="p-1" dir="ltr">{r.lock ? `${r.lock.plan} ${r.lock.sar} ${L.sar} · ${r.lock.from} → ${r.lock.until} (${r.lock.months})${r.lock.endedAt ? ` · ${L.ended}` : ""}` : "—"}</td>
                <td className="p-1">{r.refund ? (r.refund.inWindow ? L.inWindow(sar(r.refund.amountHalalas), r.refund.usedCredits, r.refund.lastDay) : L.outWindow(r.refund.lastDay)) : "—"}</td>
                <td className="whitespace-nowrap p-1">
                  {r.seat && !r.seat.endedAt ? <button type="button" onClick={() => change("end_seat", r.email)} className="text-danger underline">{L.actions.end_seat}</button> : null}
                  {r.lock && !r.lock.endedAt ? <button type="button" onClick={() => change("end_lock", r.email)} className="ms-2 text-danger underline">{L.actions.end_lock}</button> : null}
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}
