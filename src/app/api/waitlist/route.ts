import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { csvSafe } from "@/lib/admin-stats";
import { db } from "@/lib/db";
import { allow, clientIp } from "@/lib/rate";

const LIST_KEY = "waitlist:entries";
const EMAIL_SET = "waitlist:emails";

// The shared store (src/lib/db.ts), not a client of its own: the same keys as before, the memory store in development,
// and a loud failure in a production deployment without Redis. The record is never written to the logs: it holds an
// email address. Rule 322, tests/launch-security.test.ts.

export async function POST(req: Request) {
  // Public, unauthenticated write: throttled per IP like every other open endpoint.
  if (!(await allow(`waitlist:ip:${clientIp(req)}`, 10, 3600))) return NextResponse.json({ ok: false, error: "slow_down" }, { status: 429 });
  let body: { email?: string; company?: string; industry?: string; lang?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }

  const email = (body.email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ ok: false, error: "bad_email" }, { status: 400 });
  }

  const record = {
    email,
    company: (body.company ?? "").trim().slice(0, 200),
    industry: (body.industry ?? "").trim().slice(0, 60),
    lang: body.lang === "en" ? "en" : "ar",
    at: new Date().toISOString(),
  };

  try {
    const isNew = await db.sadd(EMAIL_SET, email);
    if (isNew) await db.lpush(LIST_KEY, JSON.stringify(record));
    return NextResponse.json({ ok: true, stored: true, duplicate: !isNew });
  } catch (e) {
    console.error("waitlist store failed", e instanceof Error ? e.name : "error");
    return NextResponse.json({ ok: false, error: "store_failed" }, { status: 502 });
  }
}

// Admin export: GET /api/waitlist[?format=csv] with the x-admin-key header, the admin cookie or a founder session
export async function GET(req: Request) {
  const url = new URL(req.url);
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const raw = await db.lrange(LIST_KEY, 0, -1);
  const rows = raw.flatMap((r) => { try { return [JSON.parse(r) as Record<string, string>]; } catch { return []; } });

  if (url.searchParams.get("format") === "csv") {
    const esc = (v: string) => `"${csvSafe(v ?? "").replace(/"/g, '""')}"`;
    const csv = ["email,company,industry,lang,at", ...rows.map((r) => [r.email, r.company, r.industry, r.lang, r.at].map(esc).join(","))].join("\n");
    return new NextResponse(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=nashr-waitlist.csv" } });
  }
  return NextResponse.json({ ok: true, count: rows.length, rows });
}
