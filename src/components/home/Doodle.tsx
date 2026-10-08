import type { ReactNode } from "react";
import type { CastId } from "@/lib/home";
import styles from "./home.module.css";

/**
 * Placeholder figures for the Thakeen cast, drawn in code until the illustrator's art arrives (spec §7.1).
 *
 * THE PART CONTRACT (the illustrator's delivery spec): each figure is one `<svg viewBox="0 0 200 480">` whose groups
 * carry `data-part` = `body`, `head` (with `eyes` and `brows` inside it, so they turn with the head), `arm-l` (the arm on
 * the viewer's left), `arm-r` and `prop`. A prop worn on the head (glasses, headphones) sits inside `head`; a small item
 * gripped in one hand (Reem's pencil) may sit inside that hand's arm group, so it moves with the hand; a figure with
 * nothing to hold keeps an empty `prop`. When the figure turns, the head and the `prop` mirror but the arms do not, so
 * a prop that a hand-held item points into (Reem's planner) is marked to keep its side. Final SVGs replace these
 * bodies without code changes.
 *
 * Style: one 3 px plum line, flat fill in the member's colour on the clothing only, a few strokes for the face.
 * Server-safe: no hooks, no browser APIs.
 */

type P = readonly [number, number];
type Part = "body" | "arm-l" | "arm-r" | "head" | "prop";

type Figure = {
  /** Paint order, back to front. */
  order: readonly Part[];
  body: ReactNode;
  armL: ReactNode;
  armR: ReactNode;
  /** Behind the face: shayla, ghutra. */
  headwear?: ReactNode;
  /** Over the face: hair, agal. */
  crown?: ReactNode;
  /** Beard and moustache, over the face and under the nose line. */
  beard?: ReactNode;
  eyes: readonly P[];
  brows: readonly string[];
  /** One fine stroke; the face is eyes, brows and a nose, no mouth (editorial, not cartoon). */
  nose: string;
  /** Worn on the head; turns with it. */
  headProp?: ReactNode;
  /** Held or worn on the body. */
  prop?: ReactNode;
  /** The vertical line the body prop mirrors across when the figure turns. */
  axis?: number;
  /**
   * The body prop keeps its side when the figure turns: for a prop that an item held in an arm group points into, since
   * the arms never mirror and a mirrored prop would slide away from the hand (and read backwards).
   */
  propStays?: boolean;
};

const r1 = (v: number) => Math.round(v * 10) / 10;
const pt = ([x, y]: P) => `${r1(x)} ${r1(y)}`;

/**
 * One limb segment (upper arm, forearm, leg) as a filled shape around the line a→b, `wa` wide at a and `wb` at b,
 * rounded at b. Left open at a, so no seam is drawn where it joins the body or the previous segment.
 */
function segment(a: P, b: P, wa: number, wb: number): string {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const at = (p: P, w: number, side: 1 | -1): P => [p[0] + side * nx * w, p[1] + side * ny * w];
  const mid: P = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const bow = (wa + wb) / 4 + 1.5;
  return `M${pt(at(a, wa / 2, 1))} Q${pt(at(mid, bow, 1))} ${pt(at(b, wb / 2, 1))} A${r1(wb / 2)} ${r1(wb / 2)} 0 0 0 ${pt(at(b, wb / 2, -1))} Q${pt(at(mid, bow, -1))} ${pt(at(a, wa / 2, -1))}`;
}

/** A sleeve or leg through `pts` (shoulder, elbow, wrist), widths per point, with an optional hand at the end. */
function Limb({ pts, w, hand = true, tone = "fill" }: { pts: readonly P[]; w: readonly number[]; hand?: boolean; tone?: "fill" | "paper" }) {
  const [a, b] = [pts[pts.length - 2], pts[pts.length - 1]];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const ux = (b[0] - a[0]) / len;
  const uy = (b[1] - a[1]) / len;
  const deg = r1((-Math.atan2(ux, uy) * 180) / Math.PI);
  const hx = r1(b[0] + ux * 6);
  const hy = r1(b[1] + uy * 6);
  return (
    <>
      {pts.slice(1).map((p, i) => (
        <path key={i} className={styles[tone]} d={segment(pts[i], p, w[i], w[i + 1])} />
      ))}
      {hand && <ellipse className={styles.paper} cx={hx} cy={hy} rx="4.4" ry="7" transform={`rotate(${deg} ${hx} ${hy})`} />}
    </>
  );
}

