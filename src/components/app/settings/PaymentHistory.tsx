import type { Lang } from "@/lib/i18n";
import type { PaymentRow } from "@/lib/billing";
import { formatCount } from "@/lib/pricing";

const COPY = {
  ar: {
    title: "سجل المدفوعات", sub: "المدفوعات المسجّلة على حسابك. المبالغ بالريال قبل الضريبة.", empty: "لا توجد مدفوعات مسجّلة بعد.",
    date: "التاريخ", item: "البند", amount: "المبلغ", state: "الحالة", topup: (n: string) => `باقة شحن ${n} كريدت`, plan: (p: string) => `خطة ${p}، شهر`,
    paid: "مدفوعة", voided: "ملغاة", refunded: (n: string) => `استُرد ${n} ريال`,
  },
  en: {
    title: "Payment history", sub: "The payments recorded on your account. Amounts in SAR before VAT.", empty: "No payments recorded yet.",
    date: "Date", item: "Item", amount: "Amount", state: "Status", topup: (n: string) => `${n}-credit top-up pack`, plan: (p: string) => `${p} plan, one month`,
    paid: "Paid", voided: "Voided", refunded: (n: string) => `SAR ${n} refunded`,
  },
} as const;

/**
 * The owner's payment history on the billing page (rule 1156): the payments already recorded (`paymentHistory`), nothing
 * made up, no invoice. Western digits, dates as stored (YYYY-MM-DD), the state in words.
 */
export default function PaymentHistory({ lang, rows, planName }: { lang: Lang; rows: PaymentRow[]; planName: (plan: string) => string }) {
  const T = COPY[lang];
  return (
    <section className="mt-6 card" aria-labelledby="payment-history-title" data-payment-history="">
      <h2 id="payment-history-title" className="font-display text-lg font-bold">{T.title}</h2>
      <p className="mt-1 text-sm text-muted">{T.sub}</p>
      {rows.length === 0 ? <p className="mt-3 text-sm text-muted">{T.empty}</p> : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted"><tr>
              <th scope="col" className="py-1 text-start">{T.date}</th><th scope="col" className="text-start">{T.item}</th><th scope="col" className="text-end">{T.amount}</th><th scope="col" className="text-start ps-4">{T.state}</th>
            </tr></thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="border-t border-ink/5" data-payment-state={p.state}>
                  <td className="py-2 font-mono tnum" dir="ltr">{p.date}</td>
                  <td>{p.topupCredits !== null ? T.topup(formatCount(p.topupCredits)) : T.plan(planName(p.plan))}</td>
                  <td className="text-end font-mono tnum" dir="ltr">{formatCount(p.amountSar)}</td>
                  <td className="ps-4">{p.state === "voided" ? T.voided : p.state === "refunded" ? T.refunded(formatCount(p.refundSar ?? 0)) : T.paid}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
