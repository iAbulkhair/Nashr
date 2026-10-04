"use client";

import { useEffect, useRef, useState } from "react";
import { scribble, scribbleRing, type ScribbleKind, type ScribbleOpts } from "@/lib/scribble";

/**
 * A hand-drawn outline behind its parent (rule 512). Draws on the server at a default size, so the page never shows an
 * empty box, then redraws at the parent's real size when it changes. The parent needs `position: relative` and
 * `isolation: isolate` (the `.s-*` classes in scribble.css give both). Decoration only: hidden from assistive tech,
 * and hidden in forced-colours mode, where the `.s-*` classes draw a real border instead.
 */
type Props = {
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
  /** Reading direction; read from the parent when left out. */
  rtl?: boolean;
  w?: number;
  h?: number;
};

const SIZE: Partial<Record<ScribbleKind, [number, number]>> = { box: [240, 64], pill: [160, 48], underline: [120, 10], cloud: [280, 120], bubble: [240, 80] };
const DEFAULT_FILL: Partial<Record<ScribbleKind, string>> = { bubble: "paper", cloud: "paper", tape: "color-mix(in oklab, var(--color-lemon) 85%, transparent)", puddle: "agent-noor", swash: "agent-noor" };
const TOKEN = /^(paper|ink|ground|lemon|lilac|gold|muted|agent-[a-z]+)$/;

const colour = (fill: string) => (TOKEN.test(fill) ? `var(--color-${fill})` : fill);

export default function Scribble({ kind, seed, fill, shadow, boil, ring, tail, tailAt, heavy, rtl, w, h }: Props) {
  const ref = useRef<SVGSVGElement>(null);
  const [defW, defH] = SIZE[kind] ?? [64, 64];
  const [size, setSize] = useState({ w: w ?? defW, h: h ?? defH, rtl: rtl ?? false });

  useEffect(() => {
    const host = ref.current?.parentElement;
    if (!host) return;
    const measure = () => {
      const next = { w: w ?? host.clientWidth, h: h ?? host.clientHeight, rtl: rtl ?? getComputedStyle(host).direction === "rtl" };
      if (next.w && next.h) setSize((s) => (s.w === next.w && s.h === next.h && s.rtl === next.rtl ? s : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, [w, h, rtl]);

  const opts: ScribbleOpts = { tail, tailAt, heavy, rtl: size.rtl };
  const art = scribble(kind, size.w, size.h, seed, opts);
  const alt = scribble(kind, size.w, size.h, seed + "~", opts);
  const paint = fill ?? DEFAULT_FILL[kind] ?? "none";
  const ghost = alt.d || alt.ghost;
  const rings = ring ? scribbleRing(seed, kind, size.w, size.h) : null;

  return (
    <svg
      ref={ref}
      className="scribble s-art"
      viewBox={`-4 -4 ${size.w + 8} ${size.h + 8}`}
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
      {boil && art.d && <path className="boil" d={scribble(kind, size.w, size.h, seed + "*", opts).d} />}
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
