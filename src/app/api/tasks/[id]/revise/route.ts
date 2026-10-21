import { track } from "@/lib/track";
import { NextResponse, after } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { forbid } from "@/lib/roles";
import { reviseTask } from "@/lib/revise";
import { ModelPaused } from "@/lib/model";
import { deadlineFor } from "@/lib/media/keys";
import { agentScopePreflight, agentScopeSlowText } from "@/lib/agent-scope";
import { WINDOW, allow, retryLater } from "@/lib/rate";
import { accountKey } from "@/lib/keys";
import { customerModelError } from "@/lib/provider-fault-note";
import { acct } from "@/lib/account-id";

export const maxDuration = 300;

/** Revisions a login may ask for in an hour (rule 2497): each is a paid model call, so a loop is stopped before the charge. */
const REVISES_PER_HOUR = 30;

/**
 * Line notes on a pending draft, sent in one revision (rules 2490-2499, src/lib/revise.ts). Body: `{version, notes:[{line,
 * quote, note}]}`. Any member may send them (role "drafts", like an edit); the item stays pending and nothing is approved.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const deadline = deadlineFor(maxDuration);
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "drafts");
  if (no) return no;
  if (!(await allow(accountKey.reviseBucket(u.email), REVISES_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  const { id } = await ctx.params;
  const raw = (await req.json().catch(() => ({}))) as unknown;
  const b = raw && typeof raw === "object" ? (raw as { version?: unknown; notes?: unknown }) : {};
  const lang = req.headers.get("x-lang") === "en" ? "en" : u.lang === "en" ? "en" : "ar";
  const pre = await agentScopePreflight(u);
  const r = await reviseTask(u, sc(u), id, { version: b.version, notes: b.notes }, { lang, deadline, modes: pre.modes, slow: pre.slow });
  if (!r.ok) {
    switch (r.reason) {
      case "not_found": return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
      case "not_revisable": return NextResponse.json({ ok: false, error: "not_revisable" }, { status: 400 });
      case "version_required": return NextResponse.json({ ok: false, error: "version_required" }, { status: 400 });
      case "bad_notes": return NextResponse.json({ ok: false, error: "bad_notes" }, { status: 400 });
      // The item as it is now, so the card can show it; `credits` is the balance after a refund when the race came after the charge.
      case "changed": case "not_pending": return NextResponse.json({ ok: false, error: r.reason, task: r.task, ...(r.credits === undefined ? {} : { credits: r.credits }) }, { status: 409 });
      case "paused": return NextResponse.json({ ok: false, error: "model_paused" }, { status: 503 });
      case "no_brand": return NextResponse.json({ ok: false, error: "no_brand" }, { status: 400 });
      case "no_model": return NextResponse.json({ ok: false, error: "model_unavailable" }, { status: 503 });
      case "trial_over": return NextResponse.json({ ok: false, error: "trial_over" }, { status: 402 });
      case "fair_use": return NextResponse.json({ ok: false, error: "fair_use", resumes: r.resumes }, { status: 402 });
      case "agent_cap": return NextResponse.json({ ok: false, error: "agent_cap", agent: r.agent, spent: r.spent, cap: r.cap }, { status: 402 });
      case "no_credits": return NextResponse.json({ ok: false, error: "no_credits", need: r.need, have: r.credits }, { status: 402 });
      case "agent_scope": return NextResponse.json({ ok: false, error: "agent_scope", message: r.message, ...(r.credits === undefined ? {} : { credits: r.credits }) }, { status: 422 });
      case "agent_scope_slow": return retryLater({ ok: false, error: "slow_down", retry: r.retry, message: agentScopeSlowText(lang) }, WINDOW[r.retry]);
      case "failed":
        // Already refunded, with the charge's receipt.
        console.error("revise failed", r.error);
        await track(acct(u), "error");
        if (r.error instanceof ModelPaused) return NextResponse.json({ ok: false, error: "model_paused", credits: r.credits }, { status: 503 });
        return NextResponse.json({ ok: false, error: (await customerModelError(r.error, "generate")) ?? "revision_failed", credits: r.credits }, { status: 502 });
    }
  }
  after(r.later);
  return NextResponse.json({ ok: true, task: r.task, credits: r.credits, charged: r.charged });
}
