"use client";
import { useCallback, useEffect, useState } from "react";
import { NEW_TERMS_FROM, PAYOUT_MIN_SAR, codeProblem, ksaDay, normalizeCode, sarText, type Bank, type Commission, type Payout } from "@/lib/partner-rules";

type App = { id: string; name: string; email: string; phone: string; channel: string; audience: string; lang: string; at: string; suggested: string; decision: { status: "approved" | "rejected"; code?: string; at: string; by: string } | null };
type PartnerRow = {
  email: string; name: string; code: string; approvedAt: string; bank: Bank | null; bankConfirmed: boolean; accountAfterApproval: boolean; hasAccount: boolean;
  referrals: number; earned: number; paid: number; balance: number; pending: number; payable: number;
  commissions: (Commission & { customer: string | null })[]; payouts: Payout[];
};

const S = {
  en: {
    apps: "Applications", appsNote: "From the public partner page. Approving claims the code and links it to the applicant's email; if they have no account yet, they sign up with that email and the partner page appears.",
    none: "No applications waiting.", decided: "Decided", code: "Code", approve: "Approve", reject: "Reject", approved: "approved", rejected: "rejected",
    oldTerms: "Sent under the old terms (25% recurring, 60 days). Tell the applicant the new terms before approving: 15% of each payment for the first 4 months, 30 days, SAR 200 minimum.",
    partners: "Partners", noPartners: "No partners yet.", referrals: "Referrals", earned: "Earned", paidOut: "Paid", balance: "Balance", payable: "Payable",
    bank: "Bank", noBank: "no bank details yet", payout: "Mark payout paid", amount: "Amount SAR", date: "Date", reference: "Transfer reference",
    payoutNote: `Only a payable balance (SAR ${PAYOUT_MIN_SAR} or more) can be paid down, never past it, and only to confirmed bank details.`, commissions: "Commissions", payouts: "Payouts",
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
      code_taken: "That code is taken.", already_partner: "This email is already a partner.", member_login: "A team member login cannot be a partner.", bad_email: "Not a valid email.",
      bad_code: "3 to 16 letters A-Z or digits.", reserved_code: "A reserved word: choose another code.", below_minimum: `The balance is below SAR ${PAYOUT_MIN_SAR}.`,
      over_balance: "More than the payable balance.", bad_amount: "Enter an amount.", bad_date: "A past or today's date.", bank_unconfirmed: "Confirm the bank details first.",
      changed: "The bank details changed since you loaded them. Reload and check again.", no_bank: "No bank details yet.", not_found: "Not found.",
    } as Record<string, string>,
  },
  ar: {
    apps: "طلبات الشراكة", appsNote: "من صفحة الشركاء العامة. الموافقة تحجز الكود وتربطه ببريد المتقدم؛ إن لم يكن لديه حساب يسجّل بهذا البريد فتظهر له صفحة الشراكة.",
    none: "لا طلبات بانتظار المراجعة.", decided: "طلبات تمت مراجعتها", code: "الكود", approve: "وافق", reject: "ارفض", approved: "مقبول", rejected: "مرفوض",
    oldTerms: "قُدّم بالشروط القديمة (25% متكررة، 60 يوماً). أبلغ المتقدم بالشروط الجديدة قبل الموافقة: 15% من كل دفعة لأول 4 أشهر، 30 يوماً، حد أدنى 200 ريال.",
    partners: "الشركاء", noPartners: "لا شركاء بعد.", referrals: "الإحالات", earned: "المكتسب", paidOut: "المدفوع", balance: "الرصيد", payable: "جاهز للصرف",
    bank: "البنك", noBank: "لا بيانات بنكية بعد", payout: "سجّل تحويلاً مدفوعاً", amount: "المبلغ (ريال)", date: "التاريخ", reference: "مرجع التحويل",
    payoutNote: `يُصرف الرصيد الجاهز فقط (${PAYOUT_MIN_SAR} ريال فأكثر) ولا يتجاوزه، وإلى بيانات بنكية مؤكدة فقط.`, commissions: "العمولات", payouts: "التحويلات",
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
      code_taken: "الكود مستخدم.", already_partner: "هذا البريد شريك بالفعل.", member_login: "دخول عضو فريق لا يكون شريكاً.", bad_email: "بريد غير صحيح.",
      bad_code: "من 3 إلى 16 حرفاً لاتينياً أو رقماً.", reserved_code: "كلمة محجوزة: اختر كوداً آخر.", below_minimum: `الرصيد أقل من ${PAYOUT_MIN_SAR} ريال.`,
      over_balance: "أكثر من الرصيد الجاهز.", bad_amount: "اكتب المبلغ.", bad_date: "تاريخ اليوم أو قبله.", bank_unconfirmed: "أكّد البيانات البنكية أولاً.",
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
  const bad = codeProblem(normalizeCode(code));
  return (
    <tr className="border-t border-ink/5 align-top">
      <td className="p-1"><p>{a.name}</p><p className="text-ink/60" dir="ltr">{a.email}</p><p className="text-ink/60" dir="ltr">{a.phone}</p></td>
      <td className="p-1"><p>{a.channel}</p><p className="text-ink/60">{a.audience}</p></td>
      <td className="tnum p-1" dir="ltr">{a.at.slice(0, 10)}{a.at && a.at.slice(0, 10) < NEW_TERMS_FROM && <p data-old-terms className="max-w-56 text-sadu" dir="auto">{L.oldTerms}</p>}</td>
      <td className="p-1">
        <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16))} aria-label={L.code} dir="ltr" className="input w-32 font-mono" />
        {bad && <p className="text-sadu">{L.codeErrors[bad]}</p>}
      </td>
      <td className="p-1">
        <div className="flex gap-1">
          <button disabled={!!bad} onClick={() => void onAct({ action: "approve", appId: a.id, email: a.email, name: a.name, code })} className="btn btn-primary btn-xs">{L.approve}</button>
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
  const [id, setId] = useState(newPayoutId);
  const [busy, setBusy] = useState(false);
  return (
    <form onSubmit={async (e) => {
      e.preventDefault();
      if (busy) return;
      setBusy(true);
      try {
        if (await onAct({ action: "payout", email: p.email, id, amountSar: Number(amount), date, reference })) { setId(newPayoutId()); setReference(""); }
      } finally { setBusy(false); }
    }} className="mt-2 flex flex-wrap items-end gap-2">
      <label className="grid gap-0.5"><span className="text-ink/60">{L.amount}</span><input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" dir="ltr" className="input w-28" /></label>
      <label className="grid gap-0.5"><span className="text-ink/60">{L.date}</span><input type="date" value={date} max={ksaDay()} onChange={(e) => setDate(e.target.value)} className="input" /></label>
      <label className="grid gap-0.5"><span className="text-ink/60">{L.reference}</span><input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={80} dir="auto" className="input w-44" /></label>
      <button disabled={busy || p.payable <= 0 || !p.bankConfirmed} className="btn btn-primary btn-xs">{L.payout}</button>
      <p className="w-full text-ink/50">{L.payoutNote}</p>
    </form>
  );
}

