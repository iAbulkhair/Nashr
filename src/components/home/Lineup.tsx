"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { BANTER_FIRST_MS, BANTER_LINE_MS, exchangeTimes } from "@/lib/banter-clock";
import { BANTER, CAST, HOME, type CastId, type CastMember } from "@/lib/home";
import type { Lang } from "@/lib/i18n";
import Figure from "./Figure";
import MotionToggle from "./MotionToggle";
import { useMotionPaused, useShowing } from "./motion";
import { useReducedMotion } from "./useReducedMotion";
import styles from "./home.module.css";

/** How far the eyes move towards the pointer, in the drawing's units. */
const GAZE = 3;

type Line = { who: CastId; text: string };

const quote = (text: string, lang: Lang) => (lang === "ar" ? `«${text}»` : `“${text}”`);

/** What a figure says when pressed: its first banter line, else its value line; the owner gives the finale's word. */
function answer(member: CastMember, lang: Lang): string {
  if (member.id === "you") return HOME.finaleWord[lang];
  const line = BANTER.flatMap((b) => b.lines).find((l) => l.who === member.id);
  return (line ? line.text : member.value)[lang];
}

/** Every line a figure can say, quoted as shown, so its question slot can be sized for the longest one. */
function linesOf(member: CastMember, lang: Lang): string[] {
  const texts = BANTER.flatMap((b) => b.lines.filter((l) => l.who === member.id).map((l) => l.text[lang]));
  return [...new Set([...texts, answer(member, lang)])].map((t) => quote(t, lang));
}

const clamp = (v: number) => Math.max(-1, Math.min(1, v));

/**
 * The team standing in a row, Noor first in the reading direction (from the right in Arabic). When the figures do not
 * fit at a readable width, the row scrolls inside its own box (snapping on phones), so the page itself never scrolls
 * sideways. The AI label is permanent (spec §7.1, disclosure).
 *
 * The team is alive (spec §7.3) while the lineup is on screen, the tab is showing and the visitor has not paused the
 * page's motion (`data-live`): the banter of §5.3 plays in speech bubbles, the questions flip, the figures blink and
 * breathe (CSS) and the eyes follow the pointer. The pause button here and the one on the story's stage are one switch
 * (`./motion`, WCAG 2.2.2): either stops all of that and the story's motion too. A pressed figure always answers, and
 * only that answer is announced to screen readers: the automatic banter is decoration and stays silent. Under reduced
 * motion the bubbles still come and go, without moving; nothing else moves.
 */
export default function Lineup({ lang }: { lang: Lang }) {
  const section = useRef<HTMLElement>(null);
  const reduced = useReducedMotion();
  const paused = useMotionPaused();
  // On screen (a quarter of it) and in a visible tab.
  const active = useShowing(section, { threshold: 0.25 });
  const [banter, setBanter] = useState<Line | null>(null);
  const [pressed, setPressed] = useState<Line | null>(null);
  const next = useRef(0);
  const live = active && !paused;

  // The banter, one line at a time, on the schedule in `@/lib/banter-clock`. An exchange cut off (off screen, hidden
  // tab, paused) takes its bubble with it, so no stale line comes back with the lineup, and starts again from its first
  // line.
  useEffect(() => {
    if (!live) return;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (fn: () => void, ms: number) => {
      const t = setTimeout(() => {
        timers.delete(t);
        fn();
      }, ms);
      timers.add(t);
    };
    const play = () => {
      const exchange = BANTER[next.current % BANTER.length];
      // Moments from this exchange's start: each line, the end of the last one, the next exchange.
      const at = exchangeTimes(0, exchange.lines.length);
      exchange.lines.forEach((l, i) => later(() => setBanter({ who: l.who, text: l.text[lang] }), at.lines[i]));
      later(() => {
        setBanter(null);
        next.current += 1;
      }, at.end);
      later(play, at.next);
    };
    later(play, BANTER_FIRST_MS);
    return () => {
      timers.forEach(clearTimeout);
      setBanter(null);
    };
  }, [live, lang]);

  // A pressed figure's answer holds for one line's time; pressing again restarts it.
  useEffect(() => {
    if (!pressed) return;
    const t = setTimeout(() => setPressed(null), BANTER_LINE_MS);
    return () => clearTimeout(t);
  }, [pressed]);

  // The eyes: one listener for the whole lineup, at most one update a frame. The gaze is measured on screen, so it
  // points at the pointer whatever the reading direction. Paused, the eyes come back to rest.
  useEffect(() => {
    const el = section.current;
    if (!el || reduced || paused) return;
    let frame = 0;
    let x = 0;
    let y = 0;
    const look = () => {
      frame = 0;
      const box = el.getBoundingClientRect();
      el.style.setProperty("--gx", `${(clamp((x - box.left - box.width / 2) / (box.width / 2)) * GAZE).toFixed(2)}px`);
      el.style.setProperty("--gy", `${(clamp((y - box.top - box.height / 2) / (box.height / 2)) * GAZE).toFixed(2)}px`);
    };
    const onMove = (e: PointerEvent) => {
      x = e.clientX;
      y = e.clientY;
      if (!frame) frame = requestAnimationFrame(look);
    };
    el.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      el.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(frame);
      el.style.removeProperty("--gx");
      el.style.removeProperty("--gy");
    };
  }, [reduced, paused]);

  const talk = pressed ?? (live ? banter : null);
  const said = pressed ? `${CAST.find((m) => m.id === pressed.who)?.name[lang]}: ${quote(pressed.text, lang)}` : "";

  return (
    <section
      ref={section}
      className={styles.lineup}
      data-testid="lineup"
      data-live={live || undefined}
      data-motion={paused ? "paused" : "playing"}
      aria-labelledby="lineup-label"
    >
      <div className={styles.lineupHead}>
        <p id="lineup-label" className={styles.aiLabel}>
          {HOME.aiLabel[lang]}
        </p>
        <MotionToggle lang={lang} />
      </div>
      <div className={styles.strip}>
        {/* `role="list"`: Safari drops the list semantics of a list drawn without markers. */}
        <ul className={styles.row} role="list" style={{ "--n": CAST.length } as CSSProperties}>
          {CAST.map((member, index) => (
            <li key={member.id} className={styles.cell}>
              <Figure
                member={member}
                lang={lang}
                index={index}
                lines={linesOf(member, lang)}
                say={talk?.who === member.id ? quote(talk.text, lang) : undefined}
                hold={!live}
                onPress={() => setPressed({ who: member.id, text: answer(member, lang) })}
              />
            </li>
          ))}
        </ul>
      </div>
      <p className={styles.srOnly} aria-live="polite" aria-atomic="true">
        {said}
      </p>
    </section>
  );
}
