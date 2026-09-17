import { NextResponse } from "next/server";
import { allUsers, runDaily } from "@/lib/schedule";

export const maxDuration = 120;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ ok: false }, { status: 401 });
  let n = 0;
  for (const u of await allUsers()) {
    if (await runDaily(u)) n++;
  }
  return NextResponse.json({ ok: true, briefs: n });
}
