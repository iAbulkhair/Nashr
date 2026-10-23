import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { listSubscribers, subscribersCsv, type NewsletterStatus } from "@/lib/newsletter";

export const dynamic = "force-dynamic";

const STATUSES: readonly NewsletterStatus[] = ["pending", "confirmed", "unsubscribed"];

/**
 * Founder console, Newsletter tab (rules 3600-3609). Staff only, guarded as the waitlist export is: `isAdmin(req)` (the
 * `x-admin-key` header, a staff session or the founder's own). Read only: nothing here writes.
 *
 * GET ?status=confirmed|pending|unsubscribed&offset=0&limit=50  the list, newest sign-up first, with the count of each status.
 * GET ?format=csv[&status=…]                                     the same rows as a CSV download (every cell through csvSafe).
 *
 * Only `confirmed` rows are subscribers. The addresses are visitor PII: returned to staff, never logged.
 */
export async function GET(req: Request) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const q = new URL(req.url).searchParams;
  const asked = q.get("status");
  const status = STATUSES.find((s) => s === asked);
  if (q.get("format") === "csv") {
    const { rows } = await listSubscribers({ status, everything: true });
    return new NextResponse("﻿" + subscribersCsv(rows), {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="thakeen-newsletter-${new Date().toISOString().slice(0, 10)}.csv"`, "Cache-Control": "no-store" },
    });
  }
  const page = await listSubscribers({ status, offset: Number(q.get("offset") ?? 0) || 0, limit: q.has("limit") ? Number(q.get("limit")) || 0 : 50 });
  return NextResponse.json({ ok: true, ...page }, { headers: { "Cache-Control": "no-store" } });
}
