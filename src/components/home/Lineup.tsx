"use client";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import Scribble from "@/components/Scribble";
import { CAST, HERO, HOME, type CastId } from "@/lib/home";
import type { Lang } from "@/lib/i18n";
import Doodle from "./Doodle";
import MotionToggle from "./MotionToggle";
import { useMotionPaused, useReducedMotion, useShowing } from "./motion";
import styles from "./home.module.css";

/** How much the chosen figure grows; the same number as `.who:is(…) .fig` in home.module.css. */
const GROW = 1.25;
/** The two agents whose colour is dark enough to need paper text on their name tag. */
const DARK: CastId[] = ["faris", "majed"];
/** How long a thought stays after the pointer or focus leaves its figure. */
const LINGER_MS = 450;
/** The cloud keeps this far inside the row, so its drawing (which overhangs its box by 4px) never widens the page. */
const EDGE = 8;
/** On their own (rule 1832), each figure thinks for `SAY_MS`, then the row rests for `REST_MS` before the next one. */
export const SAY_MS = 3800;
export const REST_MS = 1200;

/**
 * Whether the figures take turns thinking on their own (rules 1832, 1833; WCAG 2.2.2): never for a visitor who asks for
 * less motion or who paused the page's motion, not while the row is off screen or the tab hidden, and not while a
 * visitor holds a figure (pointer, keyboard focus or a tap): their figure keeps its thought until they let go, and the
 * row stays still while keyboard focus is on any figure.
 */
export const takesTurns = (s: { reduced: boolean; paused: boolean; showing: boolean; held: boolean }) =>
  !s.reduced && !s.paused && s.showing && !s.held;

/**
 * The team standing together, Noor first in the reading direction (prototype D's cover, rule 515). The row wraps: nine
 * in one row from 1200px, five and four from 600px, three rows of three below. Every figure keeps one size; the chosen
 * one (pointer, keyboard focus, or a tap) grows from its feet by a transform only, so nothing around it moves.
 *
 * Choosing a figure shows one of its questions in a thought cloud above its head, the next one each time; the owner
 * thinks the finale's word. The cloud is decoration; its text is mirrored into a polite live region for keyboard focus and taps (a passing
 * mouse stays silent), and at most one figure is pressed: tabbing on releases it. A tap keeps the
 * figure chosen (one at a time) until it is tapped again, another is chosen, Escape is pressed or the page is tapped
 * elsewhere. The AI label is permanent (disclosure). Under the owner, a caption: «…and this is you». It sits inside
 * the cover section (`Cover.tsx`), so its root is a labelled group, not a section.
 *
 * With no one holding a figure, the figures take turns on their own (rule 1832): one at a time in reading order, each
 * grown with its thought for `SAY_MS`, then a rest of `REST_MS`. Those turns are silent (the live region stays empty,
 * rule 1834), and they stop for reduced motion, the page's pause button, an off-screen row or a hidden tab (rule 1833).
 * Pointing at, focusing or tapping a figure takes the cloud from the turns at once and holds it until let go.
 */
