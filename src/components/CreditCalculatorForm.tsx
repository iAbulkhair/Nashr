"use client";

import { useId, useState } from "react";
import Scribble from "@/components/Scribble";
import type { Lang } from "@/lib/i18n";
import { PLAN_CREDITS, formatCount, smallestPlanFor, type PublicTier } from "@/lib/pricing";
import type { TaskType } from "@/lib/tasks";

/** One task type the visitor counts: its label and its cost in credits per item, from `creditCost` on the server. */
export type CalcRow = { type: TaskType; label: string; cost: number; start: number };
/** One plan as the result names it. `credits` is PLAN_CREDITS, or AGENCY_MIN's for Agency (the least a deal holds). */
export type CalcPlan = { id: PublicTier; name: string; credits: number; price: string; period: string };

/** The most of one type the form takes: a guard against a typo, not a plan limit. */
export const CALC_MAX = 999;
/** A typed count as a whole number from 0 to CALC_MAX; anything else is 0. */
export const clampCount = (v: string | number): number => {
  const n = typeof v === "number" ? v : Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(CALC_MAX, Math.max(0, Math.floor(n))) : 0;
};
/** The month's credits for the counts: Σ count × cost, rounded up so a fractional per-item cost is never undercounted. */
export const creditsFor = (rows: readonly CalcRow[], counts: readonly number[]): number =>
  Math.ceil(rows.reduce((sum, r, i) => sum + clampCount(counts[i] ?? 0) * r.cost, 0));

const credit = (lang: Lang, n: number) => (lang === "ar" ? `${formatCount(n)} كريدت` : `${formatCount(n)} ${n === 1 ? "credit" : "credits"}`);

/** The sentence the live region reads (rule 1886). No saving, no comparison with anyone else: the plan that covers it. */
export function calcResult(lang: Lang, total: number, plans: readonly CalcPlan[]): string {
  if (total <= 0) return lang === "ar" ? "اختر وش تحتاج، ويظهر لك هنا الكريدت والخطة." : "Pick what you need, and the credits and the plan show here.";
  const id = smallestPlanFor(total);
  const plan = plans.find((p) => p.id === id);
  if (!plan) return "";
  if (id === "agency") {
    const biz = formatCount(PLAN_CREDITS.business);
    return lang === "ar"
      ? `تحتاج ${credit(lang, total)} في الشهر، أكثر من ${biz} في خطة الأعمال. رصيد ${plan.name} يُحدَّد بالعقد: تواصل معنا.`
      : `That's ${credit(lang, total)} a month, more than Business's ${biz}. ${plan.name} credits are set by contract: contact us.`;
  }
  return lang === "ar"
    ? `تحتاج ${credit(lang, total)} في الشهر. أصغر خطة تكفيها: ${plan.name}، ${credit(lang, plan.credits)} بـ ${plan.price} ${plan.period}.`
    : `That's ${credit(lang, total)} a month. The smallest plan that covers it: ${plan.name}, ${credit(lang, plan.credits)} for ${plan.price} ${plan.period}.`;
}

/**
 * The calculator's inputs and result (rules 1885, 1886): a labelled number field per task type with − and + buttons at
 * least 44px square, and the result in a polite live region. Logical properties only, so it reads the same in Arabic.
 */
export default function CreditCalculatorForm({ lang, rows, plans }: { lang: Lang; rows: readonly CalcRow[]; plans: readonly CalcPlan[] }) {
  const id = useId();
  const [counts, setCounts] = useState<number[]>(() => rows.map((r) => clampCount(r.start)));
  const set = (i: number, v: string | number) => setCounts((c) => c.map((x, j) => (j === i ? clampCount(v) : x)));
  const total = creditsFor(rows, counts);
  const ar = lang === "ar";
  return (
    <div className="s-card mt-6 max-w-3xl">
      <Scribble kind="box" seed="calc-box" fill="paper" />
      <ul className="grid gap-4 sm:grid-cols-2" role="list">
        {rows.map((r, i) => {
          const input = `${id}-${r.type}`;
          return (
            <li key={r.type} className="grid gap-1.5">
              <label htmlFor={input} className="font-bold">{r.label}</label>
              <span id={`${input}-hint`} className="text-sm text-foreground-muted">
                {ar ? `${credit(lang, r.cost)} للواحد` : `${credit(lang, r.cost)} each`}
              </span>
              <div className="flex items-center gap-2">
                <button type="button" className="s-chip inline-grid size-11 flex-none place-items-center p-0 text-xl font-bold" aria-label={ar ? `أقل: ${r.label}` : `Fewer: ${r.label}`} aria-controls={input} disabled={counts[i] <= 0} onClick={() => set(i, counts[i] - 1)}>
                  <Scribble kind="pill" seed={`calc-${r.type}-m`} ring />
                  <span aria-hidden="true">−</span>
                </button>
                <span className="s-input w-24">
                  <Scribble kind="box" seed={`calc-${r.type}-i`} fill="surface" />
                  <input id={input} type="number" inputMode="numeric" min={0} max={CALC_MAX} step={1} dir="ltr" className="text-center" aria-describedby={`${input}-hint`} value={counts[i]} onChange={(e) => set(i, e.target.value)} />
                </span>
                <button type="button" className="s-chip inline-grid size-11 flex-none place-items-center p-0 text-xl font-bold" aria-label={ar ? `أكثر: ${r.label}` : `More: ${r.label}`} aria-controls={input} disabled={counts[i] >= CALC_MAX} onClick={() => set(i, counts[i] + 1)}>
                  <Scribble kind="pill" seed={`calc-${r.type}-p`} ring />
                  <span aria-hidden="true">+</span>
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-6 text-lg font-bold" aria-live="polite" data-calc-result="">
        {calcResult(lang, total, plans)}
      </p>
    </div>
  );
}
