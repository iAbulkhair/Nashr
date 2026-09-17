import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { latestBrief } from "@/lib/schedule";

export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  return NextResponse.json({ ok: true, brief: await latestBrief(u.email) });
}
