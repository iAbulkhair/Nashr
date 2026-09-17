import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { createMcpToken, getMcpToken, revokeMcpToken } from "@/lib/mcp";

export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const t = await getMcpToken(u.email);
  return NextResponse.json({ ok: true, token: t ? `${t.slice(0, 12)}…` : null, exists: !!t });
}
export async function POST() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  await revokeMcpToken(u.email);
  const token = await createMcpToken(u.email);
  return NextResponse.json({ ok: true, token }); // shown once
}
export async function DELETE() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  await revokeMcpToken(u.email);
  return NextResponse.json({ ok: true });
}
