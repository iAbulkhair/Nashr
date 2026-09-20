import { IMAGE_COST, TASK_COST, TASK_COUNT, listLite, type TaskLite, type TaskType } from "./brand";
import { db } from "./db";
import { agentForTask } from "./agents";

/** Workspace KPIs for the Reports page and for Dana's prompts. Computed from stored tasks only; no model call. */
export type Kpis = {
  month: string;
  created: number;
  createdPrev: number;
  approved: number;
  rejected: number;
  pending: number;
  approvalRate: number | null;
  published: number;
  images: number;
  scheduled: number;
  creditsUsed: number;
  creditsUsedPrev: number;
  byType: Record<string, number>;
  byChannel: Record<string, number>;
  weeks: { label: string; created: number; approved: number }[];
  /** per-day series for the selected window (oldest first) */
  daily: { date: string; created: number; approved: number; published: number }[];
  window: { from: string; to: string; label: string };
};

export type Range = "1" | "2" | "7" | "30" | "60" | "90" | "ytd" | "ly" | "custom";
/** A date that actually parsed. from/to come from the query string, which is request input, not a Date. */
function parsedDate(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** Resolve a range key (Enrich-style pills) into a UTC window. */
export function rangeWindow(range: string | undefined, from?: string, to?: string): { from: Date; to: Date; label: string; prevFrom: Date } {
  const now = new Date();
  const end = new Date(now);
  const day = 864e5;
  if (range === "custom") {
    // "?from=2024-13-01", or a repeated "?from=" which Next hands back as an array, used to yield Invalid Date. The
    // NaN reached listLite, whose since.toISOString() throws RangeError, and the reports page answered 500. An
    // unusable custom range now falls through to the default window.
    const f = parsedDate(from), t = parsedDate(to);
    if (f && t && f.getTime() <= t.getTime()) {
      t.setUTCHours(23, 59, 59, 999);
      return { from: f, to: t, label: "custom", prevFrom: new Date(f.getTime() - (t.getTime() - f.getTime())) };
    }
  }
  if (range === "ytd") { const f = new Date(Date.UTC(now.getUTCFullYear(), 0, 1)); return { from: f, to: end, label: "ytd", prevFrom: new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1)) }; }
  if (range === "ly") { const f = new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1)); const t = new Date(Date.UTC(now.getUTCFullYear(), 0, 1) - 1); return { from: f, to: t, label: "ly", prevFrom: new Date(Date.UTC(now.getUTCFullYear() - 2, 0, 1)) }; }
  const days = ["1", "2", "7", "30", "60", "90"].includes(range ?? "") ? Number(range) : 7;
  const f = new Date(now.getTime() - days * day);
  return { from: f, to: end, label: `${days}d`, prevFrom: new Date(f.getTime() - days * day) };
}

const perItem = (t: TaskType) => (TASK_COST[t] ?? 1) / (TASK_COUNT[t] ?? 1);

/** How far back a KPI read has to go: the comparison window, the 8-week chart and scheduled items, whichever is oldest. */
export function kpiSince(win?: { prevFrom: Date } | null): Date {
  const floor = Date.now() - 90 * 864e5;
  return new Date(Math.min(floor, win ? win.prevFrom.getTime() : floor));
}

