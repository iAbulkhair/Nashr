import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { chat, history } from "@/lib/chat";

export const maxDuration = 300;

export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  return NextResponse.json({ ok: true, messages: await history(u.email) });
}

export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { text?: string };
  const text = (b.text ?? "").trim().slice(0, 4000);
  if (!text) return NextResponse.json({ ok: false, error: "empty" }, { status: 400 });
  try {
    const m = await chat(u, text);
    return NextResponse.json({ ok: true, message: m, credits: u.credits });
  } catch (e) {
    console.error("chat failed", e);
    return NextResponse.json({ ok: false, error: "chat_failed" }, { status: 502 });
  }
}
