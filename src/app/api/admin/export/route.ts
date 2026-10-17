import { NextResponse } from "next/server";
import { getUser, isAdmin, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { usersCsv } from "@/lib/admin-stats";
import { pmap } from "@/lib/parallel";
import { globalKey } from "@/lib/keys";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/export → users.csv (UTF-8 with BOM so Excel opens Arabic correctly), with each account's monthly price,
 * allowance, seats and Agency deal (src/lib/admin-stats.ts `usersCsv`, every cell through csvSafe).
 */
export async function GET(req: Request) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false }, { status: 401 });
  // Side by side: an awaited loop cost one Redis round trip per account.
  const users = await pmap(await db.smembers(globalKey.usersAll()), (e) => getUser(e));
  const rows = users.filter((u): u is User => !!u);
  const csv = "﻿" + usersCsv(rows);
  return new NextResponse(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="nashr-users-${new Date().toISOString().slice(0, 10)}.csv"` } });
}
