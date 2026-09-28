"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { BANTER, CAST, HOME, type CastId, type CastMember } from "@/lib/home";
import type { Lang } from "@/lib/i18n";
import Figure from "./Figure";
import { useReducedMotion } from "./useReducedMotion";
import styles from "./home.module.css";

/** The banter's timing: first exchange 1.5 s after the lineup comes into view, then one every 8 s; a line holds 2.2 s. */
const FIRST_MS = 1500;
const EXCHANGE_MS = 8000;
const LINE_MS = 2200;
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
 * The team standing in a row, Noor first in the reading direction (from the right in Arabic). When eight figures do not
 * fit at a readable width, the row scrolls inside its own box (snapping on phones), so the page itself never scrolls
 * sideways. The AI label is permanent (spec §7.1, disclosure).
 *
 * The team is alive (spec §7.3) while the lineup is on screen and the tab is showing (`data-live`): the banter of §5.3
 * plays in speech bubbles and the figures blink and breathe (CSS). A pressed figure answers, and the eyes follow the
 * pointer. Under reduced motion the bubbles still come and go, without moving; nothing else moves.
 */
export default function Lineup({ lang }: { lang: Lang }) {
  const section = useRef<HTMLElement>(null);
  const reduced = useReducedMotion();
  const [active, setActive] = useState(false);
  const [banter, setBanter] = useState<Line | null>(null);
  const [pressed, setPressed] = useState<Line | null>(null);
  const next = useRef(0);

  // On screen and in a visible tab, or not. Either way a change clears the bubble, so a line cut off by a pause never
  // comes back stale when the lineup does.
  useEffect(() => {
    const el = section.current;
    if (!el) return;
    let onScreen = false;
    let was = false;
    const update = () => {
      const now = onScreen && document.visibilityState === "visible";
      if (now === was) return;
      was = now;
      setActive(now);
      setBanter(null);
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        onScreen = entry.isIntersecting;
        update();
      },
      { threshold: 0.25 },
    );
    observer.observe(el);
    document.addEventListener("visibilitychange", update);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  // The banter, one line at a time. An exchange longer than the 8 s beat (four lines) finishes before the next begins;
  // one cut off by a pause starts again from its first line.
  useEffect(() => {
    if (!active) return;
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
      exchange.lines.forEach((l, i) => later(() => setBanter({ who: l.who, text: l.text[lang] }), i * LINE_MS));
      const length = exchange.lines.length * LINE_MS;
      later(() => {
        setBanter(null);
        next.current += 1;
      }, length);
      later(play, Math.max(EXCHANGE_MS, length));
    };
    later(play, FIRST_MS);
    return () => timers.forEach(clearTimeout);
  }, [active, lang]);

  // A pressed figure's answer holds for one line's time; pressing again restarts it.
  useEffect(() => {
    if (!pressed) return;
    const t = setTimeout(() => setPressed(null), LINE_MS);
    return () => clearTimeout(t);
  }, [pressed]);

  // The eyes: one listener for the whole lineup, at most one update a frame. The gaze is measured on screen, so it
  // points at the pointer whatever the reading direction.
  useEffect(() => {
    const el = section.current;
    if (!el || reduced) return;
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
  }, [reduced]);

  const talk = pressed ?? (active ? banter : null);
  const said = talk ? `${CAST.find((m) => m.id === talk.who)?.name[lang]}: ${quote(talk.text, lang)}` : "";

  return (
    <section ref={section} className={styles.lineup} data-testid="lineup" data-live={active || undefined} aria-labelledby="lineup-label">
      <p id="lineup-label" className={styles.aiLabel}>
        {HOME.aiLabel[lang]}
      </p>
      <div className={styles.strip}>
        <ul className={styles.row} style={{ "--n": CAST.length } as CSSProperties}>
          {CAST.map((member, index) => (
            <li key={member.id} className={styles.cell}>
              <Figure
                member={member}
                lang={lang}
                index={index}
                lines={linesOf(member, lang)}
                say={talk?.who === member.id ? quote(talk.text, lang) : undefined}
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
