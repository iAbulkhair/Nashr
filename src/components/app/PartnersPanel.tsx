"use client";
import { useCallback, useEffect, useState } from "react";
import { adminFetch } from "@/lib/admin-fetch";
import { NEW_TERMS_FROM, PAYOUT_MIN_SAR, codeProblem, countryName, ksaDay, normalizeCode, sarText, taxField, type Bank, type Commission, type Payout } from "@/lib/partner-rules";

type App = { id: string; name: string; email: string; phone: string; channel: string; audience: string; lang: string; at: string; consentAt: string | null; termsVersion: string | null; suggested: string; decision: { status: "approved" | "rejected"; code?: string; at: string; by: string } | null };
type PartnerRow = {
  email: string; name: string; code: string; approvedAt: string; bank: Bank | null; bankConfirmed: boolean; accountAfterApproval: boolean; hasAccount: boolean;
  terms: { at: string; version: string; via: "application" | "founder"; by?: string } | null;
  referrals: number; earned: number; paid: number; balance: number; pending: number; payable: number;
  tax: { vatRegistered: boolean; outsideSaudi: boolean; noCountry: boolean; vatPaid: number; whtBorne: number };
  commissions: (Commission & { customer: string | null })[]; payouts: Payout[];
};

const S = {
  en: {
    apps: "Applications", appsNote: "From the public partner page. Approving claims the code and links it to the applicant's email; if they have no account yet, they sign up with that email and the partner page appears.",
    none: "No applications waiting.", decided: "Decided", code: "Code", approve: "Approve", reject: "Reject", approved: "approved", rejected: "rejected",
    oldTerms: "Sent under the old terms (25% recurring, 60 days). Tell the applicant the new terms before approving: 15% of each payment for the first 4 months, 30 days, SAR 200 minimum.",
    partners: "Partners", noPartners: "No partners yet.", referrals: "Referrals", earned: "Earned", paidOut: "Paid", balance: "Balance", payable: "Payable",
    bank: "Bank", noBank: "no bank details yet", payout: "Mark payout paid", amount: "Commission SAR", date: "Date", reference: "Transfer reference",
    vat: "VAT paid on top SAR (optional)", wht: "Withholding tax borne SAR (optional)", vatCol: "VAT", whtCol: "Withholding",
    payoutNote: `Only a payable balance (SAR ${PAYOUT_MIN_SAR} or more) can be paid down, never past it, and only to confirmed bank details. The partner receives the full commission: VAT paid on top and withholding tax borne are Thakeen's costs, recorded for the books, and do not change the balance. Enter the amounts actually paid.`, commissions: "Commissions", payouts: "Payouts",
    flagVat: "VAT-registered: add VAT on payout", flagWht: "Outside Saudi Arabia: withholding tax may apply — ask your accountant", flagNoCountry: "Country not given: ask the partner to save their details again",
    country: "Country", taxNumber: "Tax no.", taxTotals: (vat: string, wht: string) => `VAT paid on top: SAR ${vat} · withholding borne: SAR ${wht}`,
    consent: (v: string, d: string) => `Agreed to the terms (version ${v}) on ${d}`, noConsent: "No terms consent recorded: sent before the form asked for it. Send the applicant the terms page before approving.",
    outOfBand: "The applicant agreed to the terms outside the form (I sent them the terms page)",
    consentByFounder: (v: string, d: string, by: string) => `Agreement to the terms (version ${v}) recorded by ${by} on ${d}, outside the form`,
    partnerNoConsent: "No agreement to the terms recorded: the partner never accepted the rules that cancel a commission. Get their agreement before paying.",
    customer: "Customer", paymentDate: "Payment date", base: "Base SAR", commission: "Commission SAR", voided: "voided",
    manual: "Approve by email (no application)", name: "Name", email: "Email", loading: "Loading…", failed: "Failed", show: "Details", hide: "Hide", done: "Done",
    unconfirmed: (d: string) => `Unconfirmed: saved or changed on ${d}. Check the holder and IBAN with the partner by phone (the number on the application) before transferring.`,
    confirm: "I checked these details with the partner", confirmedOn: (d: string) => `confirmed ${d}`,
    lateAccount: "This account was created after the approval: whoever signed up first with this email holds it. Confirm the person before paying.",
    noAccount: "No account yet: the applicant signs up with this email.",
    voidPayout: "Void", voidPayoutReason: "Why is this payout voided (entered by mistake, transfer returned)?",
    deleted: "deleted account",
    codeErrors: { bad_code: "3 to 16 letters A-Z or digits.", reserved_code: "A reserved word: choose another code." } as Record<string, string>,
    errors: {
      no_consent: "No agreement to the terms on record: tick that the applicant agreed outside the form, or ask them to apply through the form.",
      code_taken: "That code is taken.", already_partner: "This email is already a partner.", member_login: "A team member login cannot be a partner.", bad_email: "Not a valid email.",
      bad_code: "3 to 16 letters A-Z or digits.", reserved_code: "A reserved word: choose another code.", below_minimum: `The balance is below SAR ${PAYOUT_MIN_SAR}.`,
      over_balance: "More than the payable balance.", bad_amount: "Enter an amount.", bad_vat: "VAT: a positive amount with at most two decimals, or empty.", bad_wht: "Withholding: a positive amount with at most two decimals, or empty.", bad_date: "A past or today's date.", bank_unconfirmed: "Confirm the bank details first.",
      changed: "The bank details changed since you loaded them. Reload and check again.", no_bank: "No bank details yet.", not_found: "Not found.",
    } as Record<string, string>,
  },
  ar: {
    apps: "طلبات الشراكة", appsNote: "من صفحة الشركاء العامة. الموافقة تحجز الكود وتربطه ببريد المتقدم؛ إن لم يكن لديه حساب يسجّل بهذا البريد فتظهر له صفحة الشراكة.",
    none: "لا طلبات بانتظار المراجعة.", decided: "طلبات تمت مراجعتها", code: "الكود", approve: "وافق", reject: "ارفض", approved: "مقبول", rejected: "مرفوض",
    oldTerms: "قُدّم بالشروط القديمة (25% متكررة، 60 يوماً). أبلغ المتقدم بالشروط الجديدة قبل الموافقة: 15% من كل دفعة لأول 4 أشهر، 30 يوماً، حد أدنى 200 ريال.",
    partners: "الشركاء", noPartners: "لا شركاء بعد.", referrals: "الإحالات", earned: "المكتسب", paidOut: "المدفوع", balance: "الرصيد", payable: "جاهز للصرف",
    bank: "البنك", noBank: "لا بيانات بنكية بعد", payout: "سجّل تحويلاً مدفوعاً", amount: "العمولة (ريال)", date: "التاريخ", reference: "مرجع التحويل",
    vat: "ضريبة القيمة المضافة المدفوعة فوقها (ريال، اختياري)", wht: "ضريبة الاستقطاع التي تحمّلناها (ريال، اختياري)", vatCol: "ض. القيمة المضافة", whtCol: "الاستقطاع",
    payoutNote: `يُصرف الرصيد الجاهز فقط (${PAYOUT_MIN_SAR} ريال فأكثر) ولا يتجاوزه، وإلى بيانات بنكية مؤكدة فقط. تصل الشريكَ عمولتُه كاملة: ضريبة القيمة المضافة المدفوعة فوقها وضريبة الاستقطاع تكاليف على ذكين تُسجَّل للدفاتر ولا تغيّر الرصيد. أدخل المبالغ المدفوعة فعلاً.`, commissions: "العمولات", payouts: "التحويلات",
    flagVat: "مسجّل في ضريبة القيمة المضافة: أضف الضريبة على التحويل", flagWht: "خارج السعودية: قد تنطبق ضريبة الاستقطاع — اسأل محاسبك", flagNoCountry: "الدولة غير مذكورة: اطلب من الشريك حفظ بياناته مجدداً",
    country: "الدولة", taxNumber: "الرقم الضريبي", taxTotals: (vat: string, wht: string) => `ضريبة القيمة المضافة المدفوعة: ${vat} ريال · الاستقطاع المتحمَّل: ${wht} ريال`,
    consent: (v: string, d: string) => `وافق على الشروط (الإصدار ${v}) في ${d}`, noConsent: "لا موافقة مسجلة على الشروط: أُرسل قبل أن يطلبها النموذج. أرسل للمتقدم صفحة الشروط قبل الموافقة.",
    outOfBand: "وافق المتقدم على الشروط خارج النموذج (أرسلت له صفحة الشروط)",
    consentByFounder: (v: string, d: string, by: string) => `موافقة على الشروط (الإصدار ${v}) سجّلها ${by} في ${d}، خارج النموذج`,
    partnerNoConsent: "لا موافقة مسجلة على الشروط: لم يقبل الشريك القواعد التي تُلغى بها العمولة. احصل على موافقته قبل الصرف.",
    customer: "العميل", paymentDate: "تاريخ الدفعة", base: "الدفعة (ريال)", commission: "العمولة (ريال)", voided: "ملغاة",
    manual: "موافقة ببريد مباشرة (بلا طلب)", name: "الاسم", email: "البريد", loading: "جارٍ التحميل…", failed: "فشل", show: "التفاصيل", hide: "إخفاء", done: "تم",
    unconfirmed: (d: string) => `غير مؤكدة: حُفظت أو تغيّرت في ${d}. تحقّق من الاسم والآيبان مع الشريك هاتفياً (الرقم في طلبه) قبل التحويل.`,
    confirm: "تحققت من البيانات مع الشريك", confirmedOn: (d: string) => `مؤكدة ${d}`,
    lateAccount: "أُنشئ هذا الحساب بعد الموافقة: يملكه أول من سجّل بهذا البريد. تأكد من هوية الشخص قبل الصرف.",
    noAccount: "لا حساب بعد: يسجّل المتقدم بهذا البريد.",
    voidPayout: "إلغاء", voidPayoutReason: "لماذا يُلغى هذا التحويل (أُدخل خطأً، أُعيد التحويل)؟",
    deleted: "حساب محذوف",
    codeErrors: { bad_code: "من 3 إلى 16 حرفاً لاتينياً أو رقماً.", reserved_code: "كلمة محجوزة: اختر كوداً آخر." } as Record<string, string>,
    errors: {
      no_consent: "لا موافقة مسجلة على الشروط: أشِر إلى أن المتقدم وافق خارج النموذج، أو اطلب منه التقديم عبر النموذج.",
      code_taken: "الكود مستخدم.", already_partner: "هذا البريد شريك بالفعل.", member_login: "دخول عضو فريق لا يكون شريكاً.", bad_email: "بريد غير صحيح.",
      bad_code: "من 3 إلى 16 حرفاً لاتينياً أو رقماً.", reserved_code: "كلمة محجوزة: اختر كوداً آخر.", below_minimum: `الرصيد أقل من ${PAYOUT_MIN_SAR} ريال.`,
      over_balance: "أكثر من الرصيد الجاهز.", bad_amount: "اكتب المبلغ.", bad_vat: "ضريبة القيمة المضافة: مبلغ موجب بخانتين عشريتين على الأكثر، أو اتركها فارغة.", bad_wht: "الاستقطاع: مبلغ موجب بخانتين عشريتين على الأكثر، أو اتركه فارغاً.", bad_date: "تاريخ اليوم أو قبله.", bank_unconfirmed: "أكّد البيانات البنكية أولاً.",
      changed: "تغيّرت البيانات البنكية منذ فتحت الصفحة. أعد التحميل وتحقق مجدداً.", no_bank: "لا بيانات بنكية بعد.", not_found: "غير موجود.",
    } as Record<string, string>,
  },
} as const;
type L = (typeof S)["en" | "ar"];
type Act = (body: Record<string, unknown>) => Promise<boolean>;

