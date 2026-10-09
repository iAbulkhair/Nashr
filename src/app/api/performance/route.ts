import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { db } from "@/lib/db";
import { allow, retryLater } from "@/lib/rate";
import { analyze, ImportError, MAX_CSV_CHARS, METRICS, readRows, type MetricId } from "@/lib/perf-import";
import { clearPerf, getPerf, savePerf } from "@/lib/perf-store";
import { adCodeIndex } from "@/lib/brand";
import { ADSTATS_KEY, adStatsFrom } from "@/lib/ad-stats";
import { forbid } from "@/lib/roles";

/**
 * Campaign results imported from a CSV export (src/lib/perf-import.ts). No model call and no credits: the findings
 * are computed from the owner's own rows. The file is untrusted input: it is bounded, parsed as data, and every name
 * that reaches Noor's memory is stripped to one plain line.
 */
export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  return NextResponse.json({ ok: true, snapshot: await getPerf(sc(u)) });
}

/**
 * An import replaces the last snapshot and rewrites performance-learnings.md, which every agent reads: replacing the
 * data deletes what was there, so it needs what DELETE needs (admin or owner). A connected ad account's sync
 * (`sync_ads`) is not this route: it reads the account's own numbers, never ones typed into a file. The upload's own
 * totals go to `adstats:{scope}:csv` beside `savePerf` (rule 731); no ad account's `adstats` row is touched.
 */
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "performance.import");
  if (no) return no;
  if (!(await allow(`perf:${u.email}`, 20, 3600))) return retryLater({ ok: false, error: "slow_down" }, 3600);
  const b = (await req.json().catch(() => ({}))) as { csv?: unknown; file?: unknown; metric?: unknown };
  if (typeof b.csv !== "string" || !b.csv.trim()) return NextResponse.json({ ok: false, error: "no_file" }, { status: 400 });
  if (b.csv.length > MAX_CSV_CHARS) return NextResponse.json({ ok: false, error: "too_large" }, { status: 413 });
  const metric = typeof b.metric === "string" && b.metric in METRICS ? (b.metric as MetricId) : undefined;
  try {
    const { rows, platform, range } = readRows(b.csv);
    const now = new Date();
    const snap = { ...analyze(rows, typeof b.file === "string" ? b.file : "export.csv", platform, range, metric, now.toISOString(), await adCodeIndex(sc(u))), source: "csv" as const };
    // The account label is the cleaned file name `analyze` already made.
    await Promise.all([savePerf(sc(u), snap), db.set(ADSTATS_KEY(sc(u), "csv"), adStatsFrom("csv", { rows, range, account: snap.file }, null, now))]);
    return NextResponse.json({ ok: true, snapshot: snap });
  } catch (e) {
    if (e instanceof ImportError) return NextResponse.json({ ok: false, error: e.message }, { status: 422 });
    throw e;
  }
}

export async function DELETE() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "performance.delete");
  if (no) return no;
  // The upload's totals go with it; an ad account's `adstats` row stays until its next read.
  await Promise.all([clearPerf(sc(u)), db.del(ADSTATS_KEY(sc(u), "csv"))]);
  return NextResponse.json({ ok: true });
}
