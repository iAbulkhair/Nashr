import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { forbid } from "@/lib/roles";
import { db } from "@/lib/db";
import { allow } from "@/lib/rate";
import { csvSafe } from "@/lib/admin-stats";
import { SEC_KEYS, SEC_READS_PER_HOUR, SERIES_ID } from "@/lib/secretary";
import { AUTO_CLOSE_RESULT, resultText, zoneDay, zoneLocalInput } from "@/lib/secretary-agenda";
import { getBrand } from "@/lib/brand";
import { zoneOf } from "@/lib/zones";
import { appDict } from "@/lib/app-i18n";
import { seriesRows } from "@/lib/secretary-series";

/**
 * GET: one recurring series' closed copies as a CSV download (`read`, any member, rate `sec:read` per login before any
 * read). The id must have the right form and exist in the caller's own scope (`sc(u)`), otherwise 404. Reads that
 * series' set only, newest close first, up to 5000 rows and then a "truncated" row. Columns: title, due, closed at,
 * result (the skip marker and the auto-close marker shown as text, `?lang=en` for English, Arabic otherwise), closed by (the login, else who: empty
 * for copies closed before closedBy existed). UTF-8 with a BOM; every cell goes through `csvSafe`. The file is named
 * `series-{seriesId}.csv`, never from a title.
 */
const MAX_ROWS = 5000;
const cell = (v: unknown) => `"${csvSafe(String(v ?? "")).replace(/"/g, '""')}"`;
/** Due and closed-at in the brand's own zone: the local day for an all-day copy, the local date and time otherwise. */
const when = (iso: string | null, allDay: boolean, z: ReturnType<typeof zoneOf>) => {
  if (!iso) return "";
  const ms = Date.parse(iso);
  return allDay ? zoneDay(ms, z) : zoneLocalInput(ms, z).replace("T", " ");
};
const line = (cells: unknown[]) => cells.map(cell).join(",");

export async function GET(req: Request, ctx: { params: Promise<{ seriesId: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const no = forbid(u, "read");
  if (no) return no;
  if (!(await allow(`sec:read:${u.email}`, SEC_READS_PER_HOUR, 3600))) return NextResponse.json({ ok: false, error: "too_many" }, { status: 429 });
  const { seriesId } = await ctx.params;
  const scope = sc(u);
  const notFound = () => NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  if (!SERIES_ID.test(seriesId)) return notFound();
  if ((await db.zcard(SEC_KEYS.series(scope, seriesId))) === 0) return notFound();
  const lang = new URL(req.url).searchParams.get("lang") === "en" ? "en" : "ar";
  const [{ items, total }, brand] = await Promise.all([seriesRows(scope, seriesId, MAX_ROWS), getBrand(scope)]);
  const zone = zoneOf(brand);
  const T = appDict[lang].todo;
  const rows = [line(["title", "due", "closed at", "result", "closed by"])];
  for (const it of items) rows.push(line([it.title, when(it.dueAt, it.allDay, zone), when(it.completedAt, false, zone), it.result === AUTO_CLOSE_RESULT ? T.autoClosed : resultText(it.result, lang), it.closedBy ? it.closedBy.login ?? it.closedBy.actor : ""]));
  if (total > MAX_ROWS) rows.push(line([`truncated: the first ${MAX_ROWS} of ${total} closed copies`, "", "", "", ""]));
  return new NextResponse("\uFEFF" + rows.join("\r\n") + "\r\n", {
    status: 200,
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="series-${seriesId}.csv"`, "cache-control": "no-store" },
  });
}
