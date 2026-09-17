import { NextResponse } from "next/server";
import { allUsers, runWeekly } from "@/lib/schedule";

export const maxDuration = 300;

function authorized(req: Request) {
  const secret = process.env.CRON_SECRET;
  return !!secret && req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ ok: false }, { status: 401 });
  const results: Record<string, string> = {};
  for (const u of await allUsers()) {
    try {
      results[u.email] = await runWeekly(u);
    } catch (e) {
      results[u.email] = "error:" + (e instanceof Error ? e.message : "x");
    }
  }
  return NextResponse.json({ ok: true, results });
}
