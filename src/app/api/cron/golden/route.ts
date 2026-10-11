import { NextResponse } from "next/server";
import { runGolden } from "@/lib/golden";
import { sameSecret } from "@/lib/rate";
import { recordCronRun } from "@/lib/cron-heartbeat";

export const maxDuration = 300;

// Weekly golden set (vercel.json). Same auth as the other crons — which it claimed to be and was not: this compared
// the secret with `!==`, which can stop at the first differing byte and leak the secret's prefix through timing, and
// it was the one cron in the codebase breaking the sameSecret rule. sameSecret also refuses an unset CRON_SECRET.
export async function GET(req: Request) {
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!sameSecret(bearer, process.env.CRON_SECRET)) return NextResponse.json({ ok: false }, { status: 401 });
  const run = await runGolden("cron");
  if (!run) return NextResponse.json({ ok: false, error: "locked_or_no_model_key" }, { status: 409 });
  await recordCronRun("golden");
  return NextResponse.json({ ok: true, id: run.id, status: run.status, overall: run.overall, usd: run.usd, regressions: run.regressions });
}
