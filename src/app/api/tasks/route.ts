import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { listTasks, pendingCount } from "@/lib/brand";

// GET /api/tasks → every task with its body (inbox). GET /api/tasks?count=pending → just the number, for the sidebar badge.
export async function GET(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  if (new URL(req.url).searchParams.get("count") === "pending") {
    return NextResponse.json({ ok: true, pending: await pendingCount(sc(u)) });
  }
  return NextResponse.json({ ok: true, tasks: await listTasks(sc(u)), credits: u.credits, plan: u.plan });
}
