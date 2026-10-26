import { track } from "@/lib/track";
import { forbid } from "@/lib/roles";
import { NextResponse } from "next/server";
import { currentUser, sc, trialOver } from "@/lib/auth";
import { chat, chatRefusedText, type ChatRefused } from "@/lib/chat";
import { historyFor } from "@/lib/chat-history";
import { getConversation, touchConversation } from "@/lib/conversations";
import { isAgentId } from "@/lib/agents";
import { entitlements } from "@/lib/entitlements";
import { WINDOW, chatCaps, chatRefusal, retryLater } from "@/lib/rate";
import { deadlineFor } from "@/lib/media/keys";
import { chatStatus, reserveChatTurn, runChatTurn } from "@/lib/chat-allowance";
import { chatRouteFor } from "@/lib/models/overrides";
import { noteRejectedPick } from "@/lib/usage";
import { agentScopePreflight, agentScopeSlowText } from "@/lib/agent-scope";
import { customerModelError } from "@/lib/provider-fault-note";
import { acct } from "@/lib/account-id";
import { teamRoute } from "@/lib/team-chat";
import { TEAM_CHAT } from "@/lib/v2-flags";
import { workStep } from "@/lib/work-view";

export const maxDuration = 300;

/** The thread and the chat status, whose hold is the one of the model the conversation's next turn would run on. */
export async function GET(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const conv = new URL(req.url).searchParams.get("conv") ?? undefined;
  const record = conv && conv !== "default" ? getConversation(sc(u), conv) : Promise.resolve(null);
  const [messages, status] = await Promise.all([historyFor(sc(u), conv), record.then((c) => chatStatus(u, chatRouteFor(u, c).model))]);
  return NextResponse.json({ ok: true, messages, chat: status });
}

/**
 * POST {text, conv?, agent?, stream?} → JSON reply, or with stream=true a text/event-stream:
 *   data: {"type":"status","text":"…"}  (one per working step)
 *   data: {"type":"step","step":WorkStep}  (one per run-log step while RUN_LOG is on: the work view, v2 C9, rule 4774)
 *   data: {"type":"message","message":…,"credits":n,"limit":"credits"|"trial"|"agent_cap"|null,"chat":ChatStatus,"charged":n}
 * Refused before anything is saved, counted or streamed, always as JSON: 403 `agent_not_included` (an agent the plan does not
 * include, rule 782), 402 `trial_over` (an ended trial, rule 330: limit
 * "trial", which raises the subscription dialog, and a `message` the chat shows), 429 `slow_down` with `retry` "hour" or
 * "day" and a `message` (rule 331), the same 429 `slow_down` when the agent-scope input gate is in enforce and the brand
 * scope has used its ceiling of refused messages (rule 795, `agentScopePreflight`: no classifier call; its `message` says
 * so), and a message past the plan's chat allowance: 402 {error:"chat_allowance"} (paused)
 * or {error:"chat_credits"} (continue-on-credits is on but the balance is below the most a message can cost), with
 * `chat` and `credits`. A `conv` other than "default" with no record under the caller's scope: 404 `conversation_gone`
 * (rule 2933), before every count.
 */
