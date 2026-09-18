import { CAPS, db, pushCapped } from "./db";
import { listLite, type TaskLite, type TaskType } from "./brand";
import { AGENTS, agentForTask, type AgentId } from "./agents";

/**
 * Behavioural evals: what owners actually did with each agent's output
 * (approve, reject, edit, publish, how fast) plus the judge's scores and chat thumbs.
 */
export type TypeMetrics = {
  type: TaskType; n: number; approved: number; rejected: number; pending: number;
  approvalRate: number | null; edited: number; editRate: number | null; editMagnitude: number | null;
  published: number; judged: number; avgScore: number | null; low: number; avgHoursToDecide: number | null;
};
export type AgentMetrics = {
  agent: AgentId; n: number; approvalRate: number | null; editRate: number | null; avgScore: number | null; low: number;
  thumbsUp: number; thumbsDown: number; types: TypeMetrics[];
};

export { similarity } from "./similarity";

const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null);
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : null);

export function typeMetrics(tasks: TaskLite[]): TypeMetrics[] {
  const by = new Map<TaskType, TaskLite[]>();
  for (const t of tasks) by.set(t.type, [...(by.get(t.type) ?? []), t]);
  return [...by.entries()].map(([type, ts]) => {
    const approved = ts.filter((t) => t.status === "approved"), rejected = ts.filter((t) => t.status === "rejected");
    const decided = approved.length + rejected.length;
    const edited = approved.filter((t) => t.edited);
    const scores = ts.filter((t) => typeof t.score === "number").map((t) => t.score!);
    const hours = ts.filter((t) => t.decidedAt).map((t) => (new Date(t.decidedAt!).getTime() - new Date(t.createdAt).getTime()) / 36e5);
    return {
      type, n: ts.length, approved: approved.length, rejected: rejected.length, pending: ts.filter((t) => t.status === "pending").length,
      approvalRate: pct(approved.length, decided), edited: edited.length, editRate: pct(edited.length, approved.length),
      editMagnitude: avg(edited.map((t) => t.editPct ?? 0)),
      published: ts.filter((t) => t.published > 0).length, judged: scores.length, avgScore: avg(scores), low: scores.filter((s) => s < 70).length,
      avgHoursToDecide: avg(hours),
    };
  }).sort((a, b) => b.n - a.n);
}

async function thumbs(email: string, agent: AgentId) {
  const [up, down] = await Promise.all([db.get<number>(`fb:${email}:${agent}:up`), db.get<number>(`fb:${email}:${agent}:down`)]);
  return { up: Number(up ?? 0), down: Number(down ?? 0) };
}

/** Roll type metrics up per agent. `emails` are the accounts whose chat thumbs count. */
export async function agentMetrics(tasks: TaskLite[], emails: string[]): Promise<AgentMetrics[]> {
  const types = typeMetrics(tasks);
  const accounts = [...new Set(emails)];
  // All thumbs counters in one parallel round, not one agent after another.
  const allFb = await Promise.all(AGENTS.map((a) => Promise.all(accounts.map((e) => thumbs(e, a.id)))));
  const out: AgentMetrics[] = [];
  for (const [i, a] of AGENTS.entries()) {
    const mine = types.filter((t) => agentForTask(t.type).id === a.id);
    const ts = tasks.filter((t) => agentForTask(t.type).id === a.id);
    const approved = ts.filter((t) => t.status === "approved"), decided = approved.length + ts.filter((t) => t.status === "rejected").length;
    const edited = approved.filter((t) => t.edited).length;
    const scores = ts.filter((t) => typeof t.score === "number").map((t) => t.score!);
    const fb = allFb[i];
    const up = fb.reduce((s, f) => s + f.up, 0), down = fb.reduce((s, f) => s + f.down, 0);
    out.push({ agent: a.id, n: ts.length, approvalRate: pct(approved.length, decided), editRate: pct(edited, approved.length), avgScore: avg(scores), low: scores.filter((s) => s < 70).length, thumbsUp: up, thumbsDown: down, types: mine });
  }
  return out;
}

export async function scopeMetrics(scope: string, email: string, sinceDays = 30) {
  const since = Date.now() - sinceDays * 864e5;
  return agentMetrics(await listLite(scope, new Date(since)), [email]);
}

/** Admin: every workspace in the system. */
export async function globalMetrics(sinceDays = 30) {
  const { allUsers } = await import("./schedule");
  const since = Date.now() - sinceDays * 864e5;
  const all: TaskLite[] = [];
  const emails: string[] = [];
  const users: { email: string; scope: string; n: number; approvalRate: number | null; avgScore: number | null }[] = [];
  const list = await allUsers();
  const { pmap } = await import("./parallel");
  const taskSets = await pmap(list, (u) => listLite(u.scope ?? u.email, new Date(since)), 6);
  for (const [i, u] of list.entries()) {
    const scope = u.scope ?? u.email;
    const tasks = taskSets[i];
    all.push(...tasks);
    emails.push(u.email);
    const approved = tasks.filter((t) => t.status === "approved").length, decided = approved + tasks.filter((t) => t.status === "rejected").length;
    const scores = tasks.filter((t) => typeof t.score === "number").map((t) => t.score!);
    users.push({ email: u.email, scope, n: tasks.length, approvalRate: pct(approved, decided), avgScore: avg(scores) });
  }
  return { sinceDays, agents: await agentMetrics(all, emails), users: users.filter((x) => x.n > 0).sort((a, b) => b.n - a.n) };
}

export async function recordThumb(email: string, agent: AgentId, value: 1 | -1, reason?: string, at?: string) {
  await db.incrby(`fb:${email}:${agent}:${value > 0 ? "up" : "down"}`, 1);
  await pushCapped(`fblog:${email}`, JSON.stringify({ agent, value, reason: (reason ?? "").slice(0, 300), msgAt: at ?? null, at: new Date().toISOString() }), CAPS.feedback);
}
