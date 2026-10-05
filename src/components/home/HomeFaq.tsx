import { Fragment } from "react";
import Scribble from "@/components/Scribble";
import { HOME_FAQ, SECTIONS } from "@/lib/home";
import type { Lang } from "@/lib/i18n";
import { Float } from "./Decor";
import styles from "./home.module.css";

/**
 * Prototype D's questions before you start (rule 516): native details/summary, so they open without JavaScript. The
 * drawn plus turns into a minus when open; a hand-drawn bracket holds each answer.
 */
export default function HomeFaq({ lang }: { lang: Lang }) {
  return (
    <section className={styles.sec} id="faq" aria-labelledby="t-faq">
      <Float kind="bubble" />
      <div className={styles.sh}>
        <h2 id="t-faq">
          <span className={styles.ul}>
            <Scribble kind="underline" seed="faq-h" />
            {SECTIONS.faq.h[lang]}
          </span>
        </h2>
      </div>
      <div className={styles.faq}>
        {HOME_FAQ.map((f, i) => (
          <Fragment key={i}>
            {i > 0 && (
              <div className={styles.faqRule} aria-hidden="true">
                <Scribble kind="divider" seed={`fr${i}`} />
              </div>
            )}
            <details className={styles.qa}>
              <summary>
                <span className={styles.pm} aria-hidden="true">
                  <svg className="s-art" viewBox="0 0 20 20">
                    <path className="main" d="M3 10.4C8 9.5 12 10.4 17 9.8" />
                    <path className={`main ${styles.pmV}`} d="M10.3 3C9.7 8 10.4 12 9.8 17" />
                  </svg>
                </span>
                <span>{f.q[lang]}</span>
              </summary>
              <div className={styles.ans}>
                <svg className={`s-art ${styles.brk}`} viewBox="0 0 10 100" preserveAspectRatio="none" aria-hidden="true">
                  <path className="main" d="M1 1C6 1 5 4 5 8C4.5 40 5.5 70 5 92C5 97 5 99 1 99" />
                </svg>
                <p>{f.a[lang]}</p>
              </div>
            </details>
          </Fragment>
        ))}
      </div>
    </section>
  );
}
