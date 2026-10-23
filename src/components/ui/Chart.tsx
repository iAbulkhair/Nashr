import { areaPath, barRects, linePath, scalePoints, yAt } from "@/lib/chart-math";

/**
 * In-house SVG charts (rule 3131): bars, a line with an optional area, and a sparkline. No chart library.
 *
 * - Colour comes from the chart tokens (`--chart-1` ... `--chart-5`, rule 967), which already hold in light and dark.
 * - Time runs in the reading direction: pass `dir="rtl"` for Arabic and the oldest point is at the right edge, the newest at
 *   the left (rule 3132). The axis labels are HTML, so they follow `dir` on their own.
 * - The drawing is `aria-hidden`; the numbers are in a visually hidden table (bars, line) or a one-line `summary`
 *   (sparkline) that the caller words in its own language (rule 3133). A chart with no points draws nothing.
 *
 * Server-safe: no hooks and no directive. The caller supplies every label; nothing here invents a number.
 */
export type ChartPoint = { label: string; value: number };

type Dir = "ltr" | "rtl";

type BaseProps = {
  data: ChartPoint[];
  dir?: Dir;
  /** Names the chart for assistive tech (the hidden table's caption). */
  caption: string;
  /** Column header for the values in the hidden table. */
  valueHeader: string;
  /** Column header for the labels in the hidden table. */
  labelHeader: string;
  /** Formats a value for the hidden table; defaults to the plain number. */
  format?: (v: number) => string;
  /** A chart token, e.g. "var(--chart-2)". */
  color?: string;
  className?: string;
};

const W = 320;
const H = 120;
const PAD = 6;

function SrTable({ data, caption, labelHeader, valueHeader, format }: Pick<BaseProps, "data" | "caption" | "labelHeader" | "valueHeader" | "format">) {
  const f = format ?? ((v: number) => String(v));
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead><tr><th scope="col">{labelHeader}</th><th scope="col">{valueHeader}</th></tr></thead>
      <tbody>{data.map((d, i) => <tr key={i}><th scope="row">{d.label}</th><td>{f(d.value)}</td></tr>)}</tbody>
    </table>
  );
}

/** The first and last label under the plot, at its two ends; start-aligned to the oldest point in either direction. */
function Ends({ data, dir }: { data: ChartPoint[]; dir: Dir }) {
  if (data.length < 2) return null;
  return (
    <div aria-hidden dir={dir} className="mt-1 flex justify-between text-xs text-foreground-muted">
      <span>{data[0].label}</span>
      <span>{data[data.length - 1].label}</span>
    </div>
  );
}

export function BarChart({ data, dir = "ltr", caption, valueHeader, labelHeader, format, color = "var(--chart-1)", className = "" }: BaseProps) {
  if (data.length === 0) return null;
  const values = data.map((d) => d.value);
  const rects = barRects(values, W, H, { pad: PAD, gap: data.length > 20 ? 2 : 6, rtl: dir === "rtl" });
  return (
    <figure className={className}>
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" aria-hidden="true" focusable="false">
        <line x1={PAD} x2={W - PAD} y1={H - PAD} y2={H - PAD} stroke="var(--color-border)" strokeWidth="1" />
        {rects.map((r, i) => <rect key={i} x={r.x} y={r.y} width={r.w} height={Math.max(r.h, values[i] > 0 ? 1 : 0)} rx="2" fill={color} />)}
      </svg>
      <Ends data={data} dir={dir} />
      <SrTable data={data} caption={caption} labelHeader={labelHeader} valueHeader={valueHeader} format={format} />
    </figure>
  );
}

export function LineChart({ data, dir = "ltr", caption, valueHeader, labelHeader, format, color = "var(--chart-1)", area = true, className = "" }: BaseProps & { area?: boolean }) {
  if (data.length === 0) return null;
  const pts = scalePoints(data.map((d) => d.value), W, H, { pad: PAD, rtl: dir === "rtl" });
  const base = yAt(0, 1, H, PAD);
  return (
    <figure className={className}>
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" aria-hidden="true" focusable="false">
        <line x1={PAD} x2={W - PAD} y1={base} y2={base} stroke="var(--color-border)" strokeWidth="1" />
        {area && pts.length > 1 && <path d={areaPath(pts, base)} fill={color} fillOpacity="0.12" />}
        <path d={linePath(pts)} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {pts.length === 1 && <circle cx={pts[0].x} cy={pts[0].y} r="3" fill={color} />}
      </svg>
      <Ends data={data} dir={dir} />
      <SrTable data={data} caption={caption} labelHeader={labelHeader} valueHeader={valueHeader} format={format} />
    </figure>
  );
}

/**
 * A tiny trend line for a stat tile. `summary` is the sentence a screen reader hears in place of the drawing (e.g. "Last 7
 * days: 2, 4, 3, 5"), worded by the caller in the page's language. Fewer than two points draws nothing: one day is no trend.
 */
export function Sparkline({ values, dir = "ltr", summary, color = "var(--chart-1)", width = 72, height = 24, className = "" }: { values: number[]; dir?: Dir; summary: string; color?: string; width?: number; height?: number; className?: string }) {
  if (values.length < 2) return null;
  const pad = 2;
  const pts = scalePoints(values, width, height, { pad, rtl: dir === "rtl" });
  // The newest value is the last in data order; `scalePoints` already puts it at the left edge in RTL.
  const last = pts[pts.length - 1];
  return (
    <span className={`inline-block ${className}`.trim()}>
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="block" aria-hidden="true" focusable="false">
        <path d={linePath(pts)} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={last.x} cy={last.y} r="2" fill={color} />
      </svg>
      <span className="sr-only">{summary}</span>
    </span>
  );
}
