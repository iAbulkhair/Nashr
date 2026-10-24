import { EXTRA_SEAT_MONTHLY_SAR, includedSeats, monthlyTotal, paidExtraSeats, type Plan } from "@/lib/pricing";
import type { AgencyDeal } from "@/lib/pricing";

const COPY = {
  ar: {
    title: "المقاعد والمبلغ الشهري",
    included: "مقاعد مشمولة في الخطة",
    extra: "مقاعد إضافية مدفوعة",
    used: "مستخدمة الآن",
    unit: "سعر المقعد الإضافي",
    unitValue: (p: number) => `${p} ريال شهرياً + ضريبة القيمة المضافة`,
    plan: "الخطة",
    seats: "المقاعد الإضافية",
    vat: "ضريبة القيمة المضافة",
    total: "المجموع الشهري",
    note: "تضيف مقعداً من صفحة «الأعضاء» عند دعوة شخص والمقاعد ممتلئة. يُستخدم المقعد فوراً ويُحتسب من التجديد القادم. إن غادر شخص أو أُلغيت دعوة، يسقط المقعد من التجديد التالي دون استرداد عن الشهر الجاري.",
    sar: "ريال",
  },
  en: {
    title: "Seats and monthly total",
    included: "Seats included in the plan",
    extra: "Paid extra seats",
    used: "In use now",
    unit: "Price per extra seat",
    unitValue: (p: number) => `${p} SAR/month + VAT`,
    plan: "Plan",
    seats: "Extra seats",
    vat: "VAT",
    total: "Monthly total",
    note: "You add a seat on the Members page when you invite someone and every seat is in use. The seat works at once and is charged from your next renewal. When someone leaves or an invite is cancelled, the seat drops off at the following renewal, with no refund for the current month.",
    sar: "SAR",
  },
} as const;

const money = (halalas: number) => (halalas / 100).toFixed(2);

/**
 * The billing page's seats card (paid seats, rule 3365): included seats, paid extra seats, the price per extra seat and
 * the monthly total (plan + seats, VAT on the sum) at list price. Every number comes from src/lib/pricing.ts
 * (`EXTRA_SEAT_MONTHLY_SAR`, `monthlyTotal`); a price lock can lower what a renewal actually charges. A server component:
 * shown only for a plan that sells seats (the page decides).
 */
export default function SeatsBillingCard({ lang, user, used }: { lang: "ar" | "en"; user: { plan: Plan; seats?: number; extraSeats?: number; deal?: AgencyDeal | null }; used: number }) {
  const c = COPY[lang];
  const included = includedSeats(user);
  const extra = paidExtraSeats(user);
  const m = monthlyTotal(user);
  const rows: { key: string; label: string; value: string }[] = [
    { key: "included", label: c.included, value: String(included) },
    { key: "extra", label: c.extra, value: String(extra) },
    { key: "used", label: c.used, value: `${used} / ${included + extra}` },
    { key: "unit", label: c.unit, value: c.unitValue(EXTRA_SEAT_MONTHLY_SAR) },
  ];
  const lines: { key: string; label: string; halalas: number; strong?: boolean }[] = [
    { key: "plan", label: c.plan, halalas: m.planHalalas },
    { key: "seats", label: `${c.seats} (${extra} × ${EXTRA_SEAT_MONTHLY_SAR})`, halalas: m.seatsHalalas },
    { key: "vat", label: c.vat, halalas: m.vatHalalas },
    { key: "total", label: c.total, halalas: m.totalHalalas, strong: true },
  ];
  return (
    <section className="mt-6 card" aria-labelledby="seats-billing-title" data-seats-billing="">
      <h2 id="seats-billing-title" className="font-display text-lg font-bold">{c.title}</h2>
      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
        {rows.map((r) => (
          <div key={r.key} data-seats-row={r.key}>
            <dt className="text-foreground-muted">{r.label}</dt>
            <dd className="font-mono tnum" dir={r.key === "unit" ? "auto" : "ltr"}>{r.value}</dd>
          </div>
        ))}
      </dl>
      <dl className="mt-4 grid gap-1 border-t border-foreground/10 pt-3 text-sm">
        {lines.map((l) => (
          <div key={l.key} className={`flex items-center justify-between gap-3 ${l.strong ? "font-semibold" : ""}`} data-seats-line={l.key}>
            <dt className={l.strong ? "" : "text-foreground-muted"}>{l.label}</dt>
            <dd className="font-mono tnum" dir="ltr">{money(l.halalas)} {c.sar}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs text-foreground-muted">{c.note}</p>
    </section>
  );
}
