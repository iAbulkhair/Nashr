import { NextResponse } from "next/server";
import { handler } from "@/lib/api-handler";
import { CAPS } from "@/lib/db";
import { listActivity, type Activity } from "@/lib/activity";
import { csvSafe } from "@/lib/admin-stats";
import { ACTIVITY_EXPORTS_PER_HOUR, WINDOW } from "@/lib/rate";

export const dynamic = "force-dynamic";

const COLUMNS = ["at", "agent", "kind", "type", "via", "by", "by_email", "count", "credits", "outcome", "score", "autofail", "media", "refunded", "tasks", "note"] as const;

/**
 * Every cell quoted, and a cell a spreadsheet would run as a formula (= + - @, tab, CR) prefixed with `'` by `csvSafe`:
 * notes hold titles and file names written by a model or an outside app.
 */
const cell = (v: unknown) => `"${csvSafe(String(v ?? "")).replace(/"/g, '""')}"`;
const line = (a: Activity) =>
  [a.at, a.agent, a.kind, a.type, a.via, a.by.kind, a.by.email, a.count, a.credits, a.outcome, a.score, a.autofail, a.media, a.refunded === undefined ? "" : a.refunded ? "yes" : "no", a.tasks?.join(" "), a.note].map(cell).join(",");

/**
 * GET — the caller's whole activity log for the active brand (every row the cap keeps), newest first, as a CSV file:
 * UTF-8 with a BOM so spreadsheet apps read Arabic, one header row. Only `sc(u)` is read; nothing comes from the request.
 */
export const GET = handler(
  { auth: "user", unauthorized: "auth", role: "read", rate: { bucket: "activityexport", max: ACTIVITY_EXPORTS_PER_HOUR, window: WINDOW.hour } },
  async ({ scope }) => {
    const { rows } = await listActivity(scope, { limit: CAPS.activity });
    const csv = "﻿" + [COLUMNS.join(","), ...rows.map(line)].join("\n");
    return new NextResponse(csv, {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="thakeen-activity-${new Date().toISOString().slice(0, 10)}.csv"`, "Cache-Control": "no-store" },
    });
  },
);
