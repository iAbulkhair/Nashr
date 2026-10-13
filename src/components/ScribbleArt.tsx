import { scribble, scribbleRing, type ScribbleArt, type ScribbleKind, type ScribbleOpts } from "@/lib/scribble";

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
const DEFAULT_FILL: Partial<Record<ScribbleKind, string>> = { bubble: "surface", cloud: "surface", tape: "color-mix(in oklab, var(--color-lemon) 85%, transparent)", puddle: "agent-noor", swash: "agent-noor" };
// Semantic fills (surface, background, foreground) follow the theme (rule 1202). The five palette names that have a role
// with the same light value paint that role, so they follow the theme too and the light page is unchanged (rule 1212):
// paper is the surface, ground the background, lilac the muted background, muted the muted text, and ink the primary
// fill that a solid `s-btn` and the cover's title box sit on. Lemon, gold and the agents' colours stay as they are.
const ROLE: Record<string, string> = { paper: "surface", ground: "background", lilac: "background-muted", muted: "foreground-muted", ink: "primary" };
const TOKEN = /^(paper|ink|ground|lemon|lilac|gold|muted|surface|background|background-muted|foreground|agent-[a-z]+)$/;
export const scribbleColour = (fill: string) => (TOKEN.test(fill) ? `var(--color-${ROLE[fill] ?? fill})` : fill);
const colour = scribbleColour;
/**
 * A fill that stays bright in both themes (lemon, gold and the light agent colours, the set globals.css gives ink text)
 * and lies wholly behind its text marks the svg `data-bright`, so scribble.css paints that text ink in both themes
 * (rule 1216). A swash, puddle or tape lies only partly behind its text, so it is never marked.
 */
const BRIGHT = /^(lemon|gold|agent-(noor|sami|razan|dana|layan|reem|you))$/;
const BEHIND: ReadonlySet<ScribbleKind> = new Set(["box", "pill", "stamp", "bubble", "cloud"]);
export const brightBehind = (kind: ScribbleKind, paint: string) => BRIGHT.test(paint) && BEHIND.has(kind);

/**
 * Path data in its shortest exact spelling (rule 1803): no space before a minus sign and no zero before a decimal point,
 * which SVG reads as the same numbers. The home page draws about 1,750 scribble paths, so the page gets lighter and
 * not one point moves. `scribble.ts` keeps its readable output; only what goes into the page is shortened.
 */
export const tightPath = (d: string): string => d.replace(/ -/g, "-").replace(/(^|[^\d.])0\./g, "$1.");
const tightArt = (a: ScribbleArt): ScribbleArt => ({
  ...a,
  d: tightPath(a.d),
  fill: a.fill && tightPath(a.fill),
  cap: a.cap && tightPath(a.cap),
  capFill: a.capFill && tightPath(a.capFill),
  ink: a.ink && tightPath(a.ink),
  ghost: a.ghost && tightPath(a.ghost),
});

/** The `<svg>` for one look at one size and direction. `svgRef` is the client scribble's handle on it. */
export function ScribbleSvg({ look, w, h, rtl, svgRef }: { look: ScribbleLook; w: number; h: number; rtl: boolean; svgRef?: React.Ref<SVGSVGElement> }) {
  const { kind, seed, fill, shadow, boil, ring, tail, tailAt, heavy } = look;
  const opts: ScribbleOpts = { tail, tailAt, heavy, rtl };
  const art = tightArt(scribble(kind, w, h, seed, opts));
  const alt = tightArt(scribble(kind, w, h, seed + "~", opts));
  const paint = fill ?? DEFAULT_FILL[kind] ?? "none";
  const ghost = alt.d || alt.ghost;
  const rings = ring ? scribbleRing(seed, kind, w, h).map(tightPath) : null;
  return (
    <svg
      ref={svgRef}
      className="scribble s-art"
      viewBox={`-4 -4 ${w + 8} ${h + 8}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      style={paint === "none" ? undefined : ({ "--s-fill": colour(paint) } as React.CSSProperties)}
      data-bright={brightBehind(kind, paint) ? "" : undefined}
    >
      {shadow && alt.fill && <path className="shadow" d={alt.fill} />}
      {paint !== "none" && art.fill && <path className={art.still ? "fill at" : "fill"} d={art.fill} />}
      {art.ink && <path className="ink" d={art.ink} />}
      {ghost && <path className="ghost" d={ghost} pathLength={1} />}
      {art.d && <path className="main" d={art.d} pathLength={1} />}
      {art.capFill && <path className="cap" d={art.capFill} />}
      {art.cap && <path className="main" d={art.cap} pathLength={1} />}
      {boil && art.d && <path className="boil" d={tightPath(scribble(kind, w, h, seed + "*", opts).d)} />}
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