const SLEEVE = [14, 11.5, 9.5] as const;
const ARM_L_DOWN: readonly P[] = [[76, 106], [67, 170], [64, 232]];
const ARM_R_DOWN: readonly P[] = [[124, 106], [133, 170], [136, 232]];

/** Long abaya, A-line, open seam down the front. */
export const DRESS = (
  <>
    <path className={styles.fill} d="M82 94 C92 91 108 91 118 94 C127 97 131 102 132 112 C134 150 131 190 128 226 C136 296 146 366 152 428 C120 436 80 436 48 428 C54 366 64 296 72 226 C69 190 66 150 68 112 C69 102 73 97 82 94 Z" />
    <path d="M100 108 C101 200 100 330 100 432" />
    <path d="M91 435 L90 454.5 M109 435 L110 454.5" />
    <path className={styles.inkFill} d="M92 453.5 L89 453.5 C85 455.5 80 457.5 79 461.5 L93 461.5 Z M108 453.5 L111 453.5 C115 455.5 120 457.5 121 461.5 L107 461.5 Z" />
  </>
);

/** Shayla: close around the face, one end wrapped across the chest to the far shoulder. */
export const SHAYLA = (
  <>
    <path className={styles.paper} d="M100 32 C85 32 77 44 77 60 C77 74 79 86 75 99 C86 106 98 112 113 115 C121 116 127 115 132 111 C129 104 125 99 123 93 C124 83 124 72 123 60 C123 44 115 32 100 32 Z" />
    <path className={styles.fine} d="M84 86 C94 97 110 103 125 103" />
  </>
);

/** White thobe for the men: a straight column to the ankle, buttoned placket at the neck. */
export const THOBE_WHITE = (
  <>
    <path className={styles.paper} d="M80 94 C92 90 108 90 120 94 C130 97 135 102 136 112 C139 200 139 330 137 442 C114 448 86 448 63 442 C61 330 61 200 64 112 C65 102 70 97 80 94 Z" />
    <path d="M100 98 L100 160" />
    <path className={styles.fine} d="M90 96 C94 101 106 101 110 96" />
    <path d="M90 447 L89 457 M110 447 L111 457" />
    <path className={styles.inkFill} d="M91 456 L88 456 C84 458 79 460 78 464 L92 464 Z M109 456 L112 456 C116 458 121 460 122 464 L108 464 Z" />
  </>
);

/**
 * Ghutra or shemagh: symmetric, standing off the face with a pinched peak at the front of the crown, both ends falling
 * straight down over the shoulders (the shayla, by contrast, hugs the face and wraps across the chest).
 */
export function Ghutra({ tone = "paper" }: { tone?: "paper" | "fill" }) {
  return (
    <>
      <path className={styles[tone]} d="M100 19 C82 20 69 31 66 50 C63 74 61 104 52 150 C62 156 73 154 81 146 C83 124 85 104 87 90 C90 84 110 84 113 90 C115 104 117 124 119 146 C127 154 138 156 148 150 C139 104 137 74 134 50 C131 31 118 20 100 19 Z" />
      <path className={styles.fine} d="M94 21 L100 32 L106 21" />
      <path className={styles.fine} d="M70 96 C68 116 64 134 58 148 M130 96 C132 116 136 134 142 148" />
    </>
  );
}

