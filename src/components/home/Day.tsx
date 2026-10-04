import Scribble from "@/components/Scribble";
import { AGENT_CAST, CAST, DAY, SECTIONS } from "@/lib/home";
import type { Lang } from "@/lib/i18n";
import { Float } from "./Decor";
import Doodle from "./Doodle";
import styles from "./home.module.css";

const you = CAST.find((m) => m.id === "you")!;

/** A panel's caption, boxed in lilac on its top edge. */
function Cap({ seed, children, className = "" }: { seed: string; children: React.ReactNode; className?: string }) {
  return (
    <p className={`${styles.cap} ${className}`}>
      <Scribble kind="box" seed={seed} fill="lilac" />
      {children}
    </p>
  );
}

/**
 * Prototype D's strip (rule 516), four panels: the owner at 7:58 under three questions and a price message; the team
 * peeking in to say good morning; every question with the agent who takes it; and the owner's one word. The drawings
 * that carry meaning have a label; the peeking faces and the arms are decoration (the names are written beside them).
 */
export default function Day({ lang }: { lang: Lang }) {
  const s = SECTIONS.day;
  const { morning, peek, owners, word } = DAY;
  return (
    <section className={styles.sec} id="day" aria-labelledby="t-day">
      <Float kind="cup" />
      <div className={styles.sh}>
        <h2 id="t-day">
          <span className={styles.ul}>
            <Scribble kind="underline" seed="day-h" />
            {s.h[lang]}
          </span>
        </h2>
        {s.sub && <p className={styles.sub}>{s.sub[lang]}</p>}
      </div>
      <ol className={`${styles.grid4} ${styles.strip}`} role="list">
        <li className={styles.panel}>
          <Scribble kind="box" seed="d1" fill="paper" />
          <Cap seed="d1cap">{morning.cap[lang]}</Cap>
          <div className={styles.clouds}>
            {morning.clouds.map((q, i) => (
              <p key={i} className="s-cloud">
                <Scribble kind="cloud" seed={`d1c${i}`} rtl={lang === "ar"} />
                {q[lang]}
              </p>
            ))}
          </div>
          <div className={styles.scene}>
            <span className={styles.bust} role="img" aria-label={morning.hands[lang]}>
              <Doodle who="you" pose="hands" crop="bust" />
            </span>
            <p className={styles.phone}>
              <Scribble kind="box" seed="phone" fill="paper" />
              <span className={styles.glow}>
                <Scribble kind="puddle" seed="glow" fill="lemon" />
              </span>
              <svg className={styles.rays} viewBox="0 0 90 120" preserveAspectRatio="none" aria-hidden="true">
                <path d="M-8 18 L-18 8 M-10 52 L-22 52 M98 18 L108 8 M100 52 L112 52 M45 -10 L45 -20" />
              </svg>
              <small>{morning.note[lang]}</small>
              <b>{morning.msg[lang]}</b>
            </p>
          </div>
        </li>
        <li className={`${styles.panel} ${styles.p2}`}>
          <Scribble kind="box" seed="d2" fill="paper" />
          <div className={styles.peek} aria-hidden="true">
            {AGENT_CAST.map((a) => (
              <i key={a.id}>
                <Doodle who={a.id} crop="peek" />
              </i>
            ))}
          </div>
          <Cap seed="d2cap" className={styles.capIn}>
            {peek.cap[lang]}
          </Cap>
          <p className={`s-bubble ${styles.up} ${styles.hi}`} data-tail="bottom">
            <Scribble kind="bubble" seed="d2hi" tail="bottom" tailAt={0.5} rtl={lang === "ar"} />
            <span className={styles.srOnly}>{peek.who[lang]}: </span>
            {peek.hi[lang]}
          </p>
          <p className={`s-bubble ${styles.ask}`} data-tail="bottom">
            <Scribble kind="bubble" seed="d2ask" tail="bottom" tailAt={0.2} rtl={lang === "ar"} />
            <span className={styles.srOnly}>{you.name[lang]}: </span>
            {peek.ask[lang]}
          </p>
          <p className={`s-bubble ${styles.up} ${styles.teamB}`} data-tail="bottom">
            <Scribble kind="bubble" seed="d2team" tail="bottom" tailAt={0.75} rtl={lang === "ar"} />
            <span className={styles.srOnly}>{peek.who[lang]}: </span>
            {peek.team[lang]}
          </p>
          <span className={styles.bust} role="img" aria-label={peek.look[lang]}>
            <Doodle who="you" crop="bust" />
          </span>
        </li>
        <li className={styles.panel}>
          <Scribble kind="box" seed="d3" fill="paper" />
          <Cap seed="d3cap">{owners.cap[lang]}</Cap>
          <ul className={styles.takes} role="list">
            {AGENT_CAST.map((a, i) => (
              <li key={a.id}>
                <span className="s-bubble" data-tail="end">
                  <Scribble kind="bubble" seed={`q-${a.id}`} tail="end" rtl={lang === "ar"} />
                  {a.questions[0][lang]}
                </span>
                <span className={styles.arm}>
                  <svg className={styles.doodle} data-cast={a.id} viewBox="0 0 70 26" aria-hidden="true">
                    <path className={styles.fill} d={`M-8 6 Q18 ${4 + (i % 3)} 45 7 L45 20 Q18 ${21 - (i % 2)} -8 20`} />
                    <path d="M45 5 L45 22" />
                    <ellipse className={styles.paper} cx="55" cy="13" rx="9" ry="6.5" />
                    <path d="M52 8 Q58 5 62 9" />
                  </svg>
                  <small>{a.name[lang]}</small>
                </span>
              </li>
            ))}
          </ul>
        </li>
        <li className={styles.panel}>
          <Scribble kind="box" seed="d4" fill="paper" />
          <Cap seed="d4cap">{word.cap[lang]}</Cap>
          <div className={styles.sign}>
            <span className={styles.signFig} aria-hidden="true">
              <Doodle who="you" />
            </span>
            <p className={`s-stamp ${styles.bigstamp}`}>
              <Scribble kind="stamp" seed="d4stamp" fill="lemon" />
              {word.stamp[lang]}
            </p>
          </div>
          <Cap seed="d4end" className={styles.capEnd}>
            {word.end[lang]}
          </Cap>
        </li>
      </ol>
    </section>
  );
}
