import type { Lang } from "@/lib/i18n";

const COPY = {
  ar: { current: "خطتك الحالية", recommended: "مقترحة" },
  en: { current: "Your current plan", recommended: "Recommended" },
} as const;

/**
 * One plan on the billing page (rule 1154). The price is ink, never the danger colour (a price is not an error); the
 * account's own plan says so in words ("Your current plan") as well as with a thicker border, so the marker never rests
 * on colour alone. "Recommended" is the pricing page's own `highlight` flag (no usage claim) and never shows on the
 * current plan. `children`: the pay or contact control, which the page decides (owner only, Paymob or links).
 */
export default function PlanCard({ lang, id, name, price, period, credits, features, current, highlight, offerLine, children }: {
  lang: Lang;
  id: string;
  name: string;
  price: string;
  period: string;
  credits: string;
  features: readonly string[];
  current: boolean;
  highlight?: boolean;
  offerLine?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const T = COPY[lang];
  const tid = `plan-${id}-title`;
  return (
    <section data-tier={id} data-current={current ? "" : undefined} aria-labelledby={tid}
      className={`flex flex-col card ${current ? "border-2 border-border-strong" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={tid} className="font-display text-lg font-medium">{name}</h3>
        {current ? <span className="rounded-full bg-inverse px-2.5 py-0.5 text-xs font-semibold text-inverse-muted" data-plan-current="">{T.current}</span>
          : highlight ? <span className="rounded-full border border-border px-2.5 py-0.5 text-xs font-semibold text-foreground" data-plan-recommended="">{T.recommended}</span> : null}
      </div>
      <p className="mt-2 font-display text-3xl font-bold text-foreground" dir="ltr">{price} <span className="text-xs font-normal text-foreground-muted">{period}</span></p>
      {offerLine}
      <p className="text-sm font-semibold text-foreground" data-plan-credits="">{credits}</p>
      <ul className="mt-3 flex-1 space-y-1 text-xs text-foreground-muted">{features.map((f) => <li key={f}>• {f}</li>)}</ul>
      {children}
    </section>
  );
}
