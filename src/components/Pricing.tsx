import Link from "next/link";
import type { Dict, Lang } from "@/lib/i18n";

/**
 * `headingLevel` exists because this section is reused on the home page and the industry pages, which have their own
 * h1, and on /pricing, which had none at all — that page opened its document outline at h2, so it shipped with no
 * first-level heading in either language.
 *
 * Prices, credits and seats on the cards are built in the dictionary from src/lib/pricing.ts (rule 220). The Agency card
 * has no list price: its call to action goes to the contact form on /enterprise, the others to signup.
 */
export default function Pricing({ t, lang, headingLevel = 2 }: { t: Dict; lang: Lang; headingLevel?: 1 | 2 }) {
  const p = t.pricing;
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <section id="pricing" className="scroll-mt-20 bg-oasis-deep text-mist">
      <div className="section-wrap">
        <p className="mb-3 eyebrow eyebrow-accent">{p.eyebrow}</p>
        <Heading className="section-title">{p.title}</Heading>
        <p className="mt-3 text-mist-dim">{p.sub}</p>
        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          <span className="rounded-full border border-saffron/50 px-3 py-1 text-saffron">{p.trial}</span>
          <span className="rounded-full border border-mist/20 px-3 py-1 text-mist-dim">{p.annual}</span>
        </div>

        <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {p.plans.map((plan) => (
            <article key={plan.id} data-tier={plan.id} className={`flex flex-col rounded-2xl border p-6 ${plan.highlight ? "border-saffron bg-oasis" : "border-mist/10 bg-oasis/50"}`}>
              <h3 className="font-display text-xl font-medium">{plan.name}</h3>
              <p className="mt-1 text-xs text-mist-dim">{plan.tagline}</p>
              <p className="mt-5 flex items-baseline gap-2">
                <span className="font-display text-4xl font-bold" dir={plan.id === "agency" ? undefined : "ltr"}>
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
              <Link href={plan.id === "agency" ? `/${lang}/enterprise#contact` : `/${lang}/app/signup`} className={`mt-6 rounded-full px-4 py-2.5 text-center text-sm font-semibold transition ${plan.highlight ? "bg-saffron text-ink hover:bg-saffron/90" : "border border-mist/25 text-mist hover:border-mist/60"}`}>
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
