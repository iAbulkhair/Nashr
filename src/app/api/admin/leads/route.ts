import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { mailReady } from "@/lib/notify";
import { LEADS_SCAN, leadsCsv, listLeads, markLeadsSeen } from "@/lib/leads";

export const dynamic = "force-dynamic";

/**
 * Founder console, Leads tab (#134). Founder or admin key only (`isAdmin`).
 *
 * GET ?all=1&offset=0&limit=50  enterprise, early-adopter and affiliate leads newest first (all=1 adds every other
 *                               support ticket), the unread count, and whether email can reach the founder at all.
 * GET ?format=csv[&all=1]       the same rows as a CSV download (every cell through csvSafe), up to the scan cap.
 * POST {action: "seen"}         the founder has read everything up to now (the tab's unread count drops to 0).
 *
 * Lead contents are visitor PII: they are returned to the founder and never logged.
 */
export async function GET(req: Request) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false }, { status: 401 });
  const q = new URL(req.url).searchParams;
  const all = q.get("all") === "1";
  if (q.get("format") === "csv") {
    const { leads } = await listLeads({ all, everything: true });
    return new NextResponse("﻿" + leadsCsv(leads), {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="thakeen-leads-${new Date().toISOString().slice(0, 10)}.csv"`, "Cache-Control": "no-store" },
    });
  }
  const page = await listLeads({ all, offset: Number(q.get("offset") ?? 0) || 0, limit: q.has("limit") ? Number(q.get("limit")) || 0 : 50 });
  return NextResponse.json(
    { ok: true, ...page, scanCap: LEADS_SCAN, mail: { ready: mailReady(), forwardTo: !!process.env.WAITLIST_TO } },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { action?: unknown };
  if (b.action !== "seen") return NextResponse.json({ ok: false, error: "bad_action" }, { status: 400 });
  return NextResponse.json({ ok: true, seenAt: await markLeadsSeen() });
}