const newPayoutId = () => `po_${Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(16).padStart(2, "0")).join("")}`;

/** One application: the founder edits the suggested code, then approves or rejects. */
function AppRow({ a, L, onAct }: { a: App; L: L; onAct: Act }) {
  const [code, setCode] = useState(a.suggested);
  const [outOfBand, setOutOfBand] = useState(false);
  const bad = codeProblem(normalizeCode(code));
  const consented = !!(a.consentAt && a.termsVersion);
  return (
    <tr className="border-t border-ink/5 align-top">
      <td className="p-1"><p>{a.name}</p><p className="text-muted" dir="ltr">{a.email}</p><p className="text-muted" dir="ltr">{a.phone}</p></td>
      <td className="p-1"><p>{a.channel}</p><p className="text-muted">{a.audience}</p></td>
      <td className="tnum p-1" dir="ltr">
        {a.at.slice(0, 10)}
        {a.at && a.at.slice(0, 10) < NEW_TERMS_FROM && <p data-old-terms className="max-w-56 text-danger" dir="auto">{L.oldTerms}</p>}
        {a.consentAt && a.termsVersion
          ? <p data-consent className="max-w-56 text-ink" dir="auto">{L.consent(a.termsVersion, a.consentAt.slice(0, 10))}</p>
          : <p data-no-consent className="max-w-56 text-danger" dir="auto">{L.noConsent}</p>}
      </td>
      <td className="p-1">
        <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16))} aria-label={L.code} dir="ltr" className="input w-32 font-mono" />
        {bad && <p className="text-danger">{L.codeErrors[bad]}</p>}
      </td>
      <td className="p-1">
        {!consented && <label className="mb-1 flex max-w-56 items-start gap-1"><input type="checkbox" data-out-of-band checked={outOfBand} onChange={(e) => setOutOfBand(e.target.checked)} /><span>{L.outOfBand}</span></label>}
        <div className="flex gap-1">
          <button disabled={!!bad || (!consented && !outOfBand)} onClick={() => void onAct({ action: "approve", appId: a.id, email: a.email, name: a.name, code, ...(consented ? {} : { consentOutOfBand: outOfBand }) })} className="btn btn-primary btn-xs">{L.approve}</button>
          <button onClick={() => void onAct({ action: "reject", appId: a.id })} className="btn btn-secondary btn-xs">{L.reject}</button>
        </div>
      </td>
    </tr>
  );
}

