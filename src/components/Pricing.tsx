import Link from "next/link";
import Scribble from "@/components/Scribble";
import type { Dict, Lang } from "@/lib/i18n";

/**
 * `headingLevel` exists because this section is reused on the home page and the industry pages, which have their own
 * h1, and on /pricing, which had none at all — that page opened its document outline at h2, so it shipped with no
 * first-level heading in either language.
 *
 * Prices, credits and seats on the cards are built in the dictionary from src/lib/pricing.ts (rule 248). The Agency card
 * has no list price: its call to action goes to the contact form on /enterprise, the others to signup.
 *
 * Drawn as prototype D (rule 518): a scribbled card per plan, the highlighted plan on lilac with the ink pill, the
 * others with the lemon ghost pill.
 */
export default function Pricing({ t, lang, headingLevel = 2 }: { t: Dict; lang: Lang; headingLevel?: 1 | 2 }) {
  const p = t.pricing;
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <section id="pricing" className="scroll-mt-20">
      <div className="section-wrap">
        <p className="eyebrow">{p.eyebrow}</p>
        <Heading className="section-title">
          <span className="s-ul">
            <Scribble kind="underline" seed="pricing-h" />
            {p.title}
          </span>
        </Heading>
        <p className="mt-3 text-muted">{p.sub}</p>
        <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
          <span className="s-stamp max-w-full whitespace-normal">
            <Scribble kind="stamp" seed="pricing-trial" fill="lemon" />
            {p.trial}
          </span>
          <span className="text-muted">{p.annual}</span>
        </div>

        <div className="mt-12 grid gap-x-6 gap-y-9 md:grid-cols-2 lg:grid-cols-4">
          {p.plans.map((plan) => (
            <article key={plan.id} data-tier={plan.id} className="s-card flex flex-col">
              <Scribble kind="box" seed={`pricing-${plan.id}`} fill={plan.highlight ? "lilac" : "paper"} heavy={plan.highlight} shadow={plan.highlight} />
              <h3 className="font-display text-2xl font-bold">{plan.name}</h3>
              <p className="mt-1 text-sm text-muted">{plan.tagline}</p>
              <p className="mt-5 flex items-baseline gap-2">
                <span className="font-display text-4xl font-bold" dir={plan.id === "agency" ? undefined : "ltr"}>
                  {plan.price}
                </span>
                <span className="text-sm text-muted">{plan.period}</span>
              </p>
              <p className="mt-1 text-sm font-bold">{plan.credits}</p>
              <ul className="mt-5 flex-1 space-y-2 text-sm" role="list">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2.5">
                    <i className="relative isolate mt-1 inline-block h-[18px] w-5 flex-none" aria-hidden="true">
                      <Scribble kind="tick" seed={`pricing-${plan.id}-${f.length}`} />
                    </i>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              <Link href={plan.id === "agency" ? `/${lang}/enterprise#contact` : `/${lang}/app/signup`} className={`s-btn mt-7 ${plan.highlight ? "" : "s-btn--ghost"}`}>
                <Scribble kind="pill" seed={`pricing-cta-${plan.id}`} fill={plan.highlight ? "ink" : "lemon"} shadow={plan.highlight} ring />
                {plan.cta}
              </Link>
            </article>
          ))}
        </div>

        <div className="mt-14 max-w-lg">
          <h3 className="font-display text-xl font-bold">{p.creditsTitle}</h3>
          <table className="mt-3 w-full text-sm">
            <tbody className="divide-y divide-ink/15 border-y-[1.5px] border-ink">
              {p.credits.map((c) => (
                <tr key={c.action}>
                  <td className="py-2">{c.action}</td>
                  <td className="py-2 text-end font-mono font-bold" dir="ltr">
                    {c.cost}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
