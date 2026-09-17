import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { chat, history } from "@/lib/chat";
import { touchConversation } from "@/lib/conversations";
import { isAgentId } from "@/lib/agents";

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
 *   data: {"type":"message","message":…,"credits":n,"limit":"credits"|"trial"|null}
 */
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { text?: string; conv?: string; agent?: string; stream?: boolean };
  const text = (b.text ?? "").trim().slice(0, 4000);
  if (!text) return NextResponse.json({ ok: false, error: "empty" }, { status: 400 });
  const agent = isAgentId(b.agent) ? b.agent : "noor";
  const lang = req.headers.get("x-lang") === "en" ? "en" : u.lang;

  if (!b.stream) {
    try {
      const m = await chat(u, text, b.conv, agent, { lang });
      if (b.conv && b.conv !== "default") await touchConversation(sc(u), b.conv, text);
      return NextResponse.json({ ok: true, message: m, credits: u.credits, limit: m.limit ?? null });
    } catch (e) {
      console.error("chat failed", e);
      return NextResponse.json({ ok: false, error: "chat_failed" }, { status: 502 });
    }
  }

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      try {
        const m = await chat(u, text, b.conv, agent, { lang, onStatus: (s) => send({ type: "status", text: s }) });
        if (b.conv && b.conv !== "default") await touchConversation(sc(u), b.conv, text);
        send({ type: "message", message: m, credits: u.credits, limit: m.limit ?? null });
      } catch (e) {
        console.error("chat failed", e);
        send({ type: "error", error: "chat_failed" });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
}
