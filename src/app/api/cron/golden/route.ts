import { NextResponse } from "next/server";
import { runGolden } from "@/lib/golden";

export const maxDuration = 300;

// Weekly golden set (vercel.json). Same auth as the other crons.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ ok: false }, { status: 401 });
  const run = await runGolden("cron");
  if (!run) return NextResponse.json({ ok: false, error: "locked_or_no_model_key" }, { status: 409 });
  return NextResponse.json({ ok: true, id: run.id, status: run.status, overall: run.overall, usd: run.usd, regressions: run.regressions });
}
