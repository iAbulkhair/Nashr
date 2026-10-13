import { NextResponse } from "next/server";
import { adminActor, isAdmin } from "@/lib/auth";
import { secondFactorRefusal } from "@/lib/admin-2fa";
import { mailReady } from "@/lib/notify";
import { LEADS_SCAN, leadsCsv, listLeads, markLeadsSeen } from "@/lib/leads";

export const dynamic = "force-dynamic";

/**
 * Founder console, Leads tab (#134). Founder or admin key only (`isAdmin` to read; POST goes through `adminActor` and the
 * console write gate `secondFactorRefusal`).
 *
 * GET ?all=1&offset=0&limit=50  enterprise, early-adopter and affiliate leads newest first (all=1 adds every other
 *                               support ticket), the unread count, and whether email can reach the founder at all.
 * GET ?format=csv[&all=1]       the same rows as a CSV download (every cell through csvSafe), up to the scan cap.
 * POST {action: "seen", until}  the founder has read every lead up to `until`, the newest lead the console showed (a
 *                               lead that arrived after that load stays unread). Without `until`, everything up to now.
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

/** Marking leads seen is a console write: the console actor, then the write gate (rules 1636, 1647). */
export async function POST(req: Request) {
  const who = await adminActor(req);
  if (!who) return NextResponse.json({ ok: false }, { status: 401 });
  const gate = await secondFactorRefusal(req, who);
  if (gate) return gate;
  const b = (await req.json().catch(() => ({}))) as { action?: unknown; until?: unknown };
  if (b.action !== "seen") return NextResponse.json({ ok: false, error: "bad_action" }, { status: 400 });
  if (b.until !== undefined && (typeof b.until !== "string" || b.until.length > 40 || !Number.isFinite(Date.parse(b.until)))) {
    return NextResponse.json({ ok: false, error: "bad_until" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, seenAt: await markLeadsSeen(b.until as string | undefined) });
}
