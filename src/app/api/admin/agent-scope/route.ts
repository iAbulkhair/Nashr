import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { AGENT_SCOPE_KEYS, readAgentScopeModes, type AgentScopeLogEntry } from "@/lib/agent-scope";
import type { AgentScopeEval } from "@/lib/agent-scope-eval";
import { monthKey } from "@/lib/credits";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/admin/agent-scope?day=YYYY-MM-DD (rule 1413): the founder's agent-scope panel. Founder only (`isAdmin`), else 401.
 * `day` must look like a date, else today (UTC). One round reads the modes, the last eval, the day's newest 500 log lines
 * and this month's classifier counters on the global meter (`usage:_all:{month}:kind:agent_scope` and `…:usd_micro`).
 */
export async function GET(req: Request) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false }, { status: 401 });
  const asked = new URL(req.url).searchParams.get("day") ?? "";
  const day = DAY.test(asked) ? asked : new Date().toISOString().slice(0, 10);
  const month = monthKey();
  const [modes, last, rows, calls, micro] = await Promise.all([
    readAgentScopeModes(),
    db.get<AgentScopeEval>(AGENT_SCOPE_KEYS.evalLast).catch(() => null),
    db.lrange(AGENT_SCOPE_KEYS.log(day), 0, 499).catch((): string[] => []),
    db.get<number | string>(`usage:_all:${month}:kind:agent_scope`).catch(() => null),
    db.get<number | string>(`usage:_all:${month}:kind:agent_scope:usd_micro`).catch(() => null),
  ]);
  const log = rows.flatMap((r) => {
    try {
      return [JSON.parse(r) as AgentScopeLogEntry];
    } catch {
      return [];
    }
  });
  return NextResponse.json({ ok: true, day, modes, eval: last ?? null, log, cost: { month, calls: Number(calls ?? 0) || 0, usd: (Number(micro ?? 0) || 0) / 1e6 } });
}
