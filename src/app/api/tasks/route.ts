import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { listTasks } from "@/lib/brand";

export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  return NextResponse.json({ ok: true, tasks: await listTasks(sc(u)), credits: u.credits, plan: u.plan });
}
