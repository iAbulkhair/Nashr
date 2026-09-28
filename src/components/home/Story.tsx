import type { CSSProperties } from "react";
import { AGENT_CAST, HOME, SLOGAN, STORM } from "@/lib/home";
import type { AgentId } from "@/lib/agents";
import type { Lang } from "@/lib/i18n";
import Doodle from "./Doodle";
import StartForm from "./StartForm";
import styles from "./home.module.css";

/** Which agent takes each storm question off the owner's head. STORM is every agent's questions in cast order. */
const STORM_AGENTS: AgentId[] = STORM.map((q) => AGENT_CAST.find((a) => a.questions.includes(q))!.id);

/**
 * The story: the owner with every question spinning above their head, then the finale. Static in this version; the
 * scroll choreography comes later. The storm is decorative (`aria-hidden`); each figure in the lineup exposes its
 * questions as text.
 */
export default function Story({ lang }: { lang: Lang }) {
  return (
    <section className={styles.story} data-testid="story">
      <div className={styles.hero}>
        <div>
          <h1 className={styles.line1}>{SLOGAN.line1[lang]}</h1>
          <p className={styles.line2}>{SLOGAN.line2[lang]}</p>
        </div>
        <div className={styles.owner}>
          <div className={styles.storm} data-testid="storm" aria-hidden="true">
            {STORM.map((q, i) => (
              <span key={i} className={styles.stormQ} data-storm-q={i} data-agent={STORM_AGENTS[i]} style={{ "--i": i } as CSSProperties}>
                <span className={styles.stormText}>{q[lang]}</span>
              </span>
            ))}
          </div>
          <div className={styles.ownerFigure}>
            <Doodle who="you" />
          </div>
        </div>
      </div>
      <div className={styles.finale}>
        <p className={styles.finaleWord}>{HOME.finaleWord[lang]}</p>
        <p className={styles.finaleLine}>{HOME.finaleLine[lang]}</p>
        <StartForm lang={lang} />
      </div>
    </section>
  );
}
