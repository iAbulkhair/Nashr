import { CAPS, db, pushCapped } from "./db";
import { listLite, type TaskLite, type TaskType } from "./brand";
import { AGENTS, agentForTask, type AgentId } from "./agents";
import { pmap } from "./parallel";
import { globalKey, scopeParam, wsKey } from "./keys";

/**
 * Behavioural evals: what owners actually did with each agent's output
 * (approve, reject, edit, publish, how fast) plus the judge's scores and chat thumbs.
 *
 * Every rate here has its own denominator, and every one is exported next to the rate so the screen can print it.
 * One "Items" column used to stand in for all of them, so "Approval 100%" beside "Items 120" read as 120 reviewed
 * items when it could be 3.
 */

/** A reporting window. Both ends matter: a past range ("last year") must not be re-anchored to today. */
export type Window = { from: Date; to: Date };

export type TypeMetrics = {
  type: TaskType; n: number;
  /** Decided by a person. A human decision is the only thing that writes `decidedAt`. */
  approved: number; rejected: number; pending: number;
  /** Approved by the owner's auto-approve setting and never seen by a person. Counted, but excluded from every rate. */
  autoApproved: number;
  approvalRate: number | null; edited: number; editRate: number | null; editMagnitude: number | null;
  published: number; judged: number; avgScore: number | null; low: number; avgHoursToDecide: number | null;
};
export type AgentMetrics = {
  agent: AgentId; n: number;
  /** Denominator of approvalRate: items a person approved or rejected. */
  decided: number;
  autoApproved: number;
  approvalRate: number | null;
  /** Denominator of editRate: items a person approved. */
  reviewedApproved: number;
  editRate: number | null;
  /** Denominator of avgScore and low: items the judge actually returned a verdict for. */
  judged: number;
  avgScore: number | null; low: number;
  thumbsUp: number; thumbsDown: number; types: TypeMetrics[];
};

export { similarity } from "./similarity";

const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null);
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : null);

/**
 * Whether a person decided this item. `approvalRate` used to be computed from `status` alone, so with auto-approve on
 * for a type every item arrived "approved" and the rate read 100% — computed from the very items auto-approve had
 * created, which nobody opened. The number meant to say whether it is safe to widen auto-approve could only ever
 * confirm it. `decidedAt` is written by the owner's decision (api/tasks/[id]) and by publishing, which is also an
 * owner's decision; it is never written by auto-approve.
 */
const reviewed = (t: TaskLite) => !!t.decidedAt;

export function typeMetrics(tasks: TaskLite[]): TypeMetrics[] {
  const by = new Map<TaskType, TaskLite[]>();
  for (const t of tasks) by.set(t.type, [...(by.get(t.type) ?? []), t]);
  return [...by.entries()].map(([type, ts]) => {
    const approved = ts.filter((t) => reviewed(t) && t.status === "approved"), rejected = ts.filter((t) => reviewed(t) && t.status === "rejected");
    const decided = approved.length + rejected.length;
    // Of what a person approved: an auto-approved item the owner never opened says nothing about how much they edit.
    const edited = approved.filter((t) => t.edited);
    const scores = ts.filter((t) => typeof t.score === "number").map((t) => t.score!);
    const hours = ts.filter((t) => t.decidedAt).map((t) => (new Date(t.decidedAt!).getTime() - new Date(t.createdAt).getTime()) / 36e5);
    return {
      type, n: ts.length, approved: approved.length, rejected: rejected.length, pending: ts.filter((t) => t.status === "pending").length,
      autoApproved: ts.filter((t) => !reviewed(t) && t.status === "approved").length,
      approvalRate: pct(approved.length, decided), edited: edited.length, editRate: pct(edited.length, approved.length),
      editMagnitude: avg(edited.map((t) => t.editPct ?? 0)),
      published: ts.filter((t) => t.published > 0).length, judged: scores.length, avgScore: avg(scores), low: scores.filter((s) => s < 70).length,
      avgHoursToDecide: avg(hours),
    };
  }).sort((a, b) => b.n - a.n);
}

/**
 * Chat thumbs cast inside the window, per agent.
 *
 * These came from `fb:{email}:{agent}:up|down`, lifetime counters that only ever go up, printed inside a table whose
 * every other cell is windowed. On the 7-day view "2/9" read as nine thumbs-down this week when they had accumulated
 * since signup — and because the counter never decreases, an agent that was genuinely fixed could never show it.
 * The feedback log already carries each thumb with its timestamp; it is counted from there. The log is capped
 * (CAPS.feedback), so on a very long window for a very active account the oldest thumbs fall outside it — an
 * undercount at the far edge, never a thumb counted in the wrong period.
 */
async function thumbsIn(scopes: string[], win: Window): Promise<Map<AgentId, { up: number; down: number }>> {
  const logs = await pmap(scopes, (s) => db.lrange(wsKey.feedbackLog(scopeParam(s)), 0, -1));
  const from = win.from.getTime(), to = win.to.getTime();
  const known = new Set<string>(AGENTS.map((a) => a.id));
  const out = new Map<AgentId, { up: number; down: number }>();
  for (const rows of logs) {
    for (const row of rows) {
      let x: { agent?: string; value?: number; at?: string };
      try { x = JSON.parse(row) as typeof x; } catch { continue; }
      const at = Date.parse(x.at ?? "");
      if (!x.agent || !known.has(x.agent) || !(at >= from && at <= to)) continue;
      const id = x.agent as AgentId;
      const c = out.get(id) ?? { up: 0, down: 0 };
      if ((x.value ?? 0) > 0) c.up++; else c.down++;
      out.set(id, c);
    }
  }
  return out;
}

