import { NextResponse } from "next/server";
import { adminActor } from "@/lib/auth";
import { db } from "@/lib/db";
import { allow, retryLater, WINDOW } from "@/lib/rate";
import { AUDIT_CAP, AUDIT_PAGE, pageAudit, parseAuditFilter } from "@/lib/admin-audit";

/** Reads of the audit log per founder (or the console key) and hour (rule 1175, spec rule 1072). */
const LOG_READS_PER_HOUR = 300;

/**
 * GET /api/admin/log?section=&actor=&action=&target=&from= (rule 1175): one page of 50 audit rows, newest first, that
 * pass the filters, from position `from` (0 = newest). Answers `{ok, log, next, scanned}`: `next` is the `from` of the
 * following page, or null; `scanned` is how many rows the list holds (the cap is 5,000), so the page can say the filter
 * looked at that many. Rows written before 2026-10-11 come back with `legacy: true` and no section. Founder only
 * (`adminActor`), then 300 reads an hour per founder.
 */
export async function GET(req: Request) {
  const who = await adminActor(req);
  if (!who) return NextResponse.json({ ok: false }, { status: 401 });
  if (!(await allow(`adminlog:${who}`, LOG_READS_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  const q = new URL(req.url).searchParams;
  const from = Math.max(0, Math.min(AUDIT_CAP, Math.trunc(Number(q.get("from") ?? 0)) || 0));
  // One read of the whole capped list: the filters run here, never one command per row.
  const raw = await db.lrange("admin:log", 0, AUDIT_CAP - 1);
  const { rows, next } = pageAudit(raw, parseAuditFilter(q), from, AUDIT_PAGE);
  return NextResponse.json({ ok: true, log: rows, next, scanned: raw.length });
}
