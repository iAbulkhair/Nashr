import { scribble, scribbleRing, type ScribbleKind, type ScribbleOpts } from "@/lib/scribble";

/**
 * The drawing both scribbles share: the client `Scribble`, which measures its parent and redraws, and the server
 * `ScribbleStatic` (rule 1114), which draws once at a fixed size. No hooks and no directive, so a server component can
 * render it and a client component can import it.
 */
export type ScribbleLook = {
  kind: ScribbleKind;
  seed: string;
  /** A token (paper, ink, ground, lemon, lilac, gold, muted, agent-<id>), any CSS colour, or "none". */
  fill?: string;
  shadow?: boolean;
  boil?: boolean;
  /** The focus ring D draws round a scribbled control; shown by scribble.css on :focus-visible. */
  ring?: boolean;
  tail?: ScribbleOpts["tail"];
  tailAt?: number;
  heavy?: boolean;
};

export const SCRIBBLE_SIZE: Partial<Record<ScribbleKind, [number, number]>> = { box: [240, 64], pill: [160, 48], underline: [120, 10], cloud: [280, 120], bubble: [240, 80] };
const DEFAULT_FILL: Partial<Record<ScribbleKind, string>> = { bubble: "paper", cloud: "paper", tape: "color-mix(in oklab, var(--color-lemon) 85%, transparent)", puddle: "agent-noor", swash: "agent-noor" };
const TOKEN = /^(paper|ink|ground|lemon|lilac|gold|muted|agent-[a-z]+)$/;
const colour = (fill: string) => (TOKEN.test(fill) ? `var(--color-${fill})` : fill);

/** The `<svg>` for one look at one size and direction. `svgRef` is the client scribble's handle on it. */
export function ScribbleSvg({ look, w, h, rtl, svgRef }: { look: ScribbleLook; w: number; h: number; rtl: boolean; svgRef?: React.Ref<SVGSVGElement> }) {
  const { kind, seed, fill, shadow, boil, ring, tail, tailAt, heavy } = look;
  const opts: ScribbleOpts = { tail, tailAt, heavy, rtl };
  const art = scribble(kind, w, h, seed, opts);
  const alt = scribble(kind, w, h, seed + "~", opts);
  const paint = fill ?? DEFAULT_FILL[kind] ?? "none";
  const ghost = alt.d || alt.ghost;
  const rings = ring ? scribbleRing(seed, kind, w, h) : null;
  return (
    <svg
      ref={svgRef}
      className="scribble s-art"
      viewBox={`-4 -4 ${w + 8} ${h + 8}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
      style={paint === "none" ? undefined : ({ "--s-fill": colour(paint) } as React.CSSProperties)}
    >
      {shadow && alt.fill && <path className="shadow" d={alt.fill} />}
      {paint !== "none" && art.fill && <path className={art.still ? "fill at" : "fill"} d={art.fill} />}
      {art.ink && <path className="ink" d={art.ink} />}
      {ghost && <path className="ghost" d={ghost} pathLength={1} />}
      {art.d && <path className="main" d={art.d} pathLength={1} />}
      {art.capFill && <path className="cap" d={art.capFill} />}
      {art.cap && <path className="main" d={art.cap} pathLength={1} />}
      {boil && art.d && <path className="boil" d={scribble(kind, w, h, seed + "*", opts).d} />}
      {rings && (
        <>
          <path className="ring ring-paper" d={rings[0]} pathLength={1} />
          <path className="ring" d={rings[0]} pathLength={1} />
          <path className="ring ring-2" d={rings[1]} pathLength={1} />
        </>
      )}
    </svg>
  );
}
