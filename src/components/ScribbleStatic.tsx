import { SCRIBBLE_SIZE, ScribbleSvg, type ScribbleLook } from "./ScribbleArt";

/**
 * A scribble drawn once, on the server (rule 1114): no `"use client"`, no measuring, no redraw after hydration. The
 * direction is given, not read from the page, so an Arabic title's underline starts on the right from the first paint
 * instead of flipping when the client scribble measures its parent. The art is stretched to its parent by
 * `preserveAspectRatio="none"`, and scribble.css draws every stroke with `vector-effect: non-scaling-stroke`, so the line
 * keeps its weight at any width. Use it for decoration whose shape does not depend on the parent's size: underlines,
 * ticks, dividers.
 */
export default function ScribbleStatic({ rtl, w, h, ...look }: ScribbleLook & { rtl: boolean; w?: number; h?: number }) {
  const [defW, defH] = SCRIBBLE_SIZE[look.kind] ?? [64, 64];
  return <ScribbleSvg look={look} w={w ?? defW} h={h ?? defH} rtl={rtl} />;
}
