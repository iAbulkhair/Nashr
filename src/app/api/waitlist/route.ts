import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";

const LIST_KEY = "waitlist:entries";
const EMAIL_SET = "waitlist:emails";

function redis(): Redis | null {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export async function POST(req: Request) {
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

  const kv = redis();
  if (!kv) {
    // Storage not configured yet: at least keep it visible in logs.
    console.log("WAITLIST", JSON.stringify(record));
    return NextResponse.json({ ok: true, stored: false });
  }

  try {
    const isNew = await kv.sadd(EMAIL_SET, email);
    if (isNew) await kv.lpush(LIST_KEY, JSON.stringify(record));
    return NextResponse.json({ ok: true, stored: true, duplicate: !isNew });
  } catch (e) {
    console.error("waitlist store failed", e);
    return NextResponse.json({ ok: false, error: "store_failed" }, { status: 502 });
  }
}

// Admin export: GET /api/waitlist?key=<WAITLIST_ADMIN_KEY>[&format=csv]
export async function GET(req: Request) {
  const url = new URL(req.url);
  const adminKey = process.env.WAITLIST_ADMIN_KEY;
  if (!adminKey || url.searchParams.get("key") !== adminKey) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const kv = redis();
  if (!kv) return NextResponse.json({ ok: false, error: "no_storage" }, { status: 503 });

  const raw = await kv.lrange<string>(LIST_KEY, 0, -1);
  const rows = raw.map((r) => (typeof r === "string" ? JSON.parse(r) : r)) as Array<Record<string, string>>;

  if (url.searchParams.get("format") === "csv") {
    const esc = (v: string) => `"${(v ?? "").replace(/"/g, '""')}"`;
    const csv = ["email,company,industry,lang,at", ...rows.map((r) => [r.email, r.company, r.industry, r.lang, r.at].map(esc).join(","))].join("\n");
    return new NextResponse(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=nashr-waitlist.csv" } });
  }
  return NextResponse.json({ ok: true, count: rows.length, rows });
}
