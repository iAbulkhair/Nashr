import { NextResponse } from "next/server";
import { adminActor } from "@/lib/auth";
import { AGENT_SCOPE_KEYS, readAgentScopeModes, type AgentScopeModes } from "@/lib/agent-scope";
import { agentScopeModel } from "@/lib/agent-scope-classify";
import type { AgentScopeEval } from "@/lib/agent-scope-eval";
import { CAPS, db, pushCapped } from "@/lib/db";

export const dynamic = "force-dynamic";

const ALLOWED: Record<keyof AgentScopeModes, readonly string[]> = {
  prompt: ["on", "off"],
  input: ["off", "shadow", "enforce"],
  role: ["off", "shadow", "enforce"],
  output: ["off", "shadow", "enforce"],
};

/**
 * POST /api/admin/agent-scope/modes {prompt?, input?, role?, output?} (rule 1412): the founder's switches, the only writer of
 * `agent-scope:modes`. Founder only (`adminActor`), else 401.
 *
 * - Any subset of the four fields; each value must be in its set, and at least one field must be sent, else 400 `bad_mode`.
 * - `input` or `output` set to `enforce` needs a stored eval that passed on the model the classifier uses now
 *   (`agentScopeModel()`), else 409 `eval_not_passed`: a refusal that reaches owners must have been measured first. `role`
 *   needs no eval (it is code, not the classifier).
 * - Writes the merged modes and one `admin:log` row `{actor, what: "agent_scope_modes", before, after, at}`.
 */
export async function POST(req: Request) {
  const who = await adminActor(req);
  if (!who) return NextResponse.json({ ok: false }, { status: 401 });
  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const body = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const keys = (Object.keys(ALLOWED) as (keyof AgentScopeModes)[]).filter((k) => body[k] !== undefined);
  if (!keys.length || keys.some((k) => typeof body[k] !== "string" || !ALLOWED[k].includes(body[k] as string))) return NextResponse.json({ ok: false, error: "bad_mode" }, { status: 400 });
  const [before, last] = await Promise.all([readAgentScopeModes(), db.get<AgentScopeEval>(AGENT_SCOPE_KEYS.evalLast).catch(() => null)]);
  const after = { ...before, ...Object.fromEntries(keys.map((k) => [k, body[k]])) } as AgentScopeModes;
  const enforcing = (["input", "output"] as const).some((k) => body[k] === "enforce");
  if (enforcing && !(last?.passed === true && last.model === agentScopeModel())) return NextResponse.json({ ok: false, error: "eval_not_passed" }, { status: 409 });
  await db.set(AGENT_SCOPE_KEYS.modes, after);
  await pushCapped("admin:log", JSON.stringify({ actor: who, what: "agent_scope_modes", before, after, at: new Date().toISOString() }), CAPS.adminLog);
  return NextResponse.json({ ok: true, modes: after });
}
