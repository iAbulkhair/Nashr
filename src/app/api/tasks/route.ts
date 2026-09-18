import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { listTasks } from "@/lib/brand";

// GET /api/tasks → every task with its body (inbox). GET /api/tasks?count=pending → just the number, for the sidebar badge.
export async function GET(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  if (new URL(req.url).searchParams.get("count") === "pending") {
    const pending = (await listTasks(sc(u))).filter((t) => t.status === "pending").length;
    return NextResponse.json({ ok: true, pending });
  }
  return NextResponse.json({ ok: true, tasks: await listTasks(sc(u)), credits: u.credits, plan: u.plan });
}
