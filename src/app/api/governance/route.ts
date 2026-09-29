import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { getGov, saveGov, type GovPatch } from "@/lib/governance";
import { forbid } from "@/lib/roles";

export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  return NextResponse.json({ ok: true, governance: await getGov(sc(u)) });
}
export async function PUT(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  // Agent caps, auto-approve and the reviewer decide what is spent and what skips the human gate: the owner's call only.
  const no = forbid(u, "governance.write");
  if (no) return no;
  // Every field is validated in `saveGov`; the body is only ever written to the caller's own scope.
  const b = (await req.json().catch(() => ({}))) as GovPatch;
  return NextResponse.json({ ok: true, governance: await saveGov(sc(u), b) });
}
