import { NextResponse } from "next/server";
import { getUser, isAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { usersCsv } from "@/lib/admin-stats";

export const dynamic = "force-dynamic";

/** GET /api/admin/export → users.csv (UTF-8 with BOM so Excel opens Arabic correctly) */
export async function GET(req: Request) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false }, { status: 401 });
  const rows = [];
  for (const e of await db.smembers("users:all")) { const u = await getUser(e); if (u) rows.push(u); }
  const csv = "﻿" + usersCsv(rows);
  return new NextResponse(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="nashr-users-${new Date().toISOString().slice(0, 10)}.csv"` } });
}