export default function Lineup({ lang }: { lang: Lang }) {
  const wrap = useRef<HTMLDivElement>(null);
  const cloud = useRef<HTMLParagraphElement>(null);
  const turn = useRef<Partial<Record<CastId, number>>>({});
  const linger = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [shown, setShown] = useState<CastId | null>(null);
  const [pressed, setPressed] = useState<CastId | null>(null);
  const [text, setText] = useState("");
  const [said, setSaid] = useState("");
  // The cloud's tail points down to the right when its figure stands in the right half of the row.
  const [right, setRight] = useState(false);
  // True while the shown thought is the row's own turn, not a visitor's choice.
  const [turning, setTurning] = useState(false);
  // True while keyboard focus sits on a figure: the row stays still under it, as the scenes' slider does.
  const [focused, setFocused] = useState(false);
  const order = useRef(0);
  const paused = useMotionPaused();
  const reduced = useReducedMotion();
  const showing = useShowing(wrap, { threshold: 0.3 });

  const next = (id: CastId) => {
    if (id === "you") return HOME.finaleWord[lang];
    const qs = CAST.find((m) => m.id === id)?.questions ?? [];
    const k = turn.current[id] ?? 0;
    turn.current[id] = k + 1;
    return qs.length ? qs[k % qs.length][lang] : "";
  };

  // `speak`: keyboard focus and taps are announced; a mouse passing over the row is not, or every hover would talk.
  const show = (id: CastId, speak: boolean, turn = false) => {
    clearTimeout(linger.current);
    const t = next(id);
    setShown(id);
    setText(t);
    setTurning(turn);
    setSaid(speak ? `${CAST.find((m) => m.id === id)?.name[lang]}: ${t}` : "");
  };

  // A visitor reaches a figure: a new thought, or, when that figure is already thinking (its own turn or a lingering
  // cloud), the same thought, now theirs to keep.
  const take = (id: CastId, speak: boolean) => {
    if (shown !== id) return show(id, speak);
    clearTimeout(linger.current);
    if (turning) {
      setTurning(false);
      if (speak) setSaid(`${CAST.find((m) => m.id === id)?.name[lang]}: ${text}`);
    }
  };

  const hide = (ms = 0) => {
    clearTimeout(linger.current);
    linger.current = setTimeout(() => {
      setShown(null);
      setPressed(null);
      setTurning(false);
      setSaid("");
    }, ms);
  };

  useEffect(() => () => clearTimeout(linger.current), []);

  // The row's own turns: rest, think, rest, the next one in reading order, round and round (rule 1832).
  const turns = takesTurns({ reduced, paused, showing, held: focused || (shown !== null && !turning) });
  useEffect(() => {
    if (!turns) return;
    const t = setTimeout(
      () => {
        if (turning) return hide();
        show(CAST[order.current % CAST.length].id, false, true);
        order.current += 1;
      },
      turning ? SAY_MS : REST_MS,
    );
    return () => clearTimeout(t);
    // `show` is recreated each render; the timer restarts only when the turn changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns, turning, shown]);

  // Motion paused, the row off screen or the tab hidden: a thought the row was showing on its own goes away (rule 1833).
  useEffect(() => {
    if (turning && (reduced || paused || !showing)) hide();
  }, [turning, reduced, paused, showing]);

  // Escape, or a tap anywhere outside the row, puts the chosen figure back.
  useEffect(() => {
    if (!shown || turning) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) hide();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [shown, turning]);

  // The cloud sits above the chosen head at its grown size, inside the row's width, its tail's tip over the head.
  useLayoutEffect(() => {
    const box = wrap.current;
    const el = cloud.current;
    if (!box || !el || !shown) return;
    const place = () => {
      const fig = box.querySelector<HTMLElement>(`[data-id="${shown}"] .${styles.fig}`);
      if (!fig) return;
      const b = box.getBoundingClientRect();
      const f = fig.getBoundingClientRect();
      const cx = f.left - b.left + f.width / 2;
      const onRight = cx > b.width / 2;
      if (onRight !== right) setRight(onRight);
      el.style.width = "";
      el.style.left = `${EDGE}px`;
      const w = Math.ceil(el.getBoundingClientRect().width);
      el.style.width = `${w}px`;
      // The tail's tip, from the cloud's own drawing (`cloud` in `@/lib/scribble`).
      const cw = el.clientWidth;
      const ch = el.clientHeight;
      const puff = Math.max(6, Math.min(12, 0.16 * Math.min(cw, ch)));
      const tipX = cw / 2 + (onRight ? 1 : -1) * (0.55 * (cw / 2 - puff) + 14);
      const tipY = ch - 0.2 * puff + 34;
      const tall = fig.offsetHeight * GROW;
      el.style.left = `${Math.max(EDGE, Math.min(b.width - w - EDGE, cx - tipX))}px`;
      el.style.top = `${f.bottom - b.top - tall + tall * 0.04 - tipY}px`;
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [shown, text, right]);

  return (
    <div className={styles.lineup} data-testid="lineup" role="group" aria-labelledby="lineup-label">
      <div className={styles.lineupHead}>
        <p id="lineup-label" className={styles.aiLabel}>
          {HOME.aiLabel[lang]}
        </p>
        <MotionToggle lang={lang} />
      </div>
      <div
        ref={wrap}
        className={styles.castWrap}
        onFocus={(e) => setFocused(e.target.matches(":focus-visible"))}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
        }}
      >
        <p ref={cloud} className={`s-cloud ${styles.think}`} data-on={shown ? "" : undefined} aria-hidden="true">
          <Scribble kind="cloud" seed="think" fill="paper" tail="bottom" rtl={right} />
          <span className={styles.thinkText}>{text}</span>
        </p>
        <p className={styles.srOnly} aria-live="polite" aria-atomic="true">
          {said}
        </p>
        {/* `role="list"`: Safari drops the list semantics of a list drawn without markers. */}
        <ul className={styles.cast} role="list">
          {CAST.map((member) => (
            <li key={member.id}>
              <button
                type="button"
                className={styles.who}
                data-id={member.id}
                data-dark={DARK.includes(member.id) ? "" : undefined}
                aria-pressed={pressed === member.id}
                data-turn={turning && shown === member.id ? "" : undefined}
                style={{ "--tag": `var(--color-agent-${member.id})` } as CSSProperties}
                onPointerEnter={(e) => {
                  if (e.pointerType === "touch") return;
                  if (pressed && pressed !== member.id) setPressed(null);
                  take(member.id, false);
                }}
                onPointerLeave={(e) => {
                  if (e.pointerType !== "touch" && pressed !== member.id) hide(LINGER_MS);
                }}
                onFocus={(e) => {
                  // Tabbing on from a pressed figure releases it: one pressed figure at most, and only the focused one.
                  if (pressed && pressed !== member.id) setPressed(null);
                  if (e.currentTarget.matches(":focus-visible")) take(member.id, true);
                }}
                onBlur={() => {
                  if (pressed !== member.id) hide(LINGER_MS);
                }}
                onClick={() => {
                  if (pressed === member.id) return hide();
                  setPressed(member.id);
                  show(member.id, true);
                }}
              >
                <span className={styles.fig}>
                  <span className={styles.pud}>
                    <Scribble kind="puddle" seed={`pud-${member.id}`} fill={`agent-${member.id}`} />
                  </span>
                  <Doodle who={member.id} />
                </span>
                <span className={`s-tag ${styles.tag}`}>
                  <Scribble kind="box" seed={`tag-${member.id}`} fill="var(--tagfill)" />
                  {member.name[lang]}
                </span>
              </button>
              {member.id === "you" && (
                <p className={`s-tag ${styles.mecap}`}>
                  <Scribble kind="box" seed="mecap" fill="lilac" />
                  {HERO.mecap[lang]}
                </p>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
