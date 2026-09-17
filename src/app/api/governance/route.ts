import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { getGov, saveGov, type Governance } from "@/lib/governance";

export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  return NextResponse.json({ ok: true, governance: await getGov(u.email) });
}
export async function PUT(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as Partial<Governance>;
  return NextResponse.json({ ok: true, governance: await saveGov(u.email, b) });
}
