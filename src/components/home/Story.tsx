"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { AGENT_CAST, HOME, SLOGAN } from "@/lib/home";
import type { Lang } from "@/lib/i18n";
import Doodle from "./Doodle";
import MotionToggle from "./MotionToggle";
import QuestionFlip from "./QuestionFlip";
import StartForm from "./StartForm";
import { useMotionPaused, useShowing } from "./motion";
import styles from "./home.module.css";

/** Chapter 0 is the hero, then one chapter per agent in cast order (1–8), then the finale (9). */
const FINALE = AGENT_CAST.length + 1;
const CHAPTERS = FINALE + 1;

/**
 * Every question in the storm with the agent who takes it and the chapter where that happens. Built from the cast
 * itself, in the same order as `STORM`, so a question can never lose its agent.
 */
const STORM_CAST = AGENT_CAST.flatMap((agent, k) => agent.questions.map((q) => ({ q, agent: agent.id, chapter: k + 1 })));

type Phase = "next" | "on" | "past";
const phase = (k: number, chapter: number): Phase => (k === chapter ? "on" : k > chapter ? "next" : "past");

/**
 * The story, told on one sticky stage while the section scrolls past it. The owner stands on one side with every
 * question spinning above their head; each chapter an agent steps in on the other side, the stage takes on its colour,
 * and its questions leave the owner's head for it. The finale leaves one word above the owner and the start form.
 *
 * GSAP's ScrollTrigger only maps the scroll position to a chapter; everything that moves is CSS keyed on that chapter,
 * so scrolling back up plays it all in reverse and every question returns. Under reduced motion there is no orbit and
 * nothing travels, but the chapters still step. Without JavaScript the section collapses to the hero (see the CSS).
 * The storm is decorative (`aria-hidden`); the lineup below exposes every agent as text.
 *
 * What moves on its own (the storm, the scroll cue's nudge, the chapter's question flip) runs only while the story is
 * on screen, the tab is showing and the visitor has not paused the page's motion (`data-live`). The pause button on
 * the stage is the same switch as the lineup's (`./motion`, WCAG 2.2.2).
 */
export default function Story({ lang }: { lang: Lang }) {
  const section = useRef<HTMLElement>(null);
  const shown = useRef(0);
  const [chapter, setChapter] = useState(0);
  const paused = useMotionPaused();
  // Any part of the section: it is one screen tall per chapter, so a share of it would never be reached. The page opens on the
  // story, so it counts as showing until the first observation says otherwise.
  const showing = useShowing(section, { initial: true });
  const live = showing && !paused;

  useEffect(() => {
    const el = section.current;
    if (!el) return;
    gsap.registerPlugin(ScrollTrigger);
    // The stage is sized in svh, so a phone's toolbar showing or hiding changes nothing worth a refresh.
    ScrollTrigger.config({ ignoreMobileResize: true });
    const show = (progress: number) => {
      const next = Math.min(FINALE, Math.floor(progress * CHAPTERS));
      if (next === shown.current) return;
      shown.current = next;
      setChapter(next);
    };
    const trigger = ScrollTrigger.create({
      trigger: el,
      start: "top top",
      end: "bottom bottom",
      onUpdate: (self) => show(self.progress),
      // Also on the first measurement, for a page that loads already scrolled into the story.
      onRefresh: (self) => show(self.progress),
    });
    return () => trigger.kill();
  }, []);

  const agent = chapter >= 1 && chapter < FINALE ? AGENT_CAST[chapter - 1] : undefined;
  // Under reduced motion the storm is a single question: the first one still on the owner's head.
  const lead = STORM_CAST.findIndex((s) => s.chapter > chapter);

  return (
    <section
      ref={section}
      className={styles.story}
      style={{ "--chapters": CHAPTERS } as CSSProperties}
      data-testid="story"
      data-chapter={chapter}
      data-alone={!agent || undefined}
      data-live={live || undefined}
    >
      <div className={styles.stage} data-world={agent?.id}>
        <div className={styles.heroCopy} data-on={chapter === 0 || undefined}>
          <h1 className={styles.line1}>{SLOGAN.line1[lang]}</h1>
          <p className={styles.line2}>{SLOGAN.line2[lang]}</p>
          <p className={styles.scrollCue} aria-hidden="true">
            {HOME.scroll[lang]}
          </p>
        </div>

        {AGENT_CAST.map((a, i) => (
          <div key={a.id} className={`${styles.card} ${styles.agentCopy}`} data-phase={phase(i + 1, chapter)}>
            <p className={styles.storyValue}>{a.value[lang]}</p>
            <p className={styles.storyName}>{a.name[lang]}</p>
          </div>
        ))}

        <div className={`${styles.card} ${styles.finaleCopy}`} data-on={chapter === FINALE || undefined}>
          <p className={styles.finaleLine}>{HOME.finaleLine[lang]}</p>
          <StartForm lang={lang} />
        </div>

        <div className={styles.owner}>
          <div className={styles.above}>
            <div className={styles.storm} style={{ "--count": STORM_CAST.length } as CSSProperties} data-testid="storm" aria-hidden="true">
              {STORM_CAST.map((s, i) => (
                <span
                  key={i}
                  className={styles.stormQ}
                  data-storm-q={i}
                  data-agent={s.agent}
                  data-taken={chapter >= s.chapter || undefined}
                  data-lead={i === lead || undefined}
                  style={{ "--i": i } as CSSProperties}
                >
                  <span className={styles.stormText}>{s.q[lang]}</span>
                </span>
              ))}
            </div>
            <p className={styles.finaleWord} data-on={chapter === FINALE || undefined}>
              {HOME.finaleWord[lang]}
            </p>
          </div>
          <div className={styles.stageArt}>
            <Doodle who="you" />
          </div>
        </div>

        {AGENT_CAST.map((a, i) => (
          <div key={a.id} className={styles.agent} data-phase={phase(i + 1, chapter)} aria-hidden="true">
            <div className={styles.above}>
              <QuestionFlip items={a.questions} lang={lang} paused={!live || chapter !== i + 1} phase="resume" />
            </div>
            <div className={styles.stageArt}>
              <Doodle who={a.id} />
            </div>
          </div>
        ))}

        <MotionToggle lang={lang} className={styles.storyToggle} />
      </div>
    </section>
  );
}
