import { NextResponse } from "next/server";
import { adminActor, isAdmin } from "@/lib/auth";
import { secondFactorRefusal } from "@/lib/admin-2fa";
import { isAgentId } from "@/lib/agents";
import { playbook } from "@/lib/skills";
import { GOLDEN_CASES, GOLDEN_VERSION, listGoldenRuns, runGolden } from "@/lib/golden";
import { hasModelKey, modelState } from "@/lib/model";
import { promptHashes } from "@/lib/prompt-stamp";
import { adminAudit } from "@/lib/admin-audit";

export const maxDuration = 300;

// GET /api/admin/golden → latest run in full + score history (no item bodies) + the prompt versions deployed now
// (`hashes`: each playbook and `code:<type>`, the same shape as a run's `playbooks`, so the two can be compared)
export async function GET(req: Request) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false }, { status: 401 });
  const runs = await listGoldenRuns(12);
  const history = runs.map((r) => ({ id: r.id, version: r.version, trigger: r.trigger, startedAt: r.startedAt, status: r.status, overall: r.overall, usd: r.usd, regressions: r.regressions.length, agents: r.agents }));
  return NextResponse.json({ ok: true, version: GOLDEN_VERSION, cases: GOLDEN_CASES.length, modelKey: hasModelKey(), paused: modelState() === "paused", playbooks: Object.fromEntries(["marketing", "sales", "finance", "gtm", "reporting", "executive", "product", "ads", "growth", "review"].map((n) => [n, playbook(n).length])), hashes: promptHashes(GOLDEN_CASES.map((c) => c.type)), latest: runs[0] ?? null, history });
}

// POST /api/admin/golden { agent?, resume? } → run now (up to 5 minutes)
export async function POST(req: Request) {
  // Who acted, as every other founder write logs it (rule 1186): the founder's email or the console key, never a fixed word.
  const who = await adminActor(req);
  if (!who) return NextResponse.json({ ok: false }, { status: 401 });
  // Rule 1376: once a second factor is enrolled, a founder write needs a live step-up or a code (src/lib/admin-2fa.ts).
  const no2fa = await secondFactorRefusal(req, who);
  if (no2fa) return no2fa;
  const b = (await req.json().catch(() => ({}))) as { agent?: string; resume?: boolean };
  const run = await runGolden("manual", { agent: isAgentId(b.agent) ? b.agent : undefined, resume: !!b.resume });
  const state = modelState();
  if (!run) return NextResponse.json({ ok: false, error: state === "on" ? "already_running" : state === "paused" ? "model_paused" : "no_model_key" }, { status: 409 });
  await adminAudit({ actor: who, section: "quality", target: "golden-set", what: `golden:run${b.agent ? `:${b.agent}` : ""}${b.resume ? ":resume" : ""}`, after: { id: run.id, status: run.status, overall: run.overall, usd: run.usd } });
  return NextResponse.json({ ok: true, run });
}
