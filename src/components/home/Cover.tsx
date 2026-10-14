import type { ReactNode } from "react";
import Link from "next/link";
import Scribble from "@/components/Scribble";
import UrlStart from "@/components/UrlStart";
import Wordmark from "@/components/Wordmark";
import { dateFormat } from "@/lib/dates";
import { CAST, HERO, type CastId } from "@/lib/home";
import { HERO_START, chipHref, latestChange } from "@/lib/home-hero";
import type { Dict, Lang } from "@/lib/i18n";
import { Float } from "./Decor";
import Doodle from "./Doodle";
import Lineup from "./Lineup";
import LoopPause from "./LoopPause";
import StickyStart from "./StickyStart";
import styles from "./home.module.css";

/**
 * Prototype D's cover (rule 516): the issue stamp, the masthead (the wordmark, then its second line boxed in ink), the
 * offer with its lemon swash, a hint pointing down at the team, and the team itself. The hint has a mouse and a touch
 * wording; CSS shows the one the device can do.
 *
 * The call to action sits right under the offer (rules 1228, 1229, 1844; the October site critique moved it back
 * above the team from under it, rule 1830): the signup form with an optional link to the owner's site, the trial line
 * from the pricing copy, then the freshness chip, the newest date in the updates feed linking to the updates page. On a
 * phone, once that form has scrolled away, a bar at the bottom of the screen offers the same start (rule 1845).
 */
export default function Cover({ lang, t }: { lang: Lang; t: Dict }) {
  const last = latestChange();
  // The figures are drawn here, on the server, and handed to the client lineup as finished markup (rule 1866): the
  // drawings' code never ships to the browser.
  const figures = Object.fromEntries(CAST.map((m) => [m.id, <Doodle key={m.id} who={m.id} />])) as Record<CastId, ReactNode>;
  return (
    <section className={`${styles.panel} ${styles.cover}`} id="team" aria-labelledby="t-cover">
      <Scribble kind="box" seed="cover" fill="paper" />
      <Float kind="star" />
      <span className={`s-stamp ${styles.issue}`}>
        <Scribble kind="stamp" seed="issue" fill="paper" />
        {HERO.issue[lang]}
      </span>
      <div className={styles.ctop}>
        <h1 className={styles.mast} id="t-cover">
          <span className={styles.logo}>
            <Wordmark lang={lang} name={t.brand} />.
          </span>{" "}
          <span className={styles.tbox}>
            <Scribble kind="box" seed="tbox" fill="ink" />
            {HERO.tbox[lang]}
          </span>
        </h1>
        <div className={styles.lead}>
          <p className={styles.offer}>
            {HERO.offer[lang]}{" "}
            <span className={styles.sw}>
              <Scribble kind="swash" seed="offer" fill="lemon" />
              {HERO.offerSwash[lang]}
            </span>
          </p>
          <UrlStart t={t} lang={lang} />
          <p className={styles.trialLine}>{t.pricing.trial}</p>
          {last && (
            <Link href={chipHref(lang)} className={styles.fresh}>
              {HERO_START.chip[lang]}{" "}
              <time dateTime={last.date}>{dateFormat(lang, { day: "numeric", month: "long", year: "numeric" }).format(new Date(last.date))}</time>
            </Link>
          )}
          <StickyStart lang={lang} label={t.nav.cta} />
        </div>
        <p className={styles.hint}>
          <svg viewBox="0 0 40 28" aria-hidden="true">
            <path d="M36 2 C38 15 30 23 11 25 M17 19 L11 25 L18 28" />
          </svg>
          <span className={styles.hintMouse}>{HERO.hintMouse[lang]}</span>
          <span className={styles.hintTouch}>{HERO.hintTouch[lang]}</span>
        </p>
      </div>
      <Lineup lang={lang} figures={figures} />
      <LoopPause />
    </section>
  );
}
