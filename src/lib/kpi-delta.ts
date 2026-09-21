/**
 * A KPI's change against the previous window of the same length — which is what kpis() compares against. Import-free,
 * because a client component renders it and anything imported here would ship to the browser.
 *
 * The base is always printed. "↑ 300%" off a base of 1 is noise, and the reader must be able to see that. A change off
 * a base of 0 has no percentage at all, so it is given as the absolute number instead of a bare "↑" that reads as
 * growth. This used to say "vs last month" whatever range was selected; on the default 7-day view that described a
 * comparison four times longer than the one being made.
 */
export function kpiDelta(cur: number, prev: number, label: string): string {
  if (!prev && !cur) return "";
  if (!prev) return `+${cur} · ${label}: 0`;
  const d = Math.round(((cur - prev) / prev) * 100);
  return `${d > 0 ? "↑" : d < 0 ? "↓" : "→"} ${Math.abs(d)}% · ${label}: ${prev}`;
}
