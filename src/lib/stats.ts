import { IMAGE_COST, TASK_COST, TASK_COUNT, listTasks, type Task, type TaskType } from "./brand";
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
};

const perItem = (t: TaskType) => (TASK_COST[t] ?? 1) / (TASK_COUNT[t] ?? 1);

export async function kpis(scope: string): Promise<Kpis> {
  const tasks = await listTasks(scope);
  const now = new Date();
  const month = now.toISOString().slice(0, 7);
  const prevMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  const inMonth = (t: Task, m: string) => t.createdAt.slice(0, 7) === m;
  const cur = tasks.filter((t) => inMonth(t, month));
  const prev = tasks.filter((t) => inMonth(t, prevMonth));
  const approved = cur.filter((t) => t.status === "approved").length;
  const rejected = cur.filter((t) => t.status === "rejected").length;
  const pending = tasks.filter((t) => t.status === "pending").length;
  const byType: Record<string, number> = {};
  const byChannel: Record<string, number> = {};
  for (const t of cur) {
    byType[t.type] = (byType[t.type] ?? 0) + 1;
    byChannel[t.channel] = (byChannel[t.channel] ?? 0) + 1;
  }
  const credits = (list: Task[]) => Math.round(list.reduce((s, t) => s + perItem(t.type) + (t.imageUrl ? IMAGE_COST : 0), 0));
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
    published: cur.filter((t) => t.published?.length).length,
    images: cur.filter((t) => t.imageUrl).length,
    scheduled: tasks.filter((t) => t.scheduledFor && t.scheduledFor >= now.toISOString().slice(0, 10)).length,
    creditsUsed: credits(cur),
    creditsUsedPrev: credits(prev),
    byType,
    byChannel,
    weeks,
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
