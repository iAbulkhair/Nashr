import { track } from "@/lib/track";
import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { isTaskType } from "@/lib/tasks";
import { generateBatch } from "@/lib/generate-batch";
import { ModelPaused, modelState } from "@/lib/model";
import { deadlineFor } from "@/lib/media/keys";

export const maxDuration = 300;

export async function POST(req: Request) {
  // Taken first: the batch's cross-agent review (notes only) is skipped when too little of this request is left.
  const deadline = deadlineFor(maxDuration);
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  // Before the charge: a paused model must not take credits and hand them back.
  if (modelState() === "paused") return NextResponse.json({ ok: false, error: "model_paused" }, { status: 503 });
  const b = (await req.json().catch(() => ({}))) as { type?: string; notes?: string };
  if (!isTaskType(b.type)) return NextResponse.json({ ok: false, error: "bad_type" }, { status: 400 });
  // Brand, trial, missing data, the owning agent's cap and the charge, in that order (src/lib/generate-batch.ts).
  const r = await generateBatch(u, sc(u), { type: b.type, notes: b.notes, source: "manual", via: "app", deadline });
  if (!r.ok) {
    switch (r.reason) {
      case "paused": return NextResponse.json({ ok: false, error: "model_paused" }, { status: 503 });
      case "no_brand": return NextResponse.json({ ok: false, error: "no_brand" }, { status: 400 });
      case "trial_over": return NextResponse.json({ ok: false, error: "trial_over" }, { status: 402 });
      case "missing_data": return NextResponse.json({ ok: false, error: r.missing }, { status: 409 });
      case "agent_cap": return NextResponse.json({ ok: false, error: "agent_cap", agent: r.agent, spent: r.spent, cap: r.cap }, { status: 402 });
      case "no_credits": return NextResponse.json({ ok: false, error: "no_credits", need: r.need, have: r.credits }, { status: 402 });
      case "failed":
        // Already refunded, with the charge's receipt.
        console.error("generate failed", r.error);
        await track(u.email, "error");
        if (r.error instanceof ModelPaused) return NextResponse.json({ ok: false, error: "model_paused", credits: r.credits }, { status: 503 });
        return NextResponse.json({ ok: false, error: "generation_failed" }, { status: 502 });
    }
  }
  await track(u.email, "generate");
  return NextResponse.json({ ok: true, created: r.tasks.length, credits: u.credits });
}
