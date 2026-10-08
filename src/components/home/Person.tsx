import type { Look } from "@/lib/home";
import styles from "./home.module.css";

/**
 * A smiling head and shoulders for the scenes under the cover (rule 775), drawn in the cast's own line (Doodle.tsx):
 * one plum stroke, flat colour on the clothing and headwear only, the head on the same 200-wide grid as the cast so the
 * shayla, ghutra and beards sit where theirs do. Unlike the cast, these faces have a mouth: they are happy people in a
 * scene, not the editorial team. Decoration: the role is written beside it. Server-safe.
 */

/** Shoulders and clothing, cut by the frame. */
const SHOULDERS = "M58 128 C58 106 70 96 86 93 C92 92 108 92 114 93 C130 96 142 106 142 128 Z";

/** Shayla: close round the face, one end across the chest (as Doodle's, in the person's colour). */
const SHAYLA = (
  <>
    <path className={styles.fill} d="M100 31 C84 31 76 44 76 60 C76 74 78 86 73 99 C85 107 98 113 114 116 C122 117 128 116 134 111 C130 104 126 99 124 93 C125 83 125 72 124 60 C124 44 116 31 100 31 Z" />
    <path className={styles.fine} d="M83 87 C94 98 110 104 126 104" />
  </>
);

/** Ghutra (white) or shemagh (the person's colour, with its check): standing off the face, ends over the shoulders. */
function Ghutra({ shemagh }: { shemagh?: boolean }) {
  return (
    <>
      <path className={shemagh ? styles.fill : styles.paper} d="M100 19 C82 20 69 31 66 50 C63 74 61 104 52 150 C62 156 73 154 81 146 C83 124 85 104 87 90 C90 84 110 84 113 90 C115 104 117 124 119 146 C127 154 138 156 148 150 C139 104 137 74 134 50 C131 31 118 20 100 19 Z" />
      <path className={styles.fine} d="M94 21 L100 32 L106 21" />
      {shemagh && <path className={styles.fine} d="M74 44 L80 50 M70 66 L76 72 M126 44 L120 50 M130 66 L124 72 M84 28 L88 32 M116 28 L112 32" />}
    </>
  );
}

/** Agal: lifted a little off the cast's line so the brows stay clear at this size. */
const AGAL = (
  <g transform="translate(0 -6)">
    <path className={styles.inkFill} d="M72 38 C82 28 118 28 128 38 L127 44 C117 35 83 35 73 44 Z" />
    <path className={styles.inkFill} d="M73 46 C83 37 117 37 127 46 L126 51 C116 43 84 43 74 51 Z" />
  </g>
);

const HAIR = {
  hair: <path className={styles.inkFill} d="M84.5 53 C81 38 90 30 101 30 C113 30 121 38 116.5 53 C115 47 112 43 106 41 C98 45 90 46 85.5 49 Z" />,
  curls: (
    <path
      className={styles.inkFill}
      d="M84 54 C79 50 79 43 83 40 C82 34 88 30 93 32 C96 28 104 28 107 32 C112 30 118 34 117 40 C121 43 121 50 116 54 C115 48 112 44 107 43 C104 46 96 46 93 43 C88 44 85 48 84 54 Z"
    />
  ),
};

/** Beards leave the mouth open: the grin is drawn over them. */
const BEARD = {
  full: <path className={styles.inkFill} d="M84.5 58 C84.5 72 90.5 81 100 81 C109.5 81 115.5 72 115.5 58 C113.5 66 111 70 107.5 71 C104 68.5 96 68.5 92.5 71 C89 70 86.5 66 84.5 58 Z" />,
  short: <path className={styles.inkFill} d="M86 63 C87 73 92.5 79 100 79 C107.5 79 113 73 114 63 C111.5 69 108.5 71.5 106 72 C103 69.5 97 69.5 94 72 C91.5 71.5 88.5 69 86 63 Z" />,
};

export default function Person({ look }: { look: Look }) {
  const { head, beard, glasses, eyes, tone } = look;
  const wrapped = head === "ghutra" || head === "shemagh";
  // A beard lifts the grin a little, so it sits on the moustache line.
  const my = beard ? 1.5 : 0;
  return (
    <svg viewBox="58 14 84 84" className={`${styles.doodle} ${styles.crop}`} style={{ "--fill": `var(--color-agent-${tone})` } as React.CSSProperties} aria-hidden="true">
      {/* Clothing: the shayla wraps it in her colour; a thobe is white under a ghutra; a shirt is the colour. */}
      <path className={wrapped ? styles.paper : styles.fill} d={SHOULDERS} />
      {wrapped && <path className={styles.fine} d="M90 94 C94 99 106 99 110 94 M100 98 L100 128" />}
      {(head === "hair" || head === "curls") && <path className={styles.paper} d="M94 74 L94 94 C97 97 103 97 106 94 L106 74 Z" />}
      {head === "shayla" && SHAYLA}
      {wrapped && <Ghutra shemagh={head === "shemagh"} />}
      <ellipse className={styles.paper} cx="100" cy="58" rx="15.5" ry="20" />
      {(head === "hair" || head === "curls") && HAIR[head]}
      {wrapped && AGAL}
      {beard && BEARD[beard]}
      {/* Cheeks: a soft blush, no line. */}
      <ellipse className={styles.blush} cx="89.5" cy="64.5" rx="3.6" ry="2" />
      <ellipse className={styles.blush} cx="110.5" cy="64.5" rx="3.6" ry="2" />
      {/* Brows lifted, then the eyes: laughing arcs or open dots. */}
      <path d="M89 48.5 q4 -3 8 -1.5 M103 47 q4 -1.5 8 1.5" />
      {eyes === "laugh" ? (
        <path d="M90.5 56.5 q3 -3.6 6 0 M103.5 56.5 q3 -3.6 6 0" />
      ) : (
        <>
          <circle className={styles.dot} cx="93.5" cy="55.5" r="2.2" />
          <circle className={styles.dot} cx="106.5" cy="55.5" r="2.2" />
        </>
      )}
      {glasses && <path className={styles.fine} d="M88 55.5 a5.5 5 0 1 0 11 0 a5.5 5 0 1 0 -11 0 M101 55.5 a5.5 5 0 1 0 11 0 a5.5 5 0 1 0 -11 0 M99 55 q1 -1 2 0 M88 54.5 L84.5 53.5 M112 54.5 L115.5 53.5" />}
      <path className={styles.fine} d="M100 59.5 L98.5 63.5 L100.5 64" />
      {/* The grin: open and white, a small line for the tongue. */}
      <path className={styles.paper} d={`M93 ${67.5 - my} Q100 ${76 - my} 107 ${67.5 - my} Q100 ${69.5 - my} 93 ${67.5 - my} Z`} />
      <path className={styles.fine} d={`M97 ${71.6 - my} Q100 ${70.4 - my} 103 ${71.6 - my}`} />
    </svg>
  );
}
