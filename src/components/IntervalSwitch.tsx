"use client";
import { useId, useState, type ReactNode } from "react";
import type { Lang } from "@/lib/i18n";
import type { BillingInterval } from "@/lib/pricing";

/** The switch's words. No number here: the prices are in the cards it shows (src/lib/pricing.ts through `yearlyPlanCards`). */
export const INTERVAL_COPY = {
  ar: { label: "مدة الفوترة", month: "شهري", year: "سنوي" },
  en: { label: "Billing period", month: "Monthly", year: "Yearly" },
} as const;

const ORDER: readonly BillingInterval[] = ["month", "year"];

/**
 * The monthly / yearly switch over the pricing cards (rules 3541-3543). Drawn only when the founder set a yearly price for
 * at least one plan (`anyYearlyOffered()` in src/components/Pricing.tsx); with none set the page renders the monthly cards
 * alone, exactly as before. Both card lists are rendered on the server and passed in; this only shows one and hides the
 * other with `hidden`, so no price is computed in the browser.
 *
 * Two real buttons in a labelled group with `aria-pressed`: Tab reaches them, Enter and Space press them, and a screen
 * reader hears which period is shown. The row follows the page's direction (RTL in Arabic) through logical spacing.
 */
export default function IntervalSwitch({ lang, monthly, yearly }: { lang: Lang; monthly: ReactNode; yearly: ReactNode }) {
  const S = INTERVAL_COPY[lang];
  const [shown, setShown] = useState<BillingInterval>("month");
  const id = useId();
  return (
    <>
      <div role="group" aria-label={S.label} data-interval-switch="" className="mb-8 inline-flex gap-1 rounded-full border border-border p-1">
        {ORDER.map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={shown === v}
            aria-controls={`${id}-${v}`}
            data-interval={v}
            onClick={() => setShown(v)}
            className={`min-h-[var(--hit-min)] rounded-full px-5 py-2 text-sm font-semibold ${shown === v ? "bg-inverse text-inverse-foreground" : "text-foreground hover:bg-background-muted"}`}
          >
            {S[v]}
          </button>
        ))}
      </div>
      <div id={`${id}-month`} hidden={shown !== "month"} data-interval-panel="month">{monthly}</div>
      <div id={`${id}-year`} hidden={shown !== "year"} data-interval-panel="year">{yearly}</div>
    </>
  );
}
