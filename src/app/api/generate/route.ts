import { track } from "@/lib/track";
import { forbid } from "@/lib/roles";
import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { isTaskType } from "@/lib/tasks";
import { generateBatch } from "@/lib/generate-batch";
import { ModelPaused, modelState } from "@/lib/model";
import { deadlineFor } from "@/lib/media/keys";
import { MODEL_UNAVAILABLE } from "@/lib/models/overrides";
import { AgentScopeRefused, agentScopePreflight, agentScopeSlowText } from "@/lib/agent-scope";
import { WINDOW, retryLater } from "@/lib/rate";
import { customerModelError } from "@/lib/provider-fault-note";
import { acct } from "@/lib/account-id";

export const maxDuration = 300;

export async function POST(req: Request) {
  // Taken first: the batch's cross-agent review (notes only) is skipped when too little of this request is left.
  const deadline = deadlineFor(maxDuration);
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  // A Viewer reads and comments only: no agent runs, no credits spent (rule 3752).
  const no = forbid(u, "generate");
  if (no) return no;
  // Before the charge: a paused model must not take credits and hand them back.
  if (modelState() === "paused") return NextResponse.json({ ok: false, error: "model_paused" }, { status: 503 });
  const b = (await req.json().catch(() => ({}))) as { type?: string; notes?: string };
  if (!isTaskType(b.type)) return NextResponse.json({ ok: false, error: "bad_type" }, { status: 400 });
  // The reply language, for the agent-scope copy and the model notice below: the request's x-lang, else the account's.
  const lang = req.headers.get("x-lang") === "en" ? "en" : u.lang === "en" ? "en" : "ar";
  // Only a string is notes. The generator would read an array as its text (`["x"].slice()` joins to "x") and the gate reads the
  // string, so anything else is dropped here: no value can reach the batch that the gate did not read.
  const notes = typeof b.notes === "string" ? b.notes : undefined;
  // The agent-scope modes and the brand scope's ceiling of refused requests (rule 795), read once. The batch gets the modes
  // (`agentScope`) and the notes' gate (`notesGate`, rule 796), which runs inside `generateBatch` after its free refusals (an
  // owner refused for a real reason reads that reason) and before the charge. A spent ceiling (`slow`) holds only a request that has
  // notes; one without is never held.
  const pre = await agentScopePreflight(u);
  // Brand, trial, missing data, the notes' gate, the owning agent's cap and the charge, in that order (src/lib/generate-batch.ts).
  const r = await generateBatch(u, sc(u), { type: b.type, notes, source: "manual", via: "app", deadline, agentScope: pre.modes, notesGate: { notes: notes ?? "", mode: pre.modes.input, where: "generate", lang, slow: pre.slow } });
  if (!r.ok) {
    switch (r.reason) {
      case "paused": return NextResponse.json({ ok: false, error: "model_paused" }, { status: 503 });
      case "no_brand": return NextResponse.json({ ok: false, error: "no_brand" }, { status: 400 });
      case "trial_over": return NextResponse.json({ ok: false, error: "trial_over" }, { status: 402 });
      // The fair-use stop (rule 1723): nothing was charged or generated.
      case "fair_use": return NextResponse.json({ ok: false, error: "fair_use", resumes: r.resumes }, { status: 402 });
      case "missing_data": return NextResponse.json({ ok: false, error: r.missing }, { status: 409 });
      case "agent_cap": return NextResponse.json({ ok: false, error: "agent_cap", agent: r.agent, spent: r.spent, cap: r.cap }, { status: 402 });
      case "no_credits": return NextResponse.json({ ok: false, error: "no_credits", need: r.need, have: r.credits }, { status: 402 });
      // Outside what the team works on (rule 796): nothing was charged or saved. The copy is in the reply language.
      case "agent_scope": return NextResponse.json({ ok: false, error: "agent_scope", message: r.message }, { status: 422 });
      // Too many such requests, or too many checks, for this brand scope: 429 with the window's Retry-After.
      case "agent_scope_slow": return retryLater({ ok: false, error: "slow_down", retry: r.retry, message: agentScopeSlowText(lang) }, WINDOW[r.retry]);
      case "failed":
        // Every item was outside what the team works on (rule 801, output check in enforce): the whole batch was refunded and
        // nothing was saved. 422 like the notes' refusal, with the balance after the refund.
        if (r.error instanceof AgentScopeRefused) return NextResponse.json({ ok: false, error: "agent_scope", message: r.error.reply, credits: r.credits }, { status: 422 });
        // Already refunded, with the charge's receipt.
        console.error("generate failed", r.error);
        await track(acct(u), "error");
        if (r.error instanceof ModelPaused) return NextResponse.json({ ok: false, error: "model_paused", credits: r.credits }, { status: 503 });
        // A provider rate limit, overload or spent balance gets its own message (rule 1477), never the provider's text.
        return NextResponse.json({ ok: false, error: (await customerModelError(r.error, "generate")) ?? "generation_failed" }, { status: 502 });
    }
  }
  await track(acct(u), "generate");
  // The brand's model pick was not used (src/lib/models/overrides.ts): the batch ran on the automatic choice, and the
  // owner reads why in the reply language.
  // `held`: items the output check kept back in enforce (rule 801), whose share was refunded; `credits` is after that refund.
  return NextResponse.json({ ok: true, created: r.tasks.length, credits: u.credits, ...(r.held ? { held: r.held, refunded: r.refunded ?? 0 } : {}), ...(r.modelRejected ? { notice: MODEL_UNAVAILABLE.generate[lang] } : {}) });
}
