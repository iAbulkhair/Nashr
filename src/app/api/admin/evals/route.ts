import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { globalMetrics } from "@/lib/evals";

// GET /api/admin/evals?days=30 → agent quality across all workspaces
export async function GET(req: Request) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false }, { status: 401 });
  const days = Math.max(1, Math.min(365, Number(new URL(req.url).searchParams.get("days") ?? 30) || 30));
  return NextResponse.json({ ok: true, ...(await globalMetrics(days)) });
}
