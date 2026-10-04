"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Lang } from "@/lib/i18n";
import { FIRST_MONTH_DISCOUNT_PCT } from "@/lib/pricing";

const T = {
  ar: {
    label: "كود الشريك", hint: `عندك كود من شريك؟ أدخله قبل اشتراكك الأول لتحصل على خصم ${FIRST_MONTH_DISCOUNT_PCT}% على شهرك الأول.`, apply: "طبّق الكود", busy: "…",
    errors: { bad_partner_code: "كود الشريك غير صحيح.", self_referral: "لا يمكن استخدام كودك أنت أو كود عضو في فريقك.", already_attributed: "حسابك مرتبط بشريك من قبل.", already_paid: "الكود يُطبّق قبل أول دفعة فقط.", slow_down: "محاولات كثيرة. حاول بعد ساعة.", server: "تعذّر الحفظ. حاول مرة أخرى." } as Record<string, string>,
  },
  en: {
    label: "Partner code", hint: `Have a code from a partner? Enter it before your first payment for ${FIRST_MONTH_DISCOUNT_PCT}% off your first month.`, apply: "Apply code", busy: "…",
    errors: { bad_partner_code: "That partner code is not valid.", self_referral: "You cannot use your own code or a code from your team.", already_attributed: "Your account is already linked to a partner.", already_paid: "A code applies before the first payment only.", slow_down: "Too many tries. Try again in an hour.", server: "Could not save. Try again." } as Record<string, string>,
  },
} as const;

/** The billing page's partner-code field (rule 393): POST /api/partner/code, then the page reloads with the offer. */
export default function PartnerCodeForm({ lang }: { lang: Lang }) {
  const S = T[lang];
  const r = useRouter();
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || code.length < 3) return;
    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/partner/code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!j.ok) return setErr(S.errors[j.error ?? "server"] ?? S.errors.server);
      r.refresh();
    } catch {
      setErr(S.errors.server);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="mt-6 grid gap-2 card text-sm sm:max-w-md" data-partner-code-form>
      <label htmlFor="billing-partner-code" className="font-medium">{S.label}</label>
      <p className="text-xs text-muted">{S.hint}</p>
      <div className="flex gap-2">
        <input id="billing-partner-code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16))} dir="ltr" autoComplete="off" className="input flex-1 font-mono" />
        <button disabled={busy || code.length < 3} className="btn btn-primary">{busy ? S.busy : S.apply}</button>
      </div>
      {err && <p role="alert" className="text-sm text-danger">{err}</p>}
    </form>
  );
}
