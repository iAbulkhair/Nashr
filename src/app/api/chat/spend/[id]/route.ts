import { NextResponse, after } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { forbid } from "@/lib/roles";
import { allow, retryLater, SPEND_RUNS_PER_HOUR, WINDOW } from "@/lib/rate";
import { byOf } from "@/lib/actor";
import { track } from "@/lib/track";
import { ModelPaused, modelState } from "@/lib/model";
import { deadlineFor } from "@/lib/media/keys";
import { errCode, mediaResponse, startThrew } from "@/lib/media/start";
import { maybeSweep } from "@/lib/media/jobs";
import { mediaDeps } from "@/lib/media/registry";
import { chatItemOf } from "@/lib/handoffs";
import { decideSpend, getSpendProposal, isSpendProposalId, type SpendRun } from "@/lib/spend-proposals";

export const maxDuration = 300;

/**
 * POST `{ decision: "run" | "dismiss" }` — the owner's answer to paid chat work the owner's message did not ask for in
 * words (src/lib/spend-proposals.ts, rules 1511-1512). Run is the approval: the batch or the render runs with the stored
 * type, brief and count, never anything from this body. It spends credits the way the chat tool would have, so it needs
 * what generating needs (`generate`; `images` for a render), under its own hourly bucket.
 *
 * The proposal is read only from the caller's own scope (`sc(u)`): another account's id is 404, and no body field names a
 * scope. Answers: `{ ok: true, items, credits }` for a batch, the image route's own body for a render, `{ ok: true }` for
 * dismiss; 410 `gone` once decided; 409 `claim_busy` while another click runs; the batch refusals with the codes the app
 * already raises its limit dialog for (402 `no_credits`, `trial_over`, `agent_cap`), and 502 for a failed batch (refunded
 * by `generateBatch`). A refused or failed run leaves the card open.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const deadline = deadlineFor(maxDuration);
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false, error: "auth" }, { status: 401 });
  const no = forbid(u, "generate");
  if (no) return no;
  if (!(await allow(`spendrun:${sc(u)}`, SPEND_RUNS_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  const { id } = await ctx.params;
  if (!isSpendProposalId(id)) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const b = (await req.json().catch(() => null)) as { decision?: unknown } | null;
  const decision = b && typeof b === "object" && !Array.isArray(b) ? b.decision : undefined;
  if (decision !== "run" && decision !== "dismiss") return NextResponse.json({ ok: false, error: "bad_decision" }, { status: 400 });
  // Read only from the caller's own scope; a render also needs what the inbox's image button needs.
  const p = await getSpendProposal(sc(u), id);
  if (p?.kind === "image") {
    const noImages = forbid(u, "images");
    if (noImages) return noImages;
  }
  const kind = p?.kind;
  // Before the claim and any charge: a paused model must not take credits and hand them back.
  if (decision === "run" && kind !== "image" && modelState() === "paused") return NextResponse.json({ ok: false, error: "model_paused" }, { status: 503 });
  let r: SpendRun;
  try {
    r = await decideSpend(u, id, decision, { by: byOf(u), deadline });
  } catch (e) {
    // Only a render throws past its charge (the engine leaves a durable job the next poll or a sweep settles).
    console.error("spend run", errCode(e));
    if (kind === "image") {
      const { status, body } = await startThrew(u, p?.taskId ?? "", "image");
      return NextResponse.json(body, { status });
    }
    return NextResponse.json({ ok: false, error: "generation_failed" }, { status: 502 });
  } finally {
    if (kind === "image") after(() => maybeSweep(mediaDeps(), deadline));
  }
  if (r.ok) {
    if (r.kind === "dismissed") return NextResponse.json({ ok: true });
    await track(u.email, "generate");
    if (r.kind === "image") {
      const { status, body, headers } = mediaResponse(r.outcome);
      return NextResponse.json(body, { status, headers });
    }
    return NextResponse.json({ ok: true, items: r.tasks.map(chatItemOf), credits: r.credits });
  }
  const [status, body] = refusal(r);
  return NextResponse.json({ ok: false, ...body, credits: u.credits }, { status });
}

/** A refused or failed run as the status and body the card reads. */
function refusal(r: Extract<SpendRun, { ok: false }>): [number, Record<string, unknown>] {
  switch (r.error) {
    case "not_found": case "item_gone": return [404, { error: r.error }];
    case "gone": return [410, { error: "gone" }];
    case "claim_busy": return [409, { error: "claim_busy" }];
    case "bad_proposal": return [409, { error: "bad_proposal" }];
    case "too_late": return [503, { error: "too_late" }];
    case "image": {
      const { status, body } = mediaResponse(r.outcome);
      return [status, body as Record<string, unknown>];
    }
    case "refused": {
      const x = r.refusal;
      switch (x.reason) {
        case "paused": return [503, { error: "model_paused" }];
        case "no_brand": return [400, { error: "no_brand" }];
        case "trial_over": return [402, { error: "trial_over" }];
        case "missing_data": return [409, { error: "missing_data", missing: x.missing }];
        case "agent_cap": return [402, { error: "agent_cap", agent: x.agent, spent: x.spent, cap: x.cap }];
        case "no_credits": return [402, { error: "no_credits", need: x.need, have: x.credits }];
        case "failed":
          // Already refunded, with the charge's receipt.
          console.error("spend run failed", x.error instanceof Error ? x.error.message : "error");
          return x.error instanceof ModelPaused ? [503, { error: "model_paused" }] : [502, { error: "generation_failed" }];
      }
    }
  }
}
