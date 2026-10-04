import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { can, forbid } from "@/lib/roles";
import { db } from "@/lib/db";
import { allow } from "@/lib/rate";
import { SEC_KEYS, SEC_WRITES_PER_HOUR, SERIES_ID } from "@/lib/secretary";
import { setSeriesKeep } from "@/lib/secretary-series";

/**
 * PUT `{ keep: boolean }`: keep a recurring series' closed history (`keep: true`, `todo.write`), or stop keeping it
 * (`keep: false`, also needs `todo.close`, so a member gets 403). Authenticates, checks the role, rate `sec:write` (per
 * login, before any read), then the id: the series id in the path must have the right form and exist in the caller's
 * own scope (`sc(u)`, one ZCARD), otherwise 404 and nothing is written (another brand's id looks the same as an unknown
 * one). Only then the body (400 unless `keep` is a boolean). `setSeriesKeep` writes the `series_keep` / `series_unkeep`
 * audit line; this route writes none. Answers `{ ok, kept, moved }`, or `keep_limit` 409 at 500 kept series.
 */
export async function PUT(req: Request, ctx: { params: Promise<{ seriesId: string }> }) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const no = forbid(u, "todo.write");
  if (no) return no;
  if (!(await allow(`sec:write:${u.email}`, SEC_WRITES_PER_HOUR, 3600))) return NextResponse.json({ ok: false, error: "too_many" }, { status: 429 });
  const { seriesId } = await ctx.params;
  const scope = sc(u);
  const notFound = () => NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  if (!SERIES_ID.test(seriesId)) return notFound();
  if ((await db.zcard(SEC_KEYS.series(scope, seriesId))) === 0) return notFound();
  const b: unknown = await req.json().catch(() => null);
  const keep = b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>).keep : undefined;
  if (typeof keep !== "boolean") return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  if (keep === false && !can(u, "todo.close")) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  const r = await setSeriesKeep(scope, seriesId, keep, { actor: "owner", via: "web", login: u.actor?.email });
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error, ...(r.field ? { field: r.field } : {}) }, { status: r.status });
  return NextResponse.json({ ok: true, kept: r.kept, moved: r.moved });
}
