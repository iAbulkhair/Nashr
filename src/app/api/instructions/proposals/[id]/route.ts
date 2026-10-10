import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { byOf } from "@/lib/actor";
import { entitlements } from "@/lib/entitlements";
import { decideInstructionProposal } from "@/lib/instruction-proposals";
import { publicLayer, statusOf } from "@/lib/instructions-http";
import { forbid } from "@/lib/roles";
import { allow, INSTRUCTION_WRITES_PER_HOUR, retryLater, WINDOW } from "@/lib/rate";

/**
 * The owner's answer to an instruction an agent proposed in chat (src/lib/instruction-proposals.ts; agent skills portal
 * spec 7, rule 954): POST `{ decision: "apply" | "dismiss" }`. This click is the only approval there is: the tool that
 * proposed it stored text and nothing else. Admin and owner (`instructions.write`), the same role as the Agent
 * instructions page, and the workspace's hourly write bucket (429 + Retry-After).
 *
 * The proposal is read only from the caller's own scope (`sc(u)`): an id from another account or another brand is 404,
 * and no body field names a scope. Who applied comes from the session (`byOf`). Answers: `{ ok: true, layer }` for apply
 * (the public layer: no `imp`), `{ ok: true }` for dismiss; 410 `gone` once decided; 409 `busy` while another answer for it
 * runs, and 409 for a plan limit (`instructions_limit`, `per_agent_plan`), which leaves it open; 400 for a text today's
 * checks refuse (it stays open, to be dismissed).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "instructions.write");
  if (no) return no;
  // The bucket shared by save, activate, discard and restore; a refused caller above is not counted.
  if (!(await allow(`instr:w:${sc(u)}`, INSTRUCTION_WRITES_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  const { id } = await ctx.params;
  const b = (await req.json().catch(() => null)) as { decision?: unknown } | null;
  const decision = b && typeof b === "object" ? b.decision : undefined;
  if (decision !== "apply" && decision !== "dismiss") return NextResponse.json({ ok: false, error: "bad_decision" }, { status: 400 });
  const r = await decideInstructionProposal(sc(u), id, decision, byOf(u), entitlements(u).instructions);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.error === "gone" ? 410 : statusOf(r.error) });
  return NextResponse.json(r.layer ? { ok: true, layer: publicLayer(r.layer) } : { ok: true });
}
