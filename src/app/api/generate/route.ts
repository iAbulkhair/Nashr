import { track } from "@/lib/track";
import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { isTaskType } from "@/lib/tasks";
import { generateBatch } from "@/lib/generate-batch";
import { ModelPaused, modelState } from "@/lib/model";
import { deadlineFor } from "@/lib/media/keys";
import { MODEL_UNAVAILABLE } from "@/lib/models/overrides";
import { agentScopePreflight, agentScopeSlowText, checkGenerationNotes } from "@/lib/agent-scope";
import { WINDOW, retryLater } from "@/lib/rate";

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
  // The reply language, for the agent-scope copy and the model notice below: the request's x-lang, else the account's.
  const lang = req.headers.get("x-lang") === "en" ? "en" : u.lang === "en" ? "en" : "ar";
  // Only a string is notes. The generator would read an array as its text (`["x"].slice()` joins to "x") and the gate reads the
  // string, so anything else is dropped here: no value can reach the batch that the gate did not read.
  const notes = typeof b.notes === "string" ? b.notes : undefined;
  // The agent-scope modes and the brand scope's ceiling of refused requests (rule 795), read first and answered first, before
  // any classifier call and before anything is charged. The batch gets the modes (`agentScope`), read once per request.
  const pre = await agentScopePreflight(u);
  if (pre.slow) return retryLater({ ok: false, error: "slow_down", retry: pre.slow, message: agentScopeSlowText(lang) }, WINDOW[pre.slow]);
  // The input gate on the notes (rule 796), before `generateBatch`: an enforced refusal is 422 and charges and saves nothing.
  const gate = await checkGenerationNotes(u, b.type, notes ?? "", { mode: pre.modes.input, where: "generate", lang, deadline });
  if (gate.block) return NextResponse.json({ ok: false, error: "agent_scope", message: gate.reply }, { status: 422 });
  // Brand, trial, missing data, the owning agent's cap and the charge, in that order (src/lib/generate-batch.ts).
  const r = await generateBatch(u, sc(u), { type: b.type, notes, source: "manual", via: "app", deadline, agentScope: pre.modes });
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
  // The brand's model pick was not used (src/lib/models/overrides.ts): the batch ran on the automatic choice, and the
  // owner reads why in the reply language.
  return NextResponse.json({ ok: true, created: r.tasks.length, credits: u.credits, ...(r.modelRejected ? { notice: MODEL_UNAVAILABLE.generate[lang] } : {}) });
}
