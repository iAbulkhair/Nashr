import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { db } from "@/lib/db";

// GET /api/admin/log → last 50 admin actions
export async function GET(req: Request) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false }, { status: 401 });
  const rows = await db.lrange("admin:log", 0, 49);
  return NextResponse.json({ ok: true, log: rows.map((r) => JSON.parse(r)) });
}
