import Scribble from "@/components/Scribble";
import ScribbleStatic from "@/components/ScribbleStatic";
import { PlanList } from "@/components/PlanCard";
import type { Dict, Lang } from "@/lib/i18n";

/**
 * `headingLevel` exists because this section is reused on the home page and the industry pages, which have their own
 * h1, and on /pricing, which had none at all — that page opened its document outline at h2, so it shipped with no
 * first-level heading in either language. The card and credits-table headings sit one level below it (rule 1853): h2
 * under the page's h1, h3 under a section h2.
 *
 * Prices, credits and seats on the cards are built in the dictionary from src/lib/pricing.ts (rule 248). The cards are
 * the shared `PlanCard` (rule 1849), the same as on the home page, with every feature listed here. The Agency card has
 * no list price: its call to action goes to the contact form on /enterprise, the others to signup.
 *
 * Drawn as prototype D (rule 518): a scribbled card per plan, the highlighted plan on lilac with the ink pill, the
 * others with the lemon ghost pill. The title's underline is drawn once on the server in the page's direction.
 *
 * The design review of 2026-10-19: no eyebrow label over the title (rule 2317), the credit costs in the body face with
 * tabular figures instead of monospace and rows parted by space instead of ruled lines (rule 2318), and on /pricing alone
 * the plan cards rise in once (rule 2319, `plans-rise` in globals.css).
 */
export default function Pricing({ t, lang, headingLevel = 2 }: { t: Dict; lang: Lang; headingLevel?: 1 | 2 }) {
  const p = t.pricing;
  const Heading = headingLevel === 1 ? "h1" : "h2";
  const Sub = headingLevel === 1 ? "h2" : "h3";
  return (
    <section id="pricing" className="scroll-mt-20">
      <div className="section-wrap">
        <Heading className="section-title">
          <span className="s-ul">
            <ScribbleStatic kind="underline" seed="pricing-h" rtl={lang === "ar"} />
            {p.title}
          </span>
        </Heading>
        <p className="mt-3 text-foreground-muted">{p.sub}</p>
        <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
          <span className="s-stamp max-w-full whitespace-normal">
            <Scribble kind="stamp" seed="pricing-trial" fill="lemon" />
            {p.trial}
          </span>
        </div>

        <div className={headingLevel === 1 ? "plans-rise mt-12" : "mt-12"}>
          <PlanList plans={p.plans} lang={lang} level={headingLevel === 1 ? 2 : 3} />
        </div>

        <div className="mt-14 max-w-lg">
          <Sub id="pricing-credits-h" className="font-display text-xl font-bold">{p.creditsTitle}</Sub>
          <table className="mt-3 w-full text-sm" aria-labelledby="pricing-credits-h">
            <tbody>
              {p.credits.map((c) => (
                <tr key={c.action}>
                  <th scope="row" className="py-2.5 text-start font-normal">{c.action}</th>
                  <td className="py-2.5 text-end font-bold tabular-nums" dir="ltr">
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
