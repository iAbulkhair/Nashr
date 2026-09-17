import Link from "next/link";
import type { Dict, Lang } from "@/lib/i18n";

export default function Pricing({ t, lang }: { t: Dict; lang: Lang }) {
  const p = t.pricing;
  return (
    <section id="pricing" className="scroll-mt-20 bg-oasis-deep text-mist">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-saffron">{p.eyebrow}</p>
        <h2 className="font-display text-3xl font-bold leading-tight tracking-tight sm:text-4xl">{p.title}</h2>
        <p className="mt-3 text-mist-dim">{p.sub}</p>
        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          <span className="rounded-full border border-saffron/50 px-3 py-1 text-saffron">{p.trial}</span>
          <span className="rounded-full border border-mist/20 px-3 py-1 text-mist-dim">{p.annual}</span>
        </div>

        <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {p.plans.map((plan) => (
            <article key={plan.name} className={`flex flex-col rounded-2xl border p-6 ${plan.highlight ? "border-saffron bg-oasis" : "border-mist/10 bg-oasis/50"}`}>
              <h3 className="font-display text-xl font-medium">{plan.name}</h3>
              <p className="mt-1 text-xs text-mist-dim">{plan.tagline}</p>
              <p className="mt-5 flex items-baseline gap-2">
                <span className="font-display text-4xl font-bold" dir="ltr">
                  {plan.price}
                </span>
                <span className="text-xs text-mist-dim">{plan.period}</span>
              </p>
              <p className="mt-1 text-sm text-saffron">{plan.credits}</p>
              <ul className="mt-5 flex-1 space-y-2 text-sm text-mist/90">
                {plan.features.map((f) => (
                  <li key={f} className="flex gap-2">
                    <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-saffron" aria-hidden />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              <Link href={`/${lang}#waitlist`} className={`mt-6 rounded-full px-4 py-2.5 text-center text-sm font-semibold transition ${plan.highlight ? "bg-saffron text-ink hover:bg-saffron/90" : "border border-mist/25 text-mist hover:border-mist/60"}`}>
                {plan.cta}
              </Link>
            </article>
          ))}
        </div>

        <div className="mt-12 max-w-lg">
          <h3 className="font-display text-lg font-medium">{p.creditsTitle}</h3>
          <table className="mt-3 w-full text-sm">
            <tbody className="divide-y divide-mist/10">
              {p.credits.map((c) => (
                <tr key={c.action}>
                  <td className="py-2 text-mist/90">{c.action}</td>
                  <td className="py-2 text-end font-mono text-saffron" dir="ltr">
                    {c.cost}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="sadu" aria-hidden />
    </section>
  );
}
