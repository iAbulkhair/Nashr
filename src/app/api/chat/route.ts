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

export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { text?: string; conv?: string; agent?: string };
  const text = (b.text ?? "").trim().slice(0, 4000);
  if (!text) return NextResponse.json({ ok: false, error: "empty" }, { status: 400 });
  try {
    const m = await chat(u, text, b.conv, isAgentId(b.agent) ? b.agent : "noor");
    if (b.conv && b.conv !== "default") await touchConversation(sc(u), b.conv, text);
    return NextResponse.json({ ok: true, message: m, credits: u.credits });
  } catch (e) {
    console.error("chat failed", e);
    return NextResponse.json({ ok: false, error: "chat_failed" }, { status: 502 });
  }
}