/**
 * "Mark payout paid". The form keeps one payout id until the request succeeds and is disabled while it runs, so a double
 * press or a retry after a timeout records one transfer. Disabled until the bank details are confirmed.
 */
function PayoutForm({ p, L, onAct }: { p: PartnerRow; L: L; onAct: Act }) {
  const [amount, setAmount] = useState(p.payable ? String(p.payable) : "");
  const [date, setDate] = useState(() => ksaDay());
  const [reference, setReference] = useState("");
  const [vat, setVat] = useState("");
  const [wht, setWht] = useState("");
  const [id, setId] = useState(newPayoutId);
  const [busy, setBusy] = useState(false);
  return (
    <form onSubmit={async (e) => {
      e.preventDefault();
      if (busy) return;
      setBusy(true);
      try {
        // Empty tax fields are sent as absent; a number as a number; anything else as typed, so the server refuses it
        // (bad_vat, bad_wht) instead of NaN turning into null and the amount being dropped unseen (`taxField`).
        if (await onAct({ action: "payout", email: p.email, id, amountSar: Number(amount), vatSar: taxField(vat), whtSar: taxField(wht), date, reference })) { setId(newPayoutId()); setReference(""); setVat(""); setWht(""); }
      } finally { setBusy(false); }
    }} className="mt-2 flex flex-wrap items-end gap-2">
      <label className="grid gap-0.5"><span className="text-muted">{L.amount}</span><input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" dir="ltr" className="input w-28" /></label>
      <label className="grid gap-0.5"><span className="text-muted">{L.vat}</span><input value={vat} onChange={(e) => setVat(e.target.value)} inputMode="decimal" dir="ltr" data-payout-vat className="input w-28" /></label>
      <label className="grid gap-0.5"><span className="text-muted">{L.wht}</span><input value={wht} onChange={(e) => setWht(e.target.value)} inputMode="decimal" dir="ltr" data-payout-wht className="input w-28" /></label>
      <label className="grid gap-0.5"><span className="text-muted">{L.date}</span><input type="date" value={date} max={ksaDay()} onChange={(e) => setDate(e.target.value)} className="input" /></label>
      <label className="grid gap-0.5"><span className="text-muted">{L.reference}</span><input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={80} dir="auto" className="input w-44" /></label>
      <button disabled={busy || p.payable <= 0 || !p.bankConfirmed} className="btn btn-primary btn-xs">{L.payout}</button>
      <p className="w-full text-muted">{L.payoutNote}</p>
    </form>
  );
}

