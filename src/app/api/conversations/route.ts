import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { isAgentId } from "@/lib/agents";
import { createConversation, deleteConversation, listConversations, renameConversation, searchConversations } from "@/lib/conversations";

export async function GET(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const q = new URL(req.url).searchParams.get("q");
  if (q) return NextResponse.json({ ok: true, hits: await searchConversations(sc(u), q) });
  return NextResponse.json({ ok: true, conversations: await listConversations(sc(u)) });
}
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { title?: string; agent?: string };
  return NextResponse.json({ ok: true, conversation: await createConversation(sc(u), b.title ?? "…", isAgentId(b.agent) ? b.agent : "noor") });
}
export async function PATCH(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { id?: string; title?: string };
  if (!b.id || !b.title) return NextResponse.json({ ok: false }, { status: 400 });
  await renameConversation(sc(u), b.id, b.title);
  return NextResponse.json({ ok: true });
}
export async function DELETE(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ ok: false }, { status: 400 });
  await deleteConversation(sc(u), id);
  return NextResponse.json({ ok: true });
}
