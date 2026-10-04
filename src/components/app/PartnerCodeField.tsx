"use client";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import type { Lang } from "@/lib/i18n";
import { FIRST_MONTH_DISCOUNT_PCT } from "@/lib/pricing";

const T = {
  ar: { label: "كود الشريك (اختياري)", hint: `كود الشريك يعطيك خصم ${FIRST_MONTH_DISCOUNT_PCT}% على شهرك الأول.`, applied: (c: string) => `كود الشريك ${c}: خصم ${FIRST_MONTH_DISCOUNT_PCT}% على شهرك الأول.` },
  en: { label: "Partner code (optional)", hint: `A partner code gives you ${FIRST_MONTH_DISCOUNT_PCT}% off your first month.`, applied: (c: string) => `Partner code ${c}: ${FIRST_MONTH_DISCOUNT_PCT}% off your first month.` },
} as const;

/**
 * The signup form's optional partner code (rule 392). Its value travels in the form as `partnerCode`; the server checks it
 * (a code that is not a partner's is refused with `bad_partner_code`) and, when it is empty, uses the partner link's cookie.
 * A partner link (/p/CODE) lands here with `?partner=CODE`, which fills the field (the link checked that code already).
 */
export default function PartnerCodeField({ lang }: { lang: Lang }) {
  const S = T[lang];
  const initial = (useSearchParams().get("partner") ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
  const [code, setCode] = useState(initial);
  const clean = code.trim().toUpperCase();
  return (
    <div className="grid gap-1">
      <input name="partnerCode" value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16))} autoComplete="off" dir="ltr" placeholder={S.label} aria-label={S.label} aria-describedby="partner-code-hint" className="input font-mono" />
      <p id="partner-code-hint" className="text-xs text-ink/60">{initial && clean === initial ? S.applied(clean) : S.hint}</p>
    </div>
  );
}
