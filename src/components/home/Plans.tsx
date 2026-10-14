import Scribble from "@/components/Scribble";
import { HOME_FEATURES, PlanList } from "@/components/PlanCard";
import { AGENT_CAST, PLANS } from "@/lib/home";
import type { Dict, Lang } from "@/lib/i18n";
import { PUBLIC_TIERS } from "@/lib/pricing";
import { Float } from "./Decor";
import Face from "./Face";
import styles from "./home.module.css";

/**
 * Prototype D's plans (rule 516). Every price, credit count and feature is the dictionary's pricing block, built from
 * `src/lib/pricing.ts` (rule 248), in the public order; this file holds no number. The cards are the shared `PlanCard`
 * (rule 1849), the same as /pricing, listing each plan's first `HOME_FEATURES` features: seats, social posts and chat.
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
      <PlanList plans={plans} lang={lang} level={3} shown={HOME_FEATURES} />
      <p className={styles.rulel}>{PLANS.rule[lang]}</p>
    </section>
  );
}
