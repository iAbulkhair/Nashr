import { NextResponse } from "next/server";
import { sameSecret } from "@/lib/rate";
import { recordCronRun } from "@/lib/cron-heartbeat";
import { sc } from "@/lib/auth";
import { getBrand } from "@/lib/brand";
import { dailyRoster } from "@/lib/schedule";
import { runCronBatch } from "@/lib/cron-batch";
import { pmap } from "@/lib/parallel";
import { eveningWrap, isRamadan } from "@/lib/secretary-evening";
import { isZone, zoneOf, type Zone } from "@/lib/zones";

export const maxDuration = 300;

/**
 * Reem's evening wrap for every active workspace (src/lib/secretary-evening.ts), eight at a time, resumable through
 * runCronBatch like the daily job, each wrap at most once per scope and local day.
 *
 * Two callers, both with the CRON_SECRET bearer (compared with `sameSecret`): the daily cron at 15:00 UTC (18:00
 * Riyadh, 19:00 Dubai), which serves every workspace and does nothing in Ramadan (the wrap then waits for 21:30 local,
 * after Taraweeh); and the QStash tick (`/api/cron/secretary`), which passes `?zones=` when those zones' wrap time has
 * just passed, in and out of Ramadan. Without QStash there is no wrap in Ramadan. `?zones=` must name only allow-listed
 * zones (`isZone`), else 400 and nothing runs.
 */
export async function GET(req: Request) {
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!sameSecret(bearer, process.env.CRON_SECRET)) return NextResponse.json({ ok: false }, { status: 401 });
  const param = new URL(req.url).searchParams.get("zones");
  // Every listed zone must be on the allow-list, else nothing runs: a list is never quietly trimmed to its valid part.
  const parts = param === null ? null : param.split(",");
  if (parts && (!parts.length || !parts.every(isZone))) return NextResponse.json({ ok: false, error: "bad_zones" }, { status: 400 });
  const zones = parts as Zone[] | null;
  const now = Date.now();
  if (!zones && isRamadan(now)) {
    await recordCronRun("evening");
    return NextResponse.json({ ok: true, skipped: "ramadan" });
  }
  const roster = await dailyRoster();
  let users = roster.users;
  if (zones) {
    // Only the workspaces kept in those zones: filtered before the batch, so the others' markers stay untouched.
    const brands = await pmap(users, (u) => getBrand(sc(u)));
    users = users.filter((_, i) => zones.includes(zoneOf(brands[i])));
  }
  const report = await runCronBatch({
    job: "evening", period: new Date(now).toISOString().slice(0, 10), items: users,
    id: (u) => sc(u), run: (u) => eveningWrap(u, Date.now()),
    concurrency: 8, startBudgetMs: 240_000, markerTtlSeconds: 2 * 86400, req,
  });
  await recordCronRun("evening");
  const count = (word: string) => Object.values(report.results).filter((r) => r === word).length;
  return NextResponse.json({ ok: true, ...report, sent: count("sent"), silent: count("silent") });
}