/** Agal: two thick black cords ringing the crown of the ghutra. */
export const AGAL = (
  <>
    <path className={styles.inkFill} d="M72 38 C82 28 118 28 128 38 L127 44 C117 35 83 35 73 44 Z" />
    <path className={styles.inkFill} d="M73 46 C83 37 117 37 127 46 L126 51 C116 43 84 43 74 51 Z" />
  </>
);

/** A trimmed full beard with a moustache: the clearest "this is a man" cue at lineup size. */
export const BEARD = (
  <>
    <path className={styles.inkFill} d="M84.5 58 C84.5 71 90.5 80 100 80 C109.5 80 115.5 71 115.5 58 C113.5 66 110.5 71 106.5 72.5 C103.5 70.5 96.5 70.5 93.5 72.5 C89.5 71 86.5 66 84.5 58 Z" />
    <path className={styles.inkFill} d="M93 69.5 C96 67 104 67 107 69.5 C104 71 96 71 93 69.5 Z" />
  </>
);

/** Short beard and moustache for the owner: stubble-length, so he reads younger than the elders. */
export const BEARD_SHORT = (
  <>
    <path className={styles.inkFill} d="M86 64 C87 73 92.5 78.5 100 78.5 C107.5 78.5 113 73 114 64 C111 70 107 73 104 73.5 C102 72.5 98 72.5 96 73.5 C93 73 89 70 86 64 Z" />
    <path className={styles.inkFill} d="M94.5 69.5 C97 68 103 68 105.5 69.5 C103 70.5 97 70.5 94.5 69.5 Z" />
  </>
);

