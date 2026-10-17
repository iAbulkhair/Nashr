import { NextResponse } from "next/server";
import { z } from "zod";
import { handler } from "@/lib/api-handler";
import { listTasks, pendingCount } from "@/lib/brand";

// GET /api/tasks → every task with its body (inbox). GET /api/tasks?count=pending → just the number, for the sidebar badge.
export const GET = handler({ auth: "user", query: z.object({ count: z.string().optional() }) }, async ({ u, scope, query }) => {
  if (query.count === "pending") {
    return NextResponse.json({ ok: true, pending: await pendingCount(scope) });
  }
  return NextResponse.json({ ok: true, tasks: await listTasks(scope), credits: u.credits, plan: u.plan });
});
