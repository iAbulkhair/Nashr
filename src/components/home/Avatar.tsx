import type { HomeAgentId } from "@/lib/home";
import type { Look } from "@/lib/stories";
import { AGAL, BEARD, BEARD_SHORT, CROP, DRESS, Ghutra, SHAYLA, THOBE_WHITE } from "./Doodle";
import styles from "./home.module.css";

/**
 * A persona's face in the cast's own hand: the same crop, head, clothes (abaya, white thobe, Faris's jacket), shayla,
 * ghutra, agal and beards as `Doodle.tsx`, which exports them, so the faces match the team's line for line. One thing
 * the cast does not have: these people smile. Brows are always arched up, the eyes are dots or smiling arcs, and a soft
 * smile sits under the nose (drawn in paper over a beard, so it still shows). `seed` picks the eyes and the smile.
 * Decoration only: the role sits beside it. Server-safe, no hooks.
 */

/** Hair worn uncovered, drawn over the face like the cast's `crown`. */
const HAIR = {
  short: <path className={styles.inkFill} d="M85 51 C83 36 91 29 101 29 C111 29 119 35 116 51 C114 44 109 40.5 101 41 C93 40.5 88 44 85 51 Z" />,
  long: <path className={styles.inkFill} d="M84.5 53 C81 38 90 30 101 30 C113 30 121 38 116.5 53 C115 47 112 43 106 41 C98 45 90 46 85.5 49 Z" />,
  bun: (
    <>
      <circle className={styles.inkFill} cx="100" cy="27" r="7.5" />
      <path className={styles.inkFill} d="M85 51 C83 37 91 31 101 31 C111 31 119 36 116 51 C114 44 109 41 101 41 C93 41 88 44 85 51 Z" />
    </>
  ),
  curly: <path className={styles.inkFill} d="M84 52 C77 45 79 36 86 34 C85 26 95 23 100 28 C105 22 116 26 115 34 C122 36 123 46 116 52 C114 44 109 41 100 41 C91 41 87 44 84 52 Z" />,
  cap: (
    <>
      <path className={styles.fill} d="M84.5 47 C84.5 33 92 28 100 28 C110 28 116.5 33 115.5 47 Z" />
      <path className={styles.fill} d="M112 45 C120 45 126 48 128 52 L112 50 Z" />
    </>
  ),
  bald: null,
} as const;

/** Behind the head: long hair falls to the shoulders. */
const HAIR_BACK = <path className={styles.inkFill} d="M82 54 C77 34 89 25 100 25 C111 25 123 34 118 54 C120 76 122 92 125 106 L75 106 C78 92 80 76 82 54 Z" />;

/** Faris's jacket over a white tee, the cast's clothes for everyone who wears neither a thobe nor an abaya. */
const JACKET = (
  <>
    <path className={styles.fill} d="M80 94 C92 90 108 90 120 94 C130 97 135 102 136 112 C137 160 138 210 138 258 C116 264 84 264 62 258 C62 210 63 160 64 112 C65 102 70 97 80 94 Z" />
    <path className={styles.paper} d="M91 95 C95 99 105 99 109 95 L106 260 L94 260 Z" />
    <path d="M91 95 L84 126 L94 138 M109 95 L116 126 L106 138" />
  </>
);

/** The neck, as the cast draws it where no shayla covers it. */
const NECK = <path d="M95 76 L95 92 M105 76 L105 92" />;

/** Always-happy brows: arched up, never slanted. */
const BROWS = ["M88 50 q4.5 -2.6 9 -0.4", "M103 49.6 q4.5 -2.2 9 0.4"];

/** A soft smile, a wide one, and a laugh with the mouth a little open. */
const SMILES = ["M94.5 71 Q100 75.5 105.5 71", "M93 70.5 Q100 77 107 70.5", "M94 70.5 Q100 72 106 70.5 Q100 78 94 70.5 Z"];

export default function Avatar({ look, who, seed }: { look: Look; who: HomeAgentId; seed: string }) {
  const n = [...seed].reduce((a, c) => a + c.charCodeAt(0), 0);
  const arcs = n % 2 === 1;
  const smile = SMILES[(n >> 1) % SMILES.length];
  const covered = !!look.wear;
  const body = look.wear === "shayla" ? DRESS : look.wear === "ghutra" ? THOBE_WHITE : JACKET;
  return (
    <svg viewBox={CROP.face} className={`${styles.doodle} ${styles.crop}`} data-cast={who} aria-hidden="true">
      {look.hair === "long" && !covered && HAIR_BACK}
      {body}
      {look.wear !== "shayla" && NECK}
      {look.wear === "ghutra" && <Ghutra />}
      {look.wear === "shayla" && SHAYLA}
      <ellipse className={styles.paper} cx="100" cy="58" rx="15.5" ry="20" />
      {!covered && HAIR[look.hair]}
      {look.wear === "ghutra" && AGAL}
      {look.beard === "full" && BEARD}
      {look.beard === "stubble" && BEARD_SHORT}
      <path className={styles.fine} d="M100 60 L98.5 66 L100.5 66.5" />
      {arcs ? (
        <path d="M91 58 q3 -3.4 6 0 M103 58 q3 -3.4 6 0" />
      ) : (
        <>
          <circle className={styles.dot} cx="94" cy="57" r="2.2" />
          <circle className={styles.dot} cx="106" cy="57" r="2.2" />
        </>
      )}
      {BROWS.map((d, i) => (
        <path key={i} d={d} />
      ))}
      {look.beard ? (
        <path className={styles.smileOnInk} d="M95 74.5 Q100 77.5 105 74.5" />
      ) : (
        <path className={smile.endsWith("Z") ? styles.paper : undefined} d={smile} />
      )}
      {look.glasses && (
        <>
          <ellipse className={styles.fine} cx="94" cy="57" rx="6" ry="5" />
          <ellipse className={styles.fine} cx="106" cy="57" rx="6" ry="5" />
        </>
      )}
    </svg>
  );
}