const FIGURES: Record<CastId, Figure> = {
  // Noor: content. Hand on hip, phone on a small ring light held up, glancing at it.
  noor: {
    order: ["body", "prop", "arm-l", "arm-r", "head"],
    body: (
      <>
        <path className={styles.fill} d="M82 94 C92 91 108 91 118 94 C127 97 131 102 132 112 C134 150 131 190 128 226 C138 296 150 366 158 426 C126 436 86 438 54 430 C60 366 66 296 72 226 C69 190 66 150 68 112 C69 102 73 97 82 94 Z" />
        <path d="M100 108 C101 200 103 330 106 434" />
        <path d="M97 436 L96 454.5 M117 436 L118 454.5" />
    <path className={styles.inkFill} d="M98 453.5 L95 453.5 C91 455.5 86 457.5 85 461.5 L99 461.5 Z M116 453.5 L119 453.5 C123 455.5 128 457.5 129 461.5 L115 461.5 Z" />
      </>
    ),
    armL: <Limb pts={[[76, 106], [58, 160], [76, 206]]} w={SLEEVE} />,
    armR: <Limb pts={[[124, 106], [150, 146], [158, 114]]} w={SLEEVE} />,
    headwear: SHAYLA,
    eyes: [[98, 57], [109, 57]],
    brows: ["M91 49 q4 -3.5 9 -2", "M104 48 q4 -2.5 8 0"],
    nose: "M101.5 60 L103.5 66 L101 66.5",
    prop: (
      <>
        <path d="M160 104 L160 98" />
        <path className={styles.fill} fillRule="evenodd" d="M143 81 a17 17 0 1 0 34 0 a17 17 0 1 0 -34 0 Z M149 81 a11 11 0 1 0 22 0 a11 11 0 1 0 -22 0 Z" />
        <rect className={styles.paper} x="154.5" y="71" width="11" height="20" rx="2.5" />
      </>
    ),
    axis: 160,
  },

  // Sami: sales. White thobe, his colour in the shemagh. Phone to the ear, the other hand open mid-sentence.
  sami: {
    order: ["body", "arm-l", "head", "prop", "arm-r"],
    body: THOBE_WHITE,
    armL: <Limb pts={[[76, 106], [64, 166], [52, 214]]} w={SLEEVE} tone="paper" />,
    armR: <Limb pts={[[124, 106], [150, 138], [131, 90]]} w={SLEEVE} tone="paper" />,
    headwear: <Ghutra tone="fill" />,
    crown: AGAL,
    beard: BEARD,
    eyes: [[93, 58], [104, 58]],
    brows: ["M88 50 q4 -2 9 0", "M101 48 q5 -3 9 0"],
    nose: "M98.5 60 L96.5 66 L99 66.5",
    prop: <rect className={styles.paper} x="119" y="52" width="10" height="24" rx="2.5" transform="rotate(-14 124 64)" />,
    axis: 124,
  },

  // Razan: finance. Looking over her reading glasses, pocket calculator in hand.
  razan: {
    order: ["body", "prop", "arm-l", "arm-r", "head"],
    body: DRESS,
    armL: <Limb pts={[[76, 106], [62, 172], [90, 196]]} w={SLEEVE} />,
    armR: <Limb pts={ARM_R_DOWN} w={SLEEVE} />,
    headwear: SHAYLA,
    eyes: [[92.5, 55.5], [105.5, 55.5]],
    brows: ["M87 48.5 L97 49.5", "M101 46 q5 -3.5 10 -1"],
    nose: "M100 60 L98.5 66 L100.5 66.5",
    headProp: (
      <>
        <circle className={styles.fine} cx="92.5" cy="62" r="5.2" />
        <circle className={styles.fine} cx="105.5" cy="62" r="5.2" />
        <path className={styles.fine} d="M97.7 61.5 Q99 60 100.3 61.5" />
      </>
    ),
    prop: (
      <g transform="rotate(-6 106 178)">
        <rect className={styles.paper} x="93" y="160" width="26" height="36" rx="3.5" />
        <rect className={styles.fine} x="97" y="165" width="18" height="7" rx="1" />
        {[180, 186, 192].flatMap((y) => [99, 106, 113].map((x) => <circle key={`${x}-${y}`} className={styles.dot} cx={x} cy={y} r="1.4" />))}
      </g>
    ),
    axis: 106,
  },

  // Faris: growth. The young one: short hair, trimmed beard, open jacket over a white tee, trousers, mid-stride.
  faris: {
    order: ["body", "arm-l", "arm-r", "prop", "head"],
    body: (
      <>
        <Limb pts={[[90, 252], [80, 352], [70, 446]]} w={[20, 15, 12]} hand={false} tone="paper" />
        <Limb pts={[[110, 252], [122, 352], [135, 446]]} w={[20, 15, 12]} hand={false} tone="paper" />
        <path className={styles.inkFill} d="M58 452 C59 444 71 442 77 446 L77 456 C69 458 60 457 58 452 Z" />
        <path className={styles.inkFill} d="M128 447 C134 443 147 445 154 451 C154 456 147 458 128 457 Z" />
        <path className={styles.fill} d="M80 94 C92 90 108 90 120 94 C130 97 135 102 136 112 C137 160 138 210 138 258 C116 264 84 264 62 258 C62 210 63 160 64 112 C65 102 70 97 80 94 Z" />
        <path className={styles.paper} d="M91 95 C95 99 105 99 109 95 L106 260 L94 260 Z" />
        <path d="M91 95 L84 126 L94 138 M109 95 L116 126 L106 138" />
        <path d="M95 76 L95 92 M105 76 L105 92" />
      </>
    ),
    armL: <Limb pts={[[76, 106], [70, 168], [82, 222]]} w={SLEEVE} />,
    armR: <Limb pts={[[124, 106], [138, 164], [150, 214]]} w={SLEEVE} />,
    crown: <path className={styles.inkFill} d="M85 51 C83 36 91 29 101 29 C111 29 119 35 116 51 C114 44 109 40.5 101 41 C93 40.5 88 44 85 51 Z" />,
    beard: BEARD,
    eyes: [[97, 58], [108, 58]],
    brows: ["M90 50 L99 51.5", "M103 51.5 L112 49.5"],
    nose: "M101.5 60 L103.5 66 L101 66.5",
  },

  // Dana: reports. Clipboard held close, a single pearl.
  dana: {
    order: ["body", "arm-l", "prop", "arm-r", "head"],
    body: DRESS,
    armL: <Limb pts={ARM_L_DOWN} w={SLEEVE} />,
    armR: <Limb pts={[[124, 106], [137, 168], [110, 190]]} w={SLEEVE} />,
    headwear: SHAYLA,
    eyes: [[94, 58], [105, 58]],
    brows: ["M88 50.5 q4.5 -1.5 9 0", "M101 50.5 q4.5 -1.5 9 0"],
    nose: "M100 60 L98.5 66 L100.5 66.5",
    prop: (
      <>
        <path className={styles.fine} d="M91 96 C94 108 106 108 109 96" />
        <circle className={styles.paper} cx="100" cy="110" r="4.6" />
        <g transform="rotate(-5 100 153)">
          <rect className={styles.paper} x="80" y="124" width="40" height="58" rx="3.5" />
          <rect className={styles.inkFill} x="92" y="119" width="16" height="9" rx="2" />
          <path className={styles.fine} d="M87 141 L113 141 M87 151 L113 151 M87 161 L106 161" />
        </g>
      </>
    ),
    axis: 100,
  },

  // Majed: strategy. Bisht over a white thobe, gold edges, hands folded.
  majed: {
    order: ["body", "prop", "arm-l", "arm-r", "head"],
    body: (
      <>
        <path className={styles.fill} d="M80 94 C92 90 108 90 120 94 C132 97 140 104 142 116 C146 200 148 320 150 440 C120 448 80 448 50 440 C52 320 54 200 58 116 C60 104 68 97 80 94 Z" />
        <path className={styles.paper} d="M91 97 L109 97 C111 200 113 320 115 445 L85 445 C87 320 89 200 91 97 Z" />
        <path d="M92 448 L91 457 M108 448 L109 457" />
    <path className={styles.inkFill} d="M93 456 L90 456 C86 458 81 460 80 464 L94 464 Z M107 456 L110 456 C114 458 119 460 120 464 L106 464 Z" />
      </>
    ),
    armL: <Limb pts={[[72, 108], [64, 176], [92, 228]]} w={[18, 16, 13]} />,
    armR: <Limb pts={[[128, 108], [136, 176], [108, 228]]} w={[18, 16, 13]} />,
    headwear: <Ghutra />,
    crown: AGAL,
    beard: BEARD,
    eyes: [[93, 58], [104, 58]],
    brows: ["M87.5 51 q4.5 -2 9.5 0.5", "M101 51.5 q5 -2.5 9.5 -0.5"],
    nose: "M98.5 60 L96.5 66 L99 66.5",
    prop: <path className={styles.gold} d="M91 97 C89 200 87 320 85 445 M109 97 C111 200 113 320 115 445 M83 95 C92 103 108 103 117 95" />,
    axis: 100,
  },

  // Layan: customers. Headphones on, one hand on the ear cup, listening.
  layan: {
    order: ["body", "arm-l", "head", "arm-r"],
    body: DRESS,
    armL: <Limb pts={ARM_L_DOWN} w={SLEEVE} />,
    armR: <Limb pts={[[124, 106], [148, 140], [132, 86]]} w={SLEEVE} />,
    headwear: SHAYLA,
    eyes: [[95, 57], [106, 57]],
    brows: ["M89 49 q4.5 -3 9 -1.5", "M102 48.5 q4.5 -2 9 0"],
    nose: "M100 60 L98.5 66 L100.5 66.5",
    headProp: (
      <>
        <path d="M76 58 C73 17 127 17 124 58" />
        <rect className={styles.inkFill} x="69" y="49" width="12" height="22" rx="5" />
        <rect className={styles.inkFill} x="119" y="49" width="12" height="22" rx="5" />
      </>
    ),
  },

  // Reem: the secretary (DRAFT drawing, pending the founder's approval). A small spiral planner held up at the chest,
  // one item ticked, the pencil on the next line; eyes down on her list. The pencil is in her hand, so it sits in `arm-r`
  // and stays with it when she turns; the planner stays too (`propStays`), so the tick still reads the right way round
  // and the pencil still lands on the next line. Only her head turns.
  reem: {
    order: ["body", "prop", "arm-l", "arm-r", "head"],
    body: DRESS,
    armL: <Limb pts={[[76, 106], [62, 166], [84, 163]]} w={SLEEVE} />,
    armR: (
      <>
        <g transform="translate(107 152.6) rotate(-58)">
          <path className={`${styles.paper} ${styles.fine}`} d="M0 0 L7 -3 L29 -3 L29 3 L7 3 Z" />
          <path className={styles.inkFill} d="M0 0 L2.8 -1.2 L2.8 1.2 Z" />
          <path className={styles.fine} d="M7 -3 L7 3 M25 -3 L25 3" />
        </g>
        <Limb pts={[[124, 106], [142, 164], [118.5, 146]]} w={SLEEVE} />
      </>
    ),
    headwear: SHAYLA,
    eyes: [[95, 60], [106, 60]],
    brows: ["M89 52.5 q4.5 -2 9 -0.5", "M102 52 q4.5 -1.5 9 0.5"],
    nose: "M100 61 L98.5 66.5 L100.5 67",
    prop: (
      <g transform="rotate(-4 100 142)">
        <rect className={styles.paper} x="82" y="120" width="36" height="44" rx="3" />
        <path
          className={styles.fine}
          d="M86.5 124 C86.5 115.5 90.5 115.5 90.5 124 M93 124 C93 115.5 97 115.5 97 124 M99.5 124 C99.5 115.5 103.5 115.5 103.5 124 M106 124 C106 115.5 110 115.5 110 124 M112.5 124 C112.5 115.5 116.5 115.5 116.5 124"
        />
        {[131, 142, 153].map((y) => (
          <rect key={y} className={styles.fine} x="87" y={y - 3} width="6" height="6" rx="1" />
        ))}
        <path className={styles.fine} d="M86.5 130.5 L89.5 134 L95.5 126" />
        <path className={styles.fine} d="M97 131 L112 131 M97 142 L112 142 M97 153 L106 153" />
      </g>
    ),
    propStays: true,
  },

  // The owner: neutral, hands in pockets, looking up at the questions.
  you: {
    order: ["body", "arm-l", "arm-r", "prop", "head"],
    body: (
      <>
        <path className={styles.fill} d="M82 94 C92 91 108 91 118 94 C127 97 132 102 133 112 C135 200 136 320 136 430 C112 436 88 436 64 430 C64 320 65 200 67 112 C68 102 73 97 82 94 Z" />
        <path d="M88 95 L100 132 L112 95 M100 132 L100 433" />
        <path d="M95 76 L95 93 M105 76 L105 93" />
        <path d="M90 434 L89 454.5 M110 434 L111 454.5" />
    <path className={styles.inkFill} d="M91 453.5 L88 453.5 C84 455.5 79 457.5 78 461.5 L92 461.5 Z M109 453.5 L112 453.5 C116 455.5 121 457.5 122 461.5 L108 461.5 Z" />
      </>
    ),
    armL: (
      <>
        <Limb pts={[[76, 106], [67, 168], [73, 224]]} w={[14, 11.5, 10]} hand={false} />
        <path d="M69 229 L85 233" />
      </>
    ),
    armR: (
      <>
        <Limb pts={[[124, 106], [133, 168], [127, 224]]} w={[14, 11.5, 10]} hand={false} />
        <path d="M115 233 L131 229" />
      </>
    ),
    crown: <path className={styles.inkFill} d="M84.5 53 C81 38 90 30 101 30 C113 30 121 38 116.5 53 C115 47 112 43 106 41 C98 45 90 46 85.5 49 Z" />,
    beard: BEARD_SHORT,
    eyes: [[94, 55], [106, 55]],
    brows: ["M88 50 L97 47", "M103 47 L112 50"],
    nose: "M100 60 L98.5 66 L100.5 66.5",
  },
};