/**
 * Founder console, Partners tab (rules 390, 398, 400): applications (approve with a code, or reject), partners with
 * referrals, balances and the IBAN in full (the founder's eyes only), bank confirmation, "mark payout paid" and voiding a
 * payout entered by mistake.
 */
export default function PartnersPanel({ lang }: { lang: "ar" | "en" }) {
  const L = S[lang];
  const [data, setData] = useState<{ applications: App[]; partners: PartnerRow[] } | null>(null);
  const [msg, setMsg] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [manual, setManual] = useState({ name: "", email: "", code: "" });
  const load = useCallback(async () => {
    const j = await fetch("/api/admin/partners").then((r) => r.json()).catch(() => ({}));
    if (j.ok) setData({ applications: j.applications, partners: j.partners });
  }, []);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);
  const act = useCallback<Act>(async (body) => {
    const r = await fetch("/api/admin/partners", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    setMsg(j.ok ? L.done : `${L.failed}: ${L.errors[j.error] ?? j.error ?? r?.status ?? ""}`);
    if (j.ok) await load();
    return !!j.ok;
  }, [L, load]);
  if (!data) return <p className="text-sm text-ink/50">{L.loading}</p>;
  const waiting = data.applications.filter((a) => !a.decision);
  const decided = data.applications.filter((a) => a.decision);
  const manualBad = codeProblem(normalizeCode(manual.code));
  return (
    <div className="grid gap-6 text-xs">
      {msg && <p className="text-sm text-oasis" role="status">{msg}</p>}
      <section className="card card-sm">
        <h2 className="font-display text-lg font-bold">{L.apps}</h2>
        <p className="mt-1 text-ink/60">{L.appsNote}</p>
        {waiting.length === 0 ? <p className="mt-2 text-ink/60">{L.none}</p> : (
          <div className="mt-2 overflow-x-auto"><table className="w-full"><tbody>{waiting.map((a) => <AppRow key={a.id} a={a} L={L} onAct={act} />)}</tbody></table></div>
        )}
        <form onSubmit={(e) => { e.preventDefault(); void act({ action: "approve", ...manual }); }} className="mt-3 flex flex-wrap items-end gap-2 border-t border-ink/10 pt-3">
          <span className="w-full text-ink/60">{L.manual}</span>
          <input value={manual.name} onChange={(e) => setManual({ ...manual, name: e.target.value })} placeholder={L.name} aria-label={L.name} className="input w-40" />
          <input value={manual.email} onChange={(e) => setManual({ ...manual, email: e.target.value })} placeholder={L.email} aria-label={L.email} dir="ltr" className="input w-56" />
          <input value={manual.code} onChange={(e) => setManual({ ...manual, code: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16) })} placeholder={L.code} aria-label={L.code} dir="ltr" className="input w-32 font-mono" />
          <button disabled={!!manualBad || !manual.email} className="btn btn-primary btn-xs">{L.approve}</button>
          {manual.code && manualBad && <span className="text-sadu">{L.codeErrors[manualBad]}</span>}
        </form>
        {decided.length > 0 && (
          <details className="mt-3"><summary className="cursor-pointer text-ink/60">{L.decided} ({decided.length})</summary>
            <ul className="mt-1 grid gap-0.5">{decided.map((a) => <li key={a.id}><span dir="ltr">{a.email}</span> · {a.decision!.status === "approved" ? `${L.approved} ${a.decision!.code ?? ""}` : L.rejected} · <span dir="ltr">{a.decision!.at.slice(0, 10)}</span></li>)}</ul>
          </details>
        )}
      </section>

      <section className="card card-sm">
        <h2 className="font-display text-lg font-bold">{L.partners}</h2>
        {data.partners.length === 0 ? <p className="mt-2 text-ink/60">{L.noPartners}</p> : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full">
              <thead className="text-ink/60"><tr><th className="p-1 text-start">{L.email}</th><th className="p-1 text-start">{L.code}</th><th className="p-1">{L.referrals}</th><th className="p-1">{L.earned}</th><th className="p-1">{L.paidOut}</th><th className="p-1">{L.balance}</th><th className="p-1">{L.payable}</th><th className="p-1 text-start">{L.bank}</th><th /></tr></thead>
              <tbody>{data.partners.map((p) => (
                <PartnerRows key={p.email} p={p} L={L} open={open === p.email} toggle={() => setOpen(open === p.email ? null : p.email)} onAct={act} />
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function PartnerRows({ p, L, open, toggle, onAct }: { p: PartnerRow; L: L; open: boolean; toggle: () => void; onAct: Act }) {
  return (
    <>
      <tr className="border-t border-ink/5 align-top">
        <td className="p-1">
          <p>{p.name}</p><p className="text-ink/60" dir="ltr">{p.email}</p>
          {!p.hasAccount && <p className="text-ink/50">{L.noAccount}</p>}
          {p.accountAfterApproval && <p data-late-account className="max-w-64 text-sadu">{L.lateAccount}</p>}
        </td>
        <td className="p-1 font-mono" dir="ltr">{p.code}</td>
        <td className="tnum p-1 text-center">{p.referrals}</td>
        <td className="tnum p-1 text-center" dir="ltr">{sarText(p.earned)}</td>
        <td className="tnum p-1 text-center" dir="ltr">{sarText(p.paid)}</td>
        <td className="tnum p-1 text-center" dir="ltr">{sarText(p.balance)}</td>
        <td className={`tnum p-1 text-center ${p.payable > 0 ? "font-semibold text-oasis" : ""}`} dir="ltr">{sarText(p.payable)}</td>
        <td className="p-1">
          {p.bank ? (
            <>
              <p dir="auto">{p.bank.holder}</p><p className="font-mono" dir="ltr">{p.bank.iban}</p>
              {p.bankConfirmed
                ? <p className="text-oasis">{L.confirmedOn(p.bank.confirmedAt!.slice(0, 10))}</p>
                : <>
                    <p data-bank-unconfirmed className="max-w-64 text-sadu">{L.unconfirmed(p.bank.savedAt.slice(0, 10))}</p>
                    <button onClick={() => void onAct({ action: "confirm_bank", email: p.email, savedAt: p.bank!.savedAt })} className="btn btn-secondary btn-xs mt-1">{L.confirm}</button>
                  </>}
            </>
          ) : <span className="text-ink/50">{L.noBank}</span>}
        </td>
        <td className="p-1"><button onClick={toggle} className="text-oasis underline">{open ? L.hide : L.show}</button></td>
      </tr>
      {open && (
        <tr><td colSpan={9} className="bg-salt-dim/50 p-2">
          <PayoutForm p={p} L={L} onAct={onAct} />
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <div><p className="font-semibold">{L.commissions}</p>
              <table className="mt-1 w-full"><thead className="text-ink/60"><tr><th className="text-start">{L.customer}</th><th>{L.paymentDate}</th><th>{L.base}</th><th>{L.commission}</th></tr></thead>
                <tbody>{p.commissions.map((c) => <tr key={c.id} className={c.voidedAt ? "text-ink/40 line-through" : ""}><td dir="ltr"><span className="font-mono">{c.label}</span> {c.customer ?? <span className="text-ink/50">({L.deleted})</span>}</td><td className="tnum text-center" dir="ltr">{c.paymentDate}</td><td className="tnum text-center" dir="ltr">{sarText(c.baseSar)}</td><td className="tnum text-center" dir="ltr">{sarText(c.sar)}{c.voidedAt ? ` (${L.voided})` : ""}</td></tr>)}</tbody></table>
            </div>
            <div><p className="font-semibold">{L.payouts}</p>
              <table className="mt-1 w-full"><thead className="text-ink/60"><tr><th>{L.date}</th><th>{L.amount}</th><th className="text-start">{L.reference}</th><th /></tr></thead>
                <tbody>{p.payouts.map((x) => (
                  <tr key={x.id} className={x.voidedAt ? "text-ink/40 line-through" : ""}>
                    <td className="tnum text-center" dir="ltr">{x.date}</td><td className="tnum text-center" dir="ltr">{sarText(x.sar)}</td><td dir="auto">{x.reference || "—"}{x.voidedAt && x.voidReason ? ` · ${x.voidReason}` : ""}</td>
                    <td>{x.voidedAt ? L.voided : <button onClick={() => { const reason = prompt(L.voidPayoutReason); if (reason !== null) void onAct({ action: "void_payout", email: p.email, id: x.id, reason }); }} className="text-sadu underline">{L.voidPayout}</button>}</td>
                  </tr>
                ))}</tbody></table>
            </div>
          </div>
        </td></tr>
      )}
    </>
  );
}
