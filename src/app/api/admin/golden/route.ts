import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { isAgentId } from "@/lib/agents";
import { db } from "@/lib/db";
import { GOLDEN_CASES, GOLDEN_VERSION, listGoldenRuns, runGolden } from "@/lib/golden";

export const maxDuration = 300;

// GET /api/admin/golden → latest run in full + score history (no item bodies)
export async function GET(req: Request) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false }, { status: 401 });
  const runs = await listGoldenRuns(12);
  const history = runs.map((r) => ({ id: r.id, version: r.version, trigger: r.trigger, startedAt: r.startedAt, status: r.status, overall: r.overall, usd: r.usd, regressions: r.regressions.length, agents: r.agents }));
  return NextResponse.json({ ok: true, version: GOLDEN_VERSION, cases: GOLDEN_CASES.length, modelKey: !!process.env.ANTHROPIC_API_KEY, latest: runs[0] ?? null, history });
}

// POST /api/admin/golden { agent?, resume? } → run now (up to 5 minutes)
export async function POST(req: Request) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { agent?: string; resume?: boolean };
  const run = await runGolden("manual", { agent: isAgentId(b.agent) ? b.agent : undefined, resume: !!b.resume });
  if (!run) return NextResponse.json({ ok: false, error: process.env.ANTHROPIC_API_KEY ? "already_running" : "no_model_key" }, { status: 409 });
  await db.lpush("admin:log", JSON.stringify({ actor: "founder", email: "golden-set", what: `golden:run${b.agent ? `:${b.agent}` : ""}${b.resume ? ":resume" : ""}`, after: { id: run.id, status: run.status, overall: run.overall, usd: run.usd }, at: new Date().toISOString() }));
  return NextResponse.json({ ok: true, run });
}