/** Reflection across the vertical line x = axis. */
const mirror = (axis: number) => `matrix(-1 0 0 1 ${2 * axis} 0)`;

/** D's crops of the same drawing: the face alone, the face with a little shoulder (peeking), and head and shoulders. */
export const CROP = { face: "56 14 88 88", peek: "56 14 88 100", bust: "28 6 144 176" } as const;

/** D's strip, panel one: the arms bent up to the head, in the figures' own line (any figure, drawn for the owner). */
const HANDS = {
  armL: (
    <>
      <path className={styles.fill} d="M68 104 Q55 125 45 149 A6 6 0 0 0 56 154 Q66 131 82 109" />
      <path className={styles.fill} d="M46 150 Q56 110 76 74 A4.5 4.5 0 0 1 84 78 Q66 116 56 154" />
    </>
  ),
  armR: (
    <>
      <path className={styles.fill} d="M132 104 Q145 125 155 149 A6 6 0 0 1 144 154 Q134 131 118 109" />
      <path className={styles.fill} d="M154 150 Q144 110 124 74 A4.5 4.5 0 0 0 116 78 Q134 116 144 154" />
    </>
  ),
  /** On top of everything: the two hands on the head and three worry lines. */
  over: (
    <>
      <ellipse className={styles.paper} cx="85" cy="69" rx="6" ry="10" transform="rotate(18 85 69)" />
      <ellipse className={styles.paper} cx="115" cy="69" rx="6" ry="10" transform="rotate(-18 115 69)" />
      <path className={styles.fine} d="M80 27 L73 18 M100 22 L100 11 M120 27 L127 18" />
    </>
  ),
};