/** `rows` lets a page that already read the light index (with `kpiSince`) share it instead of reading twice. */
export async function kpis(scope: string, days?: number, win?: { from: Date; to: Date; label: string; prevFrom: Date }, rows?: TaskLite[]): Promise<Kpis> {
  const now = new Date();
  const w = win ?? (days ? rangeWindow(String(days)) : null);
  const [tasks, pendingIds] = await Promise.all([rows ?? listLite(scope, kpiSince(w)), db.smembers(`pending:${scope}`)]);
  const month = w ? w.label : now.toISOString().slice(0, 7);
  const prevMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  const inMonth = (t: TaskLite, m: string) => t.createdAt.slice(0, 7) === m;
  const ms = (t: TaskLite) => new Date(t.createdAt).getTime();
  const cur = w ? tasks.filter((t) => ms(t) >= w.from.getTime() && ms(t) <= w.to.getTime()) : tasks.filter((t) => inMonth(t, now.toISOString().slice(0, 7)));
  const prev = w ? tasks.filter((t) => ms(t) >= w.prevFrom.getTime() && ms(t) < w.from.getTime()) : tasks.filter((t) => inMonth(t, prevMonth));
  // daily series across the window (capped at 120 points)
  const wf = w ? w.from : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const wt = w ? w.to : now;
  const nDays = Math.min(120, Math.max(1, Math.ceil((wt.getTime() - wf.getTime()) / 864e5)));
  const daily: Kpis["daily"] = [];
  for (let i = 0; i < nDays; i++) {
    const a = new Date(wf.getTime() + i * 864e5); const b = new Date(a.getTime() + 864e5);
    const inDay = tasks.filter((t) => ms(t) >= a.getTime() && ms(t) < b.getTime());
    daily.push({ date: a.toISOString().slice(0, 10), created: inDay.length, approved: inDay.filter((t) => t.status === "approved").length, published: inDay.filter((t) => t.published > 0).length });
  }
  const approved = cur.filter((t) => t.status === "approved").length;
  const rejected = cur.filter((t) => t.status === "rejected").length;
  // The pending set covers every age; the rows only cover the window.
  const pending = Math.max(pendingIds.length, tasks.filter((t) => t.status === "pending").length);
  const byType: Record<string, number> = {};
  const byChannel: Record<string, number> = {};
  for (const t of cur) {
    byType[t.type] = (byType[t.type] ?? 0) + 1;
    byChannel[t.channel] = (byChannel[t.channel] ?? 0) + 1;
  }
  const credits = (list: TaskLite[]) => Math.round(list.reduce((s, t) => s + perItem(t.type) + (t.image ? IMAGE_COST : 0), 0));
  // last 8 weeks, Sunday to Saturday, oldest first
  const weeks: Kpis["weeks"] = [];
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - start.getUTCDay() - 7 * 7);
  for (let i = 0; i < 8; i++) {
    const a = new Date(start.getTime() + i * 7 * 864e5);
    const b = new Date(a.getTime() + 7 * 864e5);
    const inWeek = tasks.filter((t) => { const d = new Date(t.createdAt).getTime(); return d >= a.getTime() && d < b.getTime(); });
    weeks.push({ label: a.toISOString().slice(5, 10), created: inWeek.length, approved: inWeek.filter((t) => t.status === "approved").length });
  }
  return {
    month,
    created: cur.length,
    createdPrev: prev.length,
    approved,
    rejected,
    pending,
    approvalRate: approved + rejected ? Math.round((approved / (approved + rejected)) * 100) : null,
    published: cur.filter((t) => t.published > 0).length,
    images: cur.filter((t) => t.image).length,
    scheduled: tasks.filter((t) => t.scheduledFor && t.scheduledFor >= now.toISOString().slice(0, 10)).length,
    creditsUsed: credits(cur),
    creditsUsedPrev: credits(prev),
    byType,
    byChannel,
    weeks,
    daily,
    window: { from: wf.toISOString().slice(0, 10), to: wt.toISOString().slice(0, 10), label: month },
  };
}

/** Plain-text block for prompts. */
export function statsText(k: Kpis): string {
  const fmt = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([a, b]) => `${a}=${b}`).join(", ") || "none";
  return [
    `WORKSPACE DATA (month ${k.month}; counts are content items in Nashr, not sales figures)`,
    `- Items created this month: ${k.created} (previous month: ${k.createdPrev})`,
    `- Approved: ${k.approved}, rejected: ${k.rejected}, approval rate: ${k.approvalRate === null ? "n/a" : k.approvalRate + "%"}, pending now: ${k.pending}`,
    `- Published through connectors: ${k.published}; images generated: ${k.images}; scheduled ahead: ${k.scheduled}`,
    `- Credits used: ${k.creditsUsed} (previous month: ${k.creditsUsedPrev})`,
    `- By type: ${fmt(k.byType)}`,
    `- By channel: ${fmt(k.byChannel)}`,
    `- Weekly created/approved (oldest first): ${k.weeks.map((w) => `${w.label}: ${w.created}/${w.approved}`).join("; ")}`,
    `- Sales, revenue, traffic and ad-spend figures are NOT in this data. If the owner did not provide them in notes or files, use [رقم] placeholders and list what to track.`,
  ].join("\n");
}

/** Returns the stats block for report-type tasks (Dana), empty for everything else. */
export async function statsFor(type: TaskType, scope: string): Promise<string> {
  if (agentForTask(type).id !== "dana") return "";
  return statsText(await kpis(scope));
}
