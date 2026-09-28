import type { ReactNode } from "react";
import type { CastId } from "@/lib/home";
import styles from "./home.module.css";

/**
 * Placeholder figures for the Thakeen cast, drawn in code until the illustrator's art arrives (spec §7.1).
 *
 * THE PART CONTRACT (the illustrator's delivery spec): each figure is one `<svg viewBox="0 0 200 480">` whose groups
 * carry `data-part` = `body`, `head` (with `eyes` and `brows` inside it, so they turn with the head), `arm-l` (the arm on
 * the viewer's left), `arm-r` and `prop`. A prop worn on the head (glasses, headphones) sits inside `head`; a figure
 * with nothing to hold keeps an empty `prop`. Final SVGs replace these bodies without code changes.
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
const DRESS = (
  <>
    <path className={styles.fill} d="M82 94 C92 91 108 91 118 94 C127 97 131 102 132 112 C134 150 131 190 128 226 C136 296 146 366 152 428 C120 436 80 436 48 428 C54 366 64 296 72 226 C69 190 66 150 68 112 C69 102 73 97 82 94 Z" />
    <path d="M100 108 C101 200 100 330 100 432" />
    <path d="M91 435 L90 454.5 M109 435 L110 454.5" />
    <path className={styles.inkFill} d="M92 453.5 L89 453.5 C85 455.5 80 457.5 79 461.5 L93 461.5 Z M108 453.5 L111 453.5 C115 455.5 120 457.5 121 461.5 L107 461.5 Z" />
  </>
);

/** Thobe: a straight column to the ankle. */
const THOBE = (
  <>
    <path className={styles.fill} d="M82 94 C92 91 108 91 118 94 C127 97 132 102 133 112 C136 200 136 330 134 442 C112 448 88 448 66 442 C64 330 64 200 67 112 C68 102 73 97 82 94 Z" />
    <path d="M100 100 L100 156" />
    <path d="M90 447 L89 457 M110 447 L111 457" />
    <path className={styles.inkFill} d="M91 456 L88 456 C84 458 79 460 78 464 L92 464 Z M109 456 L112 456 C116 458 121 460 122 464 L108 464 Z" />
  </>
);

/** Shayla: close around the face, one end wrapped across the chest to the far shoulder. */
const SHAYLA = (
  <>
    <path className={styles.paper} d="M100 32 C85 32 77 44 77 60 C77 74 79 86 75 99 C86 106 98 112 113 115 C121 116 127 115 132 111 C129 104 125 99 123 93 C124 83 124 72 123 60 C123 44 115 32 100 32 Z" />
    <path className={styles.fine} d="M84 86 C94 97 110 103 125 103" />
  </>
);

const GHUTRA = <path className={styles.paper} d="M100 24 C79 24 71 40 71 60 C71 88 68 106 60 132 C70 134 78 130 82 124 C86 110 90 96 100 92 C110 96 114 110 118 124 C122 130 130 134 140 132 C132 106 129 88 129 60 C129 40 121 24 100 24 Z" />;

/** Agal: the black cord across the crown of the ghutra. */
const AGAL = <path className={styles.inkFill} d="M77 41 C83 30 117 30 123 41 L122.5 47 C115 38 85 38 77.5 47 Z" />;

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

  // Sami: sales. Phone to the ear, the other hand open mid-sentence.
  sami: {
    order: ["body", "arm-l", "head", "prop", "arm-r"],
    body: THOBE,
    armL: <Limb pts={[[76, 106], [64, 166], [52, 214]]} w={SLEEVE} />,
    armR: <Limb pts={[[124, 106], [150, 138], [131, 90]]} w={SLEEVE} />,
    headwear: GHUTRA,
    crown: AGAL,
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

  // Faris: growth. Mid-stride, scarf flying behind.
  faris: {
    order: ["body", "arm-l", "arm-r", "prop", "head"],
    body: (
      <>
        <Limb pts={[[92, 296], [82, 372], [70, 446]]} w={[17, 13, 10.5]} hand={false} tone="paper" />
        <Limb pts={[[108, 296], [121, 372], [135, 446]]} w={[17, 13, 10.5]} hand={false} tone="paper" />
        <path className={styles.inkFill} d="M60 452 C61 445 71 443 76 447 L76 455 C69 457 62 456 60 452 Z" />
        <path className={styles.inkFill} d="M128 448 C134 444 146 446 153 452 C153 456 146 458 128 456 Z" />
        <path className={styles.fill} d="M82 94 C92 91 108 91 118 94 C127 97 132 102 133 112 C136 170 140 236 146 300 C122 310 84 310 60 302 C62 236 64 170 67 112 C68 102 73 97 82 94 Z" />
        <path d="M100 100 L103 306" />
        <path d="M95 76 L95 92 M105 76 L105 92" />
      </>
    ),
    armL: <Limb pts={[[76, 106], [70, 168], [82, 222]]} w={SLEEVE} />,
    armR: <Limb pts={[[124, 106], [138, 164], [150, 214]]} w={SLEEVE} />,
    crown: <path className={styles.inkFill} d="M84.5 56 C82 38 91 31 102 31 C113 31 120 39 116.5 55 C113 46 106 42 99 44 C93 45 88 50 84.5 56 Z" />,
    eyes: [[97, 58], [108, 58]],
    brows: ["M90 50 L99 51.5", "M103 51.5 L112 49.5"],
    nose: "M101.5 60 L103.5 66 L101 66.5",
    prop: (
      <>
        <path className={styles.paper} d="M86 100 C72 104 58 98 40 108 C45 116 54 119 64 116 C73 113 81 110 90 106 Z" />
        <path className={styles.fine} d="M52 108 L57 116 M63 105 L67 113" />
        <path className={styles.paper} d="M104 104 C106 122 109 140 112 158 L100 161 C99 142 98 122 97 106 Z" />
        <path className={styles.paper} d="M83 86 C90 99 110 99 117 86 C120 92 120 100 116 103 C108 110 92 110 84 103 C80 100 80 92 83 86 Z" />
      </>
    ),
    axis: 100,
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
    headwear: GHUTRA,
    crown: AGAL,
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
    crown: <path className={styles.inkFill} d="M84 60 C80 40 90 30 101 30 C113 30 121 40 116.5 60 C115 50 112 44 106 41 C98 46 90 47 85.5 50 Z" />,
    eyes: [[94, 55], [106, 55]],
    brows: ["M88 50 L97 47", "M103 47 L112 50"],
    nose: "M100 60 L98.5 66 L100.5 66.5",
  },
};

/** Reflection across the vertical line x = axis. */
const mirror = (axis: number) => `matrix(-1 0 0 1 ${2 * axis} 0)`;

export default function Doodle({ who, pose = "stand" }: { who: CastId; pose?: "stand" | "turn" }) {
  const f = FIGURES[who];
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
        <g key="prop" data-part="prop" transform={turn && f.prop ? mirror(f.axis ?? 100) : undefined}>
          {f.prop}
        </g>
      ) : null,
    head: (
      <g key="head" data-part="head" transform={turn ? mirror(100) : undefined}>
        {f.headwear}
        <ellipse className={styles.paper} cx="100" cy="58" rx="15.5" ry="20" />
        {f.crown}
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
    <svg viewBox="0 0 200 480" className={styles.doodle} data-cast={who} data-pose={pose} aria-hidden="true">
      {order.map((p) => parts[p])}
    </svg>
  );
}
