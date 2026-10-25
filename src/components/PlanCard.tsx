import Link from "next/link";
import Scribble from "@/components/Scribble";
import ScribbleStatic from "@/components/ScribbleStatic";
import { PLANS as HOME_PLANS } from "@/lib/home";
import type { Lang, PlanCard as Plan } from "@/lib/i18n";
import type { PublicTier } from "@/lib/pricing";
import styles from "@/components/home/home.module.css";

/**
 * The one plan card (rule 1849): the home page's plans and /pricing render this, so a card reads the same everywhere.
 * Every price, credit count, output line and feature is the dictionary's pricing block, built from src/lib/pricing.ts and
 * src/lib/tasks.ts (rule 248); this file holds no number. The home card lists its first `HOME_FEATURES` features, which
 * on every plan are the seats, social posts and chat messages (rule 1850); /pricing lists them all.
 *
 * The call to action is a real button (rule 1852): the highlighted plan's pill solid, the others ghost, at least
 * `--hit-min` tall; the Agency card goes to the contact form on /enterprise, the others to sign-up. The box, tape, loop
 * and pill measure their host (client `Scribble`); the ticks are drawn once on the server in the page's direction.
 */
export const HOME_FEATURES = 3;

/** Where a card's call to action leads. */
export const planHref = (lang: Lang, id: PublicTier): string => (id === "agency" ? `/${lang}/enterprise#contact` : `/${lang}/app/signup`);

export default function PlanCard({ plan, lang, level, shown }: { plan: Plan; lang: Lang; level: 2 | 3; shown?: number }) {
  const Name = level === 2 ? "h2" : "h3";
  const rtl = lang === "ar";
  const features = shown === undefined ? plan.features : plan.features.slice(0, shown);
  return (
    <li data-tier={plan.id} className={`s-card ${styles.plan}`}>
      <Scribble kind="box" seed={`pl-${plan.id}`} fill={plan.highlight ? "lilac" : "paper"} heavy={plan.highlight} />
      <div className={styles.planHead}>
        {plan.highlight && (
          <span className={`s-tape ${styles.planTape}`}>
            <Scribble kind="tape" seed={`tape-${plan.id}`} />
            {HOME_PLANS.tape[lang]}
          </span>
        )}
        <Name className={styles.planName}>{plan.name}</Name>
        <p className={styles.planTag}>{plan.tagline}</p>
      </div>
      <p className={styles.price}>
        <span className={plan.highlight ? styles.loopw : undefined}>
          {plan.highlight && <Scribble kind="circleLoop" seed={`loop-${plan.id}`} />}
          <span className={styles.priceN} dir={plan.id === "agency" ? undefined : "ltr"}>{plan.price}</span> {plan.period}
        </span>
      </p>
      {/* Only a yearly card has a note: the same price per month (rule 3541). */}
      {plan.note && <p className={styles.planTag} data-yearly-note="">{plan.note}</p>}
      <div className={styles.planCredits}>
        <p className={styles.planCr}>{plan.credits}</p>
        <p className={styles.planOut}>{plan.output}</p>
      </div>
      <ul className={styles.feat} role="list">
        {features.map((f, i) => (
          <li key={f}>
            <i className={styles.mk} aria-hidden="true">
              <ScribbleStatic kind="tick" seed={`mk-${plan.id}-${i}`} rtl={rtl} w={20} h={18} />
            </i>
            <span>{f}</span>
          </li>
        ))}
      </ul>
      <Link href={planHref(lang, plan.id)} className={plan.highlight ? `s-btn ${styles.planCta}` : `s-btn s-btn--ghost ${styles.planCta}`}>
        <Scribble kind="pill" seed={`cta-${plan.id}`} fill={plan.highlight ? "ink" : "lemon"} ring />
        {plan.cta}
      </Link>
    </li>
  );
}

/** The cards in the public order, in a list that lines their rows up (rule 1852). */
export function PlanList({ plans, lang, level, shown }: { plans: readonly Plan[]; lang: Lang; level: 2 | 3; shown?: number }) {
  return (
    <div className={styles.plansBox}>
      <ul className={styles.plans} role="list">
        {plans.map((plan) => (
          <PlanCard key={plan.id} plan={plan} lang={lang} level={level} shown={shown} />
        ))}
      </ul>
    </div>
  );
}
