import Scribble from "@/components/Scribble";
import ScribbleStatic from "@/components/ScribbleStatic";
import { AGENT_CAST, RULES, RULE_LABEL, SECTIONS } from "@/lib/home";
import type { Lang } from "@/lib/i18n";
import { Float } from "./Decor";
import Face from "./Face";
import styles from "./home.module.css";

const name = (id: string, lang: Lang) => AGENT_CAST.find((a) => a.id === id)?.name[lang] ?? "";

/**
 * Prototype D's house rules (rule 516): four short exchanges between the agents, each pinned with the rule it shows.
 * The first speaker's lines sit on the reading side, the other's opposite. Each bubble carries its speaker's name for
 * screen readers; the faces are decoration.
 */
export default function Rules({ lang }: { lang: Lang }) {
  const s = SECTIONS.rules;
  return (
    <section className={styles.sec} id="rules" aria-labelledby="t-rules">
      <Float kind="q" />
      <div className={styles.sh}>
        <h2 id="t-rules">
          <span className={styles.ul}>
            <ScribbleStatic kind="underline" seed="rules-h" rtl={lang === "ar"} />
            {s.h[lang]}
          </span>
        </h2>
        {s.sub && <p className={styles.sub}>{s.sub[lang]}</p>}
      </div>
      <ul className={styles.grid4} role="list">
        {RULES.map((r, i) => {
          const first = r.lines[0].who;
          return (
            <li key={i} className={`${styles.panel} ${styles.mini}`}>
              <Scribble kind="box" seed={`r${i}`} fill="paper" />
              <div className={styles.talk}>
                {r.lines.map((l, j) => {
                  const a = l.who === first;
                  return (
                    <p key={j} className={a ? styles.l : `${styles.l} ${styles.lb}`}>
                      <Face who={l.who} seed={`rf${i}${j}`} small />
                      <span className="s-bubble" data-tail={a ? "start" : "end"}>
                        <Scribble kind="bubble" seed={`rb${i}${j}`} tail={a ? "start" : "end"} rtl={lang === "ar"} />
                        <span className={styles.srOnly}>{name(l.who, lang)}: </span>
                        {l.text[lang]}
                      </span>
                    </p>
                  );
                })}
              </div>
              <p className={`${styles.cap} ${styles.law}`}>
                <Scribble kind="box" seed={`rl${i}`} fill="lilac" />
                {RULE_LABEL[lang]}
                {r.law[lang]}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
