import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { allow } from "@/lib/rate";
import { analyze, ImportError, MAX_CSV_CHARS, METRICS, readRows, type MetricId } from "@/lib/perf-import";
import { clearPerf, getPerf, savePerf } from "@/lib/perf-store";

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

export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  if (!(await allow(`perf:${u.email}`, 20, 3600))) return NextResponse.json({ ok: false, error: "slow_down" }, { status: 429 });
  const b = (await req.json().catch(() => ({}))) as { csv?: unknown; file?: unknown; metric?: unknown };
  if (typeof b.csv !== "string" || !b.csv.trim()) return NextResponse.json({ ok: false, error: "no_file" }, { status: 400 });
  if (b.csv.length > MAX_CSV_CHARS) return NextResponse.json({ ok: false, error: "too_large" }, { status: 413 });
  const metric = typeof b.metric === "string" && b.metric in METRICS ? (b.metric as MetricId) : undefined;
  try {
    const { rows, platform, range } = readRows(b.csv);
    const snap = { ...analyze(rows, typeof b.file === "string" ? b.file : "export.csv", platform, range, metric), source: "csv" as const };
    await savePerf(sc(u), snap);
    return NextResponse.json({ ok: true, snapshot: snap });
  } catch (e) {
    if (e instanceof ImportError) return NextResponse.json({ ok: false, error: e.message }, { status: 422 });
    throw e;
  }
}

export async function DELETE() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  await clearPerf(sc(u));
  return NextResponse.json({ ok: true });
}
