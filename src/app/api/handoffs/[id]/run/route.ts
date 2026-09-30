import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { forbid } from "@/lib/roles";
import { allow, HANDOFF_RUNS_PER_HOUR } from "@/lib/rate";
import { byOf } from "@/lib/actor";
import { track } from "@/lib/track";
import { ModelPaused, modelState } from "@/lib/model";
import { deadlineFor } from "@/lib/media/keys";
import { chatItemOf, handoffView, isHandoffId, runHandoffItem, type Handoff, type RunResult } from "@/lib/handoffs";

export const maxDuration = 300;

/**
 * POST {item} — run ONE item of one of Majed's handoffs: the login pressed Run on its card. A run spends credits the way
 * a generation does, so it needs what generating needs (`generate`). Everything else is decided in code
 * (`runHandoffItem`, src/lib/handoffs.ts): the record is read only under `sc(u)` (another account's id is 404), under the
 * handoff's lock (a second run of the same handoff meanwhile is 409 `busy`), the item's status is checked (done,
 * declined and running items are refused), and the batch goes through `generateBatch` with the item's type and agent,
 * never anything from this body but the item's position. "Run all" on the card is one request per item.
 *
 * Refusals keep the codes the app already raises its limit dialog for (`no_credits`, `trial_over`, `agent_cap`), and a
 * failed generation is refunded by `generateBatch` and answered 502, with the card's new state.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  // Taken first: the run must not start generating with too little of the request left (HANDOFF_RUN_MIN_MS).
  const deadline = deadlineFor(300);
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false, error: "auth" }, { status: 401 });
  const no = forbid(u, "generate");
  if (no) return no;
  if (!(await allow(`handoffrun:${u.email}`, HANDOFF_RUNS_PER_HOUR, 3600))) return NextResponse.json({ ok: false, error: "slow_down" }, { status: 429 });
  const { id } = await ctx.params;
  if (!isHandoffId(id)) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const b = (await req.json().catch(() => null)) as { item?: unknown } | null;
  // One item per request, by its position: an array, a string or a missing item is refused.
  const item = b && typeof b === "object" && !Array.isArray(b) ? b.item : undefined;
  if (typeof item !== "number" || !Number.isInteger(item) || item < 0) return NextResponse.json({ ok: false, error: "bad_item" }, { status: 400 });
  // Before the lock and any charge: a paused model must not take credits and hand them back.
  if (modelState() === "paused") return NextResponse.json({ ok: false, error: "model_paused" }, { status: 503 });
  const scope = sc(u);
  const r = await runHandoffItem(u, scope, id, item, { by: byOf(u), deadline });
  const view = async (h?: Handoff) => (h ? { handoff: await handoffView(scope, h) } : {});
  if (r.ok) {
    await track(u.email, "generate");
    return NextResponse.json({ ok: true, ...(await view(r.handoff)), items: r.tasks.map(chatItemOf), credits: u.credits });
  }
  const [status, body] = refusal(r);
  if (r.error === "failed") await track(u.email, "error");
  return NextResponse.json({ ok: false, ...body, ...(await view(r.handoff)), credits: u.credits }, { status });
}

/** A refused or failed run as the status and body the card reads. */
function refusal(r: Extract<RunResult, { ok: false }>): [number, Record<string, unknown>] {
  const x = r.refusal;
  switch (r.error) {
    case "not_found": return [404, { error: "not_found" }];
    case "bad_item": return [400, { error: "bad_item" }];
    case "busy": case "running": case "done": case "declined": return [409, { error: r.error }];
    case "too_late": return [503, { error: "too_late" }];
    case "paused": return [503, { error: "model_paused" }];
    case "no_brand": return [400, { error: "no_brand" }];
    case "trial_over": return [402, { error: "trial_over" }];
    case "missing_data": return [409, { error: "missing_data", ...(x?.reason === "missing_data" ? { missing: x.missing } : {}) }];
    case "agent_cap": return [402, { error: "agent_cap", ...(x?.reason === "agent_cap" ? { agent: x.agent, spent: x.spent, cap: x.cap } : {}) }];
    case "no_credits": return [402, { error: "no_credits", ...(x?.reason === "no_credits" ? { need: x.need, have: x.credits } : {}) }];
    case "failed":
      // Already refunded, with the charge's receipt.
      console.error("handoff run failed", x?.reason === "failed" && x.error instanceof Error ? x.error.message : "error");
      return x?.reason === "failed" && x.error instanceof ModelPaused ? [503, { error: "model_paused" }] : [502, { error: "generation_failed" }];
  }
}