export async function POST(req: Request) {
  // The request's one deadline, taken first (rule 336): every model turn of the reply, streamed or not, ends by it.
  const deadline = deadlineFor(maxDuration);
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  // A Viewer reads and comments only: no agent runs, no credits spent (rule 3752).
  const no = forbid(u, "chat");
  if (no) return no;
  const b = (await req.json().catch(() => ({}))) as { text?: string; conv?: string; agent?: string; stream?: boolean };
  const text = (b.text ?? "").trim().slice(0, 4000);
  if (!text) return NextResponse.json({ ok: false, error: "empty" }, { status: 400 });
  const page = isAgentId(b.agent) ? b.agent : "noor";
  // An agent the plan does not include (rule 782): refused before the trial gate and every count. Every plan includes all
  // eight today, so nothing reaches this yet.
  if (!entitlements(u).agents.includes(page)) return NextResponse.json({ ok: false, error: "agent_not_included" }, { status: 403 });
  const lang = req.headers.get("x-lang") === "en" ? "en" : u.lang;
  const refused = (kind: ChatRefused, cap?: number) => ({ role: "assistant" as const, content: chatRefusedText(kind, lang, { cap }), at: new Date().toISOString(), agent: page });
  // An ended trial that never subscribed gets no model turn (rule 330): checked first, so it uses up neither a ceiling
  // nor a message of the trial's allowance.
  if (trialOver(u)) return NextResponse.json({ ok: false, error: "trial_over", limit: "trial", message: refused("trial"), credits: u.credits }, { status: 402 });
  // The short-window ceiling next (a burst never touches the month's count, rule 331), then the plan's monthly
  // allowance, all before chat() saves the owner's message (src/lib/chat-allowance.ts).
  // The conversation's record is read with the ceiling, under the caller's own scope: its `model` is the owner's pick.
  // The agent-scope modes and the brand scope's ceiling of refused messages are read in the same round (rule 795); a spent
  // ceiling (only in enforce) is answered first, before the allowance is touched and without a classifier call. The
  // burst ceiling has counted this request by then.
  const [slow, record, pre] = await Promise.all([chatRefusal(u), b.conv && b.conv !== "default" ? getConversation(sc(u), b.conv) : null, agentScopePreflight(u)]);
  // A named conversation with no record (deleted in another tab, or an id this scope never made) is refused before any
  // count or save (rule 2933): a turn would otherwise write `chat:{scope}:{conv}` outside the `convs:` index, where the
  // account wipe never finds it. Ids come only from POST /api/conversations; "default" is the legacy thread, with no record.
  if (b.conv && b.conv !== "default" && !record) return NextResponse.json({ ok: false, error: "conversation_gone" }, { status: 404 });
  // Team chat (v2 C4 + C12, rule 4731): the agent who answers is the thread's owner, or the one the person named with @ in
  // this message, checked against the plan as the page's agent is. Off: the page's agent, exactly as before.
  const team = teamRoute(text, page, record);
  const agent = team.agent;
  if (!entitlements(u).agents.includes(agent)) return NextResponse.json({ ok: false, error: "agent_not_included" }, { status: 403 });
  const teamOpt = TEAM_CHAT ? { team } : {};
  if (pre.slow) return retryLater({ ok: false, error: "slow_down", retry: pre.slow, message: { role: "assistant", content: agentScopeSlowText(lang), at: new Date().toISOString(), agent } }, WINDOW[pre.slow]);
  if (slow) return retryLater({ ok: false, error: "slow_down", retry: slow, message: refused(slow, chatCaps(u)[slow]) }, WINDOW[slow]);
  // The turn's one model, resolved once: the conversation's pick when route() accepts it, else automatic, and then the
  // reply says so (`modelRejected`). The messages are reserved for it and chat() runs on the gate's copy of it.
  const routed = chatRouteFor(u, record);
  const gate = await reserveChatTurn(u, routed.model);
  if (!gate.ok) return NextResponse.json({ ok: false, error: gate.error, chat: gate.status, credits: gate.credits }, { status: 402 });
  const modelRejected = routed.rejected;
  // A refused pick is counted for the founder console (global, best effort: it never changes the turn).
  if (modelRejected) await noteRejectedPick("chat", modelRejected);

  if (!b.stream) {
    try {
      const { message: m, chat: status, charged } = await runChatTurn(u, gate, () => chat(u, text, b.conv, agent, { lang, deadline, model: gate.model, agentScope: pre.modes, modelRejected, ...teamOpt }));
      await track(acct(u), "chat");
      if (b.conv && b.conv !== "default") await touchConversation(sc(u), b.conv, text, TEAM_CHAT ? agent : undefined);
      return NextResponse.json({ ok: true, message: m, credits: u.credits, limit: m.limit ?? null, chat: status, charged });
    } catch (e) {
      console.error("chat failed", e);
      await track(acct(u), "error");
      // A provider rate limit, overload or spent balance gets its own message (rule 1477), never the provider's text.
      return NextResponse.json({ ok: false, error: (await customerModelError(e, "chat")) ?? "chat_failed" }, { status: 502 });
    }
  }

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => { try { controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`)); } catch { /* client went away; the reply is still saved to history */ } };
      // Mobile carriers and proxies drop connections that stay silent for 30-60 s, and a batch takes longer than that.
      const beat = setInterval(() => { try { controller.enqueue(enc.encode(": ping\n\n")); } catch { /* closed */ } }, 10000);
      try {
        const { message: m, chat: status, charged } = await runChatTurn(u, gate, () => chat(u, text, b.conv, agent, { lang, deadline, model: gate.model, agentScope: pre.modes, modelRejected, ...teamOpt, onStatus: (s) => send({ type: "status", text: s }), onStep: (e) => send({ type: "step", step: workStep(e) }) }));
        await track(acct(u), "chat");
        if (b.conv && b.conv !== "default") await touchConversation(sc(u), b.conv, text, TEAM_CHAT ? agent : undefined);
        send({ type: "message", message: m, credits: u.credits, limit: m.limit ?? null, chat: status, charged });
      } catch (e) {
        console.error("chat failed", e);
        await track(acct(u), "error");
        send({ type: "error", error: (await customerModelError(e, "chat")) ?? "chat_failed" });
      } finally {
        clearInterval(beat);
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
}
