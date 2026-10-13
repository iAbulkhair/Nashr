import { NextResponse } from "next/server";
import { adminActor } from "@/lib/auth";
import { secondFactorRefusal } from "@/lib/admin-2fa";
import { adminAudit } from "@/lib/admin-audit";
import { AGENT_SCOPE_KEYS } from "@/lib/agent-scope";
import { runAgentScopeEval } from "@/lib/agent-scope-eval";
import { db } from "@/lib/db";
import { modelState } from "@/lib/model";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/admin/agent-scope/eval (rule 1412): runs the labelled set through the paid classifier once (about 200 short calls,
 * on the global meter) and stores the result in `agent-scope:eval:last`. Founder only (`adminActor`), else 401. 503
 * `model_paused` unless the model is on (no call). One run at a time (`agent-scope:eval:lock`, 300 s): a second press while
 * one runs is 409 `already_running`. One `admin:log` row with the score, through `adminAudit` (rule 1172). Since the 2026-10-12 build batch the second factor
 * gate (rule 1376) runs right after `adminActor`.
 */
export async function POST(req: Request) {
  const who = await adminActor(req);
  if (!who) return NextResponse.json({ ok: false }, { status: 401 });
  // Rule 1376: once a second factor is enrolled, a founder write needs a live step-up or a code (src/lib/admin-2fa.ts).
  const no2fa = await secondFactorRefusal(req, who);
  if (no2fa) return no2fa;
  if (modelState() !== "on") return NextResponse.json({ ok: false, error: "model_paused" }, { status: 503 });
  // An owned lock: a run that outlives the 300 s never frees the lock a later run took (`unlockOwned` checks the token).
  const token = await db.lockOwned(AGENT_SCOPE_KEYS.evalLock, maxDuration);
  if (!token) return NextResponse.json({ ok: false, error: "already_running" }, { status: 409 });
  try {
    const result = await runAgentScopeEval();
    await Promise.all([
      db.set(AGENT_SCOPE_KEYS.evalLast, result),
      adminAudit({ actor: who, section: "quality", action: "agent_scope_eval", what: "agent_scope_eval", after: { model: result.model, total: result.total, errors: result.errors, recall: result.recall, wrongRefusals: result.wrongRefusals, passed: result.passed } }),
    ]);
    return NextResponse.json({ ok: true, eval: result });
  } finally {
    await db.unlockOwned(AGENT_SCOPE_KEYS.evalLock, token).catch(() => {});
  }
}