/** Roll type metrics up per agent. `scopes` are the workspaces whose chat thumbs count; `win` bounds the thumbs. */
export async function agentMetrics(tasks: TaskLite[], scopes: string[], win: Window): Promise<AgentMetrics[]> {
  const types = typeMetrics(tasks);
  const fb = await thumbsIn([...new Set(scopes)], win);
  return AGENTS.map((a) => {
    const ts = tasks.filter((t) => agentForTask(t.type).id === a.id);
    const approved = ts.filter((t) => reviewed(t) && t.status === "approved");
    const decided = approved.length + ts.filter((t) => reviewed(t) && t.status === "rejected").length;
    const scores = ts.filter((t) => typeof t.score === "number").map((t) => t.score!);
    const f = fb.get(a.id) ?? { up: 0, down: 0 };
    return {
      agent: a.id, n: ts.length,
      decided, autoApproved: ts.filter((t) => !reviewed(t) && t.status === "approved").length, approvalRate: pct(approved.length, decided),
      reviewedApproved: approved.length, editRate: pct(approved.filter((t) => t.edited).length, approved.length),
      judged: scores.length, avgScore: avg(scores), low: scores.filter((s) => s < 70).length,
      thumbsUp: f.up, thumbsDown: f.down, types: types.filter((t) => agentForTask(t.type).id === a.id),
    };
  });
}

/**
 * One workspace, over exactly the window the page shows. This took a duration and re-anchored it to now, so "Last
 * year" put 2025 in the KPI tiles and the trailing twelve months in the agent table directly beneath them, under a
 * single range pill — two panels that could not be reconciled and no way to tell which one was wrong.
 */
export async function scopeMetrics(scope: string, win: Window) {
  const rows = (await listLite(scope, win.from)).filter((t) => new Date(t.createdAt) <= win.to);
  // The thumbs of THIS workspace. They were read by account email while the tasks were read by brand scope, so on a
  // multi-brand account every brand's report showed every brand's thumbs beside its own approval and judge figures.
  return agentMetrics(rows, [scope], win);
}

/**
 * Every workspace that holds tasks, including suspended accounts and archived brands.
 *
 * globalMetrics used `allUsers()`, which is the SCHEDULER's roster and rightly skips both. Reused here, it meant the
 * table titled "all workspaces" silently dropped them — and their tasks are still in Redis. Each time an account with
 * poor results was suspended, or a brand whose output was wrong was archived, its rejections and low judge scores left
 * the fleet figures, so quality appeared to improve at exactly the moment it was causing churn. Those rows are now
 * counted and flagged instead of hidden.
 */
async function everyWorkspace() {
  const [{ getUser }, { listBrands, scopeFor }] = await Promise.all([import("./auth"), import("./brands")]);
  const emails = await db.smembers(globalKey.usersAll());
  const groups = await pmap(emails, async (e) => {
    const [u, brands] = await Promise.all([getUser(e), listBrands(e)]);
    if (!u) return [];
    return brands.map((b) => {
      const scope = scopeFor(e, b.id);
      // Per brand, and labelled that way. The rows were one per brand scope but printed as the bare email, so an
      // agency with five brands appeared five times under one name with five different sets of numbers.
      const label = scope === e ? e : `${e} · ${b.name || b.id}`;
      return { email: e, scope, label, suspended: !!u.suspended, archived: b.status !== "active" };
    });
  });
  return groups.flat();
}

/** Admin: every workspace in the system, over the trailing `sinceDays`. */
export async function globalMetrics(sinceDays = 30) {
  const win: Window = { from: new Date(Date.now() - sinceDays * 864e5), to: new Date() };
  const all: TaskLite[] = [];
  const users: { email: string; scope: string; label: string; suspended: boolean; archived: boolean; n: number; decided: number; approvalRate: number | null; judged: number; avgScore: number | null }[] = [];
  const list = await everyWorkspace();
  const taskSets = await pmap(list, (w) => listLite(w.scope, win.from), 6);
  for (const [i, w] of list.entries()) {
    const tasks = taskSets[i];
    all.push(...tasks);
    const approved = tasks.filter((t) => reviewed(t) && t.status === "approved").length;
    const decided = approved + tasks.filter((t) => reviewed(t) && t.status === "rejected").length;
    const scores = tasks.filter((t) => typeof t.score === "number").map((t) => t.score!);
    users.push({ email: w.email, scope: w.scope, label: w.label, suspended: w.suspended, archived: w.archived, n: tasks.length, decided, approvalRate: pct(approved, decided), judged: scores.length, avgScore: avg(scores) });
  }
  return { sinceDays, agents: await agentMetrics(all, list.map((w) => w.scope), win), users: users.filter((x) => x.n > 0).sort((a, b) => b.n - a.n) };
}

/**
 * A thumb on an agent's chat reply, recorded against the workspace the chat ran in. Chat history is stored per brand,
 * so its feedback is too. For the default brand the scope IS the email, so thumbs already recorded there are unchanged;
 * thumbs recorded on another brand before this change remain under the account and now count toward the default.
 *
 * The `fb:{email}:{agent}:up|down` counters are no longer written: nothing has read them since thumbs moved to the
 * timestamped log, and a counter that only grows was the reason the old column could never show an agent improving.
 */
export async function recordThumb(scope: string, agent: AgentId, value: 1 | -1, reason?: string, at?: string) {
  await pushCapped(wsKey.feedbackLog(scopeParam(scope)), JSON.stringify({ agent, value, reason: (reason ?? "").slice(0, 300), msgAt: at ?? null, at: new Date().toISOString() }), CAPS.feedback);
}