export default function Doodle({ who, pose = "stand", crop }: { who: CastId; pose?: "stand" | "turn" | "hands"; crop?: keyof typeof CROP }) {
  const hands = pose === "hands";
  const f = hands ? { ...FIGURES[who], armL: HANDS.armL, armR: HANDS.armR } : FIGURES[who];
  const turn = pose === "turn";
  const parts: Record<Part, ReactNode> = {
    body: (
      <g key="body" data-part="body">
        {f.body}
      </g>
    ),
    "arm-l": (
      <g key="arm-l" data-part="arm-l">
        {f.armL}
      </g>
    ),
    "arm-r": (
      <g key="arm-r" data-part="arm-r">
        {f.armR}
      </g>
    ),
    // Every figure keeps a `prop` group, empty when it holds nothing (the owner) or only wears it on the head.
    prop:
      f.prop || !f.headProp ? (
        <g key="prop" data-part="prop" transform={turn && f.prop && !f.propStays ? mirror(f.axis ?? 100) : undefined}>
          {f.prop}
        </g>
      ) : null,
    head: (
      <g key="head" data-part="head" transform={turn ? mirror(100) : undefined}>
        {f.headwear}
        <ellipse className={styles.paper} cx="100" cy="58" rx="15.5" ry="20" />
        {f.crown}
        {f.beard}
        <path className={styles.fine} d={f.nose} />
        <g data-part="eyes">
          {f.eyes.map(([x, y], i) => (
            <circle key={i} className={styles.dot} cx={x} cy={y} r="2.2" />
          ))}
        </g>
        <g data-part="brows">
          {f.brows.map((d, i) => (
            <path key={i} d={d} />
          ))}
        </g>
        {f.headProp && <g data-part="prop">{f.headProp}</g>}
      </g>
    ),
  };
  const order: readonly Part[] = f.order.includes("prop") ? f.order : [...f.order, "prop"];
  return (
    <svg viewBox={crop ? CROP[crop] : "0 0 200 480"} className={crop ? `${styles.doodle} ${styles.crop}` : styles.doodle} data-cast={who} data-pose={pose} aria-hidden="true">
      {order.map((p) => parts[p])}
      {hands && HANDS.over}
    </svg>
  );
}
