import Scribble from "@/components/Scribble";
import { CAST, SECTIONS, STEP7_LINK, STEPS } from "@/lib/home";
import { formatNumber } from "@/lib/format";
import type { Lang } from "@/lib/i18n";
import { CLAUDE_PAUSED } from "@/lib/model";
import { Float } from "./Decor";
import Doodle from "./Doodle";
import Face from "./Face";
import styles from "./home.module.css";

/** Step five, the owner's approval, is the one D draws twice as wide with the owner standing beside it. */
const APPROVAL = 4;

/**
 * Prototype D's seven step panels (rule 516), explained only: what happens, the line its agent says, and, while the
 * model is paused, the step's "today" note, so the page stays true when the model is turned back on.
 */
export default function Steps({ lang }: { lang: Lang }) {
  const s = SECTIONS.steps;
  return (
    <section className={styles.sec} id="steps" aria-labelledby="t-steps">
      <Float kind="plane" />
      <Float kind="cloud" />
      <div className={styles.sh}>
        <h2 id="t-steps">
          <span className={styles.ul}>
            <Scribble kind="underline" seed="steps-h" />
            {s.h[lang]}
          </span>
        </h2>
        {s.sub && <p className={styles.sub}>{s.sub[lang]}</p>}
      </div>
      <ol className={`${styles.grid4} ${styles.steps}`} role="list">
        {STEPS.map((st, i) => {
          const who = st.who ? CAST.find((m) => m.id === st.who) : undefined;
          const body = (
            <>
              <p className={styles.what}>{st.body[lang]}</p>
              <div className={styles.act}>
                <p className="s-bubble" data-tail="bottom">
                  <Scribble kind="bubble" seed={`s${i}b`} tail="bottom" tailAt={0.12} rtl={lang === "ar"} />
                  {who && <span className={styles.srOnly}>{who.name[lang]}: </span>}
                  {st.aside[lang]}
                </p>
                <p className={styles.whoRow}>
                  {who ? (
                    <>
                      <Face who={who.id} seed={`s${i}f`} />
                      <span>{who.name[lang]}</span>
                    </>
                  ) : (
                    <>
                      <svg className={`${styles.doodle} ${styles.plug}`} viewBox="0 0 52 52" aria-hidden="true">
                        <path className={styles.paper} d="M14 12 L38 12 L37 30 C36 36 16 36 15 30 Z" />
                        <path d="M20 12 L20 3 M32 12 L32 3 M26 34 C26 42 30 46 40 48" />
                      </svg>
                      <span>{STEP7_LINK[lang]}</span>
                    </>
                  )}
                </p>
              </div>
              {CLAUDE_PAUSED && st.paused && <p className={styles.now}>{st.paused[lang]}</p>}
            </>
          );
          const approval = i === APPROVAL;
          return (
            <li key={i} className={approval ? `${styles.panel} ${styles.st} ${styles.s5}` : `${styles.panel} ${styles.st}`}>
              <Scribble kind="box" seed={`st${i}`} fill="paper" />
              <h3 className={styles.cap}>
                <Scribble kind="box" seed={`st${i}h`} fill={approval ? "lemon" : "lilac"} />
                <span className={styles.num}>{formatNumber(i + 1, lang)}</span>
                {st.title[lang]}
              </h3>
              {approval ? (
                <div className={styles.s5in}>
                  <span className={styles.s5fig} aria-hidden="true">
                    <Doodle who="you" />
                  </span>
                  <div className={styles.s5body}>{body}</div>
                </div>
              ) : (
                body
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
