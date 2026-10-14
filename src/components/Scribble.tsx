"use client";

import { useContext, useEffect, useRef, useState } from "react";
import { SCRIBBLE_SIZE, ScribbleSvg, type ScribbleLook } from "./ScribbleArt";
import { ScribbleDirContext } from "./ScribbleDir";

/**
 * A hand-drawn outline behind its parent (rule 512). Draws on the server at a default size, so the page never shows an
 * empty box, then redraws at the parent's real size when it changes. The parent needs `position: relative` and
 * `isolation: isolate` (the `.s-*` classes in scribble.css give both). Decoration only: hidden from assistive tech,
 * and hidden in forced-colours mode, where the `.s-*` classes draw a real border instead.
 *
 * A scribble that never needs its parent's size (a title's underline) can be `ScribbleStatic` instead (rule 1114): drawn
 * on the server only, no JavaScript, and in the right direction from the first paint.
 */
type Props = ScribbleLook & {
  /** Reading direction; when left out, the page's at first (`ScribbleDir`, rule 1869), then the parent's once measured. */
  rtl?: boolean;
  w?: number;
  h?: number;
};

export default function Scribble({ rtl, w, h, ...look }: Props) {
  // The first drawing takes the page's direction; the measured one the parent's, so an LTR island keeps its own.
  const page = useContext(ScribbleDirContext);
  const ref = useRef<SVGSVGElement>(null);
  const [defW, defH] = SCRIBBLE_SIZE[look.kind] ?? [64, 64];
  const [size, setSize] = useState({ w: w ?? defW, h: h ?? defH, rtl: rtl ?? page ?? false });

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

  return <ScribbleSvg svgRef={ref} look={look} w={size.w} h={size.h} rtl={size.rtl} />;
}