/**
 * Founder console, Partners tab (rules 390, 398, 400, 412, 414-417): applications (approve with a code, or reject) with the
 * applicant's terms consent (none recorded: approving needs the founder's "agreed outside the form" box), partners with
 * their recorded agreement to the terms or a flag that none was recorded, referrals, balances, the IBAN in full (the founder's eyes only), country, tax
 * number and the tax flags, bank confirmation, "mark payout paid" with the optional VAT paid on top and withholding tax
 * borne, and voiding a payout entered by mistake.
 */
export default function PartnersPanel({ lang }: { lang: "ar" | "en" }) {
  const L = S[lang];
  const [data, setData] = useState<{ applications: App[]; partners: PartnerRow[] } | null>(null);
  const [msg, setMsg] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [manual, setManual] = useState({ name: "", email: "", code: "", consentOutOfBand: false });
  const load = useCallback(async () => {
    // Through adminFetch (rule 436): once the key session ends, a 401 shows the console's message, not an empty tab.
    const j = await adminFetch("/api/admin/partners").then((r) => r.json()).catch(() => ({}));
    if (j.ok) setData({ applications: j.applications, partners: j.partners });
  }, []);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);
  const act = useCallback<Act>(async (body) => {
    const r = await adminFetch("/api/admin/partners", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    setMsg(j.ok ? L.done : `${L.failed}: ${L.errors[j.error] ?? j.error ?? r?.status ?? ""}`);
    if (j.ok) await load();
    return !!j.ok;
  }, [L, load]);
  if (!data) return <p className="text-sm text-muted">{L.loading}</p>;
  const waiting = data.applications.filter((a) => !a.decision);
  const decided = data.applications.filter((a) => a.decision);
  const manualBad = codeProblem(normalizeCode(manual.code));
  return (
    <div className="grid gap-6 text-xs">
      {msg && <p className="text-sm text-ink" role="status">{msg}</p>}
      <section className="card card-sm">
        <h2 className="font-display text-lg font-bold">{L.apps}</h2>
        <p className="mt-1 text-muted">{L.appsNote}</p>
        {waiting.length === 0 ? <p className="mt-2 text-muted">{L.none}</p> : (
          <div className="mt-2 overflow-x-auto"><table className="w-full"><tbody>{waiting.map((a) => <AppRow key={a.id} a={a} L={L} onAct={act} />)}</tbody></table></div>
        )}
        <form onSubmit={(e) => { e.preventDefault(); void act({ action: "approve", ...manual }); }} className="mt-3 flex flex-wrap items-end gap-2 border-t border-ink/10 pt-3">
          <span className="w-full text-muted">{L.manual}</span>
          <input value={manual.name} onChange={(e) => setManual({ ...manual, name: e.target.value })} placeholder={L.name} aria-label={L.name} className="input w-40" />
          <input value={manual.email} onChange={(e) => setManual({ ...manual, email: e.target.value })} placeholder={L.email} aria-label={L.email} dir="ltr" className="input w-56" />
          <input value={manual.code} onChange={(e) => setManual({ ...manual, code: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16) })} placeholder={L.code} aria-label={L.code} dir="ltr" className="input w-32 font-mono" />
          <label className="flex items-center gap-1"><input type="checkbox" data-out-of-band checked={manual.consentOutOfBand} onChange={(e) => setManual({ ...manual, consentOutOfBand: e.target.checked })} /><span>{L.outOfBand}</span></label>
          <button disabled={!!manualBad || !manual.email || !manual.consentOutOfBand} className="btn btn-primary btn-xs">{L.approve}</button>
          {manual.code && manualBad && <span className="text-danger">{L.codeErrors[manualBad]}</span>}
        </form>
        {decided.length > 0 && (
          <details className="mt-3"><summary className="cursor-pointer text-muted">{L.decided} ({decided.length})</summary>
            <ul className="mt-1 grid gap-0.5">{decided.map((a) => <li key={a.id}><span dir="ltr">{a.email}</span> · {a.decision!.status === "approved" ? `${L.approved} ${a.decision!.code ?? ""}` : L.rejected} · <span dir="ltr">{a.decision!.at.slice(0, 10)}</span></li>)}</ul>
          </details>
        )}
      </section>

      <section className="card card-sm">
        <h2 className="font-display text-lg font-bold">{L.partners}</h2>
        {data.partners.length === 0 ? <p className="mt-2 text-muted">{L.noPartners}</p> : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full">
              <thead className="text-muted"><tr><th className="p-1 text-start">{L.email}</th><th className="p-1 text-start">{L.code}</th><th className="p-1">{L.referrals}</th><th className="p-1">{L.earned}</th><th className="p-1">{L.paidOut}</th><th className="p-1">{L.balance}</th><th className="p-1">{L.payable}</th><th className="p-1 text-start">{L.bank}</th><th /></tr></thead>
              <tbody>{data.partners.map((p) => (
                <PartnerRows key={p.email} p={p} L={L} lang={lang} open={open === p.email} toggle={() => setOpen(open === p.email ? null : p.email)} onAct={act} />
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function PartnerRows({ p, L, lang, open, toggle, onAct }: { p: PartnerRow; L: L; lang: "ar" | "en"; open: boolean; toggle: () => void; onAct: Act }) {
  return (
    <>
      <tr className="border-t border-ink/5 align-top">
        <td className="p-1">
          <p>{p.name}</p><p className="text-muted" dir="ltr">{p.email}</p>
          {!p.hasAccount && <p className="text-muted">{L.noAccount}</p>}
          {p.accountAfterApproval && <p data-late-account className="max-w-64 text-danger">{L.lateAccount}</p>}
          {p.terms
            ? <p data-partner-consent className="max-w-64 text-muted">{p.terms.via === "founder" ? L.consentByFounder(p.terms.version, p.terms.at.slice(0, 10), p.terms.by ?? "") : L.consent(p.terms.version, p.terms.at.slice(0, 10))}</p>
            : <p data-partner-no-consent className="max-w-64 font-semibold text-danger">{L.partnerNoConsent}</p>}
        </td>
        <td className="p-1 font-mono" dir="ltr">{p.code}</td>
        <td className="tnum p-1 text-center">{p.referrals}</td>
        <td className="tnum p-1 text-center" dir="ltr">{sarText(p.earned)}</td>
        <td className="tnum p-1 text-center" dir="ltr">{sarText(p.paid)}</td>
        <td className="tnum p-1 text-center" dir="ltr">{sarText(p.balance)}</td>
        <td className={`tnum p-1 text-center ${p.payable > 0 ? "font-semibold text-ink" : ""}`} dir="ltr">{sarText(p.payable)}</td>
        <td className="p-1">
          {p.bank ? (
            <>
              <p dir="auto">{p.bank.holder}</p><p className="font-mono" dir="ltr">{p.bank.iban}</p>
              {p.bank.country && <p>{L.country}: {countryName(p.bank.country, lang)} <span className="font-mono" dir="ltr">({p.bank.country})</span></p>}
              {p.bank.taxNumber && <p>{L.taxNumber}: <span className="font-mono" dir="ltr">{p.bank.taxNumber}</span></p>}
              {p.tax.vatRegistered && <p data-flag-vat className="max-w-64 font-semibold text-danger">{L.flagVat}</p>}
              {p.tax.outsideSaudi && <p data-flag-wht className="max-w-64 font-semibold text-danger">{L.flagWht}</p>}
              {p.tax.noCountry && <p data-flag-no-country className="max-w-64 text-danger">{L.flagNoCountry}</p>}
              {p.bankConfirmed
                ? <p className="text-ink">{L.confirmedOn(p.bank.confirmedAt!.slice(0, 10))}</p>
                : <>
                    <p data-bank-unconfirmed className="max-w-64 text-danger">{L.unconfirmed(p.bank.savedAt.slice(0, 10))}</p>
                    <button onClick={() => void onAct({ action: "confirm_bank", email: p.email, savedAt: p.bank!.savedAt })} className="btn btn-secondary btn-xs mt-1">{L.confirm}</button>
                  </>}
            </>
          ) : <span className="text-muted">{L.noBank}</span>}
        </td>
        <td className="p-1"><button onClick={toggle} className="text-ink underline">{open ? L.hide : L.show}</button></td>
      </tr>
      {open && (
        <tr><td colSpan={9} className="bg-lilac/50 p-2">
          <PayoutForm p={p} L={L} onAct={onAct} />
          <p data-tax-totals className="mt-1 text-muted" dir="auto">{L.taxTotals(sarText(p.tax.vatPaid), sarText(p.tax.whtBorne))}</p>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <div><p className="font-semibold">{L.commissions}</p>
              <table className="mt-1 w-full"><thead className="text-muted"><tr><th className="text-start">{L.customer}</th><th>{L.paymentDate}</th><th>{L.base}</th><th>{L.commission}</th></tr></thead>
                <tbody>{p.commissions.map((c) => <tr key={c.id} className={c.voidedAt ? "text-muted line-through" : ""}><td dir="ltr"><span className="font-mono">{c.label}</span> {c.customer ?? <span className="text-muted">({L.deleted})</span>}</td><td className="tnum text-center" dir="ltr">{c.paymentDate}</td><td className="tnum text-center" dir="ltr">{sarText(c.baseSar)}</td><td className="tnum text-center" dir="ltr">{sarText(c.sar)}{c.voidedAt ? ` (${L.voided})` : ""}</td></tr>)}</tbody></table>
            </div>
            <div><p className="font-semibold">{L.payouts}</p>
              <table className="mt-1 w-full"><thead className="text-muted"><tr><th>{L.date}</th><th>{L.amount}</th><th>{L.vatCol}</th><th>{L.whtCol}</th><th className="text-start">{L.reference}</th><th /></tr></thead>
                <tbody>{p.payouts.map((x) => (
                  <tr key={x.id} className={x.voidedAt ? "text-muted line-through" : ""}>
                    <td className="tnum text-center" dir="ltr">{x.date}</td><td className="tnum text-center" dir="ltr">{sarText(x.sar)}</td><td className="tnum text-center" dir="ltr">{x.vatSar ? sarText(x.vatSar) : "—"}</td><td className="tnum text-center" dir="ltr">{x.whtSar ? sarText(x.whtSar) : "—"}</td><td dir="auto">{x.reference || "—"}{x.voidedAt && x.voidReason ? ` · ${x.voidReason}` : ""}</td>
                    <td>{x.voidedAt ? L.voided : <button onClick={() => { const reason = prompt(L.voidPayoutReason); if (reason !== null) void onAct({ action: "void_payout", email: p.email, id: x.id, reason }); }} className="text-danger underline">{L.voidPayout}</button>}</td>
                  </tr>
                ))}</tbody></table>
            </div>
          </div>
        </td></tr>
      )}
    </>
  );
}
