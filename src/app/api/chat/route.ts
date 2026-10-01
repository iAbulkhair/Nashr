import { track } from "@/lib/track";
import { NextResponse } from "next/server";
import { currentUser, sc, trialOver } from "@/lib/auth";
import { chat, chatRefusedText, history, type ChatRefused } from "@/lib/chat";
import { touchConversation } from "@/lib/conversations";
import { isAgentId } from "@/lib/agents";
import { chatCaps, chatRefusal } from "@/lib/rate";
import { deadlineFor } from "@/lib/media/keys";

export const maxDuration = 300;

export async function GET(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const conv = new URL(req.url).searchParams.get("conv") ?? undefined;
  return NextResponse.json({ ok: true, messages: await history(sc(u), conv) });
}

/**
 * POST {text, conv?, agent?, stream?} → JSON reply, or with stream=true a text/event-stream:
 *   data: {"type":"status","text":"…"}  (one per working step)
 *   data: {"type":"message","message":…,"credits":n,"limit":"credits"|"trial"|"agent_cap"|null}
 * Refused before any model call, always as JSON with a `message` the chat shows: 402 `trial_over` (limit "trial", which
 * raises the subscription dialog) and 429 `slow_down` with `retry` "hour" or "day".
 */
export async function POST(req: Request) {
  // The request's one deadline, taken first (rule 336): every model turn of the reply, streamed or not, ends by it.
  const deadline = deadlineFor(maxDuration);
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { text?: string; conv?: string; agent?: string; stream?: boolean };
  const text = (b.text ?? "").trim().slice(0, 4000);
  if (!text) return NextResponse.json({ ok: false, error: "empty" }, { status: 400 });
  const agent = isAgentId(b.agent) ? b.agent : "noor";
  const lang = req.headers.get("x-lang") === "en" ? "en" : u.lang;
  const refused = (kind: ChatRefused, cap?: number) => ({ role: "assistant" as const, content: chatRefusedText(kind, lang, { cap }), at: new Date().toISOString(), agent });
  // An ended trial that never subscribed gets no model turn (rule 330): checked first, so it does not use up a ceiling.
  if (trialOver(u)) return NextResponse.json({ ok: false, error: "trial_over", limit: "trial", message: refused("trial"), credits: u.credits }, { status: 402 });
  // Chat costs no credits, so the only ceiling on what one account can spend on models is this one (rule 331).
  const slow = await chatRefusal(u);
  if (slow) return NextResponse.json({ ok: false, error: "slow_down", retry: slow, message: refused(slow, chatCaps(u.plan)[slow]) }, { status: 429 });

  if (!b.stream) {
    try {
      const m = await chat(u, text, b.conv, agent, { lang, deadline });
      await track(u.email, "chat");
      if (b.conv && b.conv !== "default") await touchConversation(sc(u), b.conv, text);
      return NextResponse.json({ ok: true, message: m, credits: u.credits, limit: m.limit ?? null });
    } catch (e) {
      console.error("chat failed", e);
      await track(u.email, "error");
      return NextResponse.json({ ok: false, error: "chat_failed" }, { status: 502 });
    }
  }

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => { try { controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`)); } catch { /* client went away; the reply is still saved to history */ } };
      // Mobile carriers and proxies drop connections that stay silent for 30-60 s, and a batch takes longer than that.
      const beat = setInterval(() => { try { controller.enqueue(enc.encode(": ping\n\n")); } catch { /* closed */ } }, 10000);
      try {
        const m = await chat(u, text, b.conv, agent, { lang, deadline, onStatus: (s) => send({ type: "status", text: s }) });
        await track(u.email, "chat");
        if (b.conv && b.conv !== "default") await touchConversation(sc(u), b.conv, text);
        send({ type: "message", message: m, credits: u.credits, limit: m.limit ?? null });
      } catch (e) {
        console.error("chat failed", e);
        await track(u.email, "error");
        send({ type: "error", error: "chat_failed" });
      } finally {
        clearInterval(beat);
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
}
