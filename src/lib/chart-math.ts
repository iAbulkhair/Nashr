/**
 * Pure helpers for the in-house charts and the progress bar (rules 3130-3139). No DOM, no React: the components in
 * `src/components/ui/Chart.tsx` and `Progress.tsx` only draw what these return, so the scaling and the right-to-left
 * mirroring are tested without a browser.
 */

/** A number kept inside [lo, hi]; a non-finite input is `lo`. */
export function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/** Percent filled (0-100) of `value` over `max`. A zero, negative or non-finite `max` is 0%; a value above `max` is 100%. */
export function percent(value: number, max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 0;
  return clamp((value / max) * 100, 0, 100);
}

const round = (n: number) => Math.round(n * 10) / 10;
const finite = (v: number) => (Number.isFinite(v) ? v : 0);

/**
 * Horizontal position of point `i` of `n` in a plot `width` wide with `pad` on both sides. Time runs left to right in LTR
 * and right to left in RTL, so with `rtl` the first (oldest) point is at the right edge. One point sits in the middle.
 */
export function xAt(i: number, n: number, width: number, pad: number, rtl: boolean): number {
  const inner = Math.max(0, width - 2 * pad);
  const t = n > 1 ? i / (n - 1) : 0.5;
  return pad + (rtl ? 1 - t : t) * inner;
}

/** Vertical position of `v` on a 0..`max` scale, `pad` from top and bottom; larger values are higher (smaller y). */
export function yAt(v: number, max: number, height: number, pad: number): number {
  const inner = Math.max(0, height - 2 * pad);
  const top = max > 0 ? clamp(v / max, 0, 1) : 0;
  return height - pad - top * inner;
}

export type Pt = { x: number; y: number };

/** Points of a series scaled into a `width` x `height` box. `max` defaults to the series' largest value (at least 1). */
export function scalePoints(values: number[], width: number, height: number, opts: { pad?: number; rtl?: boolean; max?: number } = {}): Pt[] {
  const pad = opts.pad ?? 0;
  const max = opts.max ?? Math.max(1, ...values.map(finite));
  return values.map((v, i) => ({ x: round(xAt(i, values.length, width, pad, opts.rtl ?? false)), y: round(yAt(finite(v), max, height, pad)) }));
}

/** An SVG path through the points: `M x,y L x,y ...`. Empty for no points. */
export function linePath(pts: Pt[]): string {
  return pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
}

/** The same line closed down to the baseline `y`, for an area fill. Empty for no points. */
export function areaPath(pts: Pt[], baseY: number): string {
  if (pts.length === 0) return "";
  return `${linePath(pts)} L${pts[pts.length - 1].x},${round(baseY)} L${pts[0].x},${round(baseY)} Z`;
}

/** Bars of a series: left edge, width, top and height, with the first (oldest) bar at the right in RTL. */
export function barRects(values: number[], width: number, height: number, opts: { pad?: number; gap?: number; rtl?: boolean; max?: number } = {}): { x: number; y: number; w: number; h: number }[] {
  const pad = opts.pad ?? 0;
  const gap = opts.gap ?? 4;
  const n = values.length;
  if (n === 0) return [];
  const max = opts.max ?? Math.max(1, ...values.map(finite));
  const slot = Math.max(0, width - 2 * pad) / n;
  const w = Math.max(1, slot - gap);
  return values.map((v, i) => {
    const slotIndex = opts.rtl ? n - 1 - i : i;
    const y = yAt(finite(v), max, height, pad);
    return { x: round(pad + slotIndex * slot + (slot - w) / 2), y: round(y), w: round(w), h: round(height - pad - y) };
  });
}
