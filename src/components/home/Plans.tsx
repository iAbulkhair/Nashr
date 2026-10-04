import Link from "next/link";
import Scribble from "@/components/Scribble";
import { AGENT_CAST, PLANS } from "@/lib/home";
import type { Dict, Lang } from "@/lib/i18n";
import { PUBLIC_TIERS } from "@/lib/pricing";
import { Float } from "./Decor";
import Face from "./Face";
import styles from "./home.module.css";

/** How many of a plan's features its card lists after the credits; the pricing page lists them all. */
const SHOWN = 3;

/**
 * Prototype D's plans (rule 516). Every price, credit count and feature is the dictionary's pricing block, built from
 * `src/lib/pricing.ts` (rule 248), in the public order; this file holds no number. The agency plan leads to the
 * enterprise contact form, the others to sign-up.
 */
export default function Plans({ t, lang }: { t: Dict; lang: Lang }) {
  const p = t.pricing;
  const plans = PUBLIC_TIERS.map((id) => p.plans.find((plan) => plan.id === id)).filter((plan) => plan !== undefined);
  const razan = AGENT_CAST.find((a) => a.id === PLANS.aside.who)!;
  return (
    <section className={`${styles.sec} ${styles.book}`} id="price" aria-labelledby="t-price">
      <Float kind="spark" />
      <div className={`${styles.panel} ${styles.intro}`}>
        <Scribble kind="box" seed="pr-intro" fill="paper" />
        <h2 id="t-price">{PLANS.h[lang]}</h2>
        <p className={styles.what}>{p.sub}</p>
        <p className={`s-stamp ${styles.trial}`}>
          <Scribble kind="stamp" seed="trial" fill="lemon" />
          {p.trial}
        </p>
        <div className={styles.act}>
          <p className="s-bubble" data-tail="bottom">
            <Scribble kind="bubble" seed="razan-b" tail="bottom" tailAt={0.12} rtl={lang === "ar"} />
            <span className={styles.srOnly}>{razan.name[lang]}: </span>
            {PLANS.aside.text[lang]}
          </p>
          <p className={styles.whoRow}>
            <Face who={razan.id} seed="razan-f" />
            <span>{razan.name[lang]}</span>
          </p>
        </div>
      </div>
      <ul className={styles.plans} role="list">
        {plans.map((plan) => (
          <li key={plan.id} className={`s-card ${styles.plan}`}>
            <Scribble kind="box" seed={`pl-${plan.id}`} fill="paper" heavy={plan.highlight} />
            {plan.highlight && (
              <span className={`s-tape ${styles.planTape}`}>
                <Scribble kind="tape" seed={`tape-${plan.id}`} />
                {PLANS.tape[lang]}
              </span>
            )}
            <h3>{plan.name}</h3>
            <p className={styles.planTag}>{plan.tagline}</p>
            <p className={styles.price}>
              <span className={plan.highlight ? styles.loopw : undefined}>
                {plan.highlight && <Scribble kind="circleLoop" seed={`loop-${plan.id}`} />}
                <b>{plan.price}</b> {plan.period}
              </span>
            </p>
            <ul className={styles.feat} role="list">
              {[plan.credits, ...plan.features.slice(0, SHOWN)].map((f) => (
                <li key={f}>
                  <i className={styles.mk} aria-hidden="true">
                    <Scribble kind="tick" seed={`mk-${plan.id}-${f.length}`} />
                  </i>
                  <span>{f}</span>
                </li>
              ))}
            </ul>
            <Link href={plan.id === "agency" ? `/${lang}/enterprise#contact` : `/${lang}/app/signup`} className={`s-link ${styles.planCta}`}>
              <Scribble kind="underline" seed={`cta-${plan.id}`} />
              {plan.cta}
            </Link>
          </li>
        ))}
      </ul>
      <p className={styles.rulel}>{PLANS.rule[lang]}</p>
    </section>
  );
}
