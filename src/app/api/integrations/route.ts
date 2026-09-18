import { NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth";
import { CAPS, db, pushCapped } from "@/lib/db";
import { INTEGRATIONS } from "@/lib/integrations";

export async function GET(req: Request) {
  if (await isAdmin(req)) {
    const rows = await db.lrange("integration-requests", 0, 499);
    return NextResponse.json({ ok: true, requests: rows.map((r) => JSON.parse(r)) });
  }
  return NextResponse.json({ ok: true, integrations: INTEGRATIONS });
}
/** POST {id?, name?} → record a request / vote */
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { id?: string; name?: string };
  const name = (b.name ?? b.id ?? "").toString().slice(0, 80);
  if (!name) return NextResponse.json({ ok: false, error: "missing" }, { status: 400 });
  await pushCapped("integration-requests", JSON.stringify({ email: u.email, name, at: new Date().toISOString() }), CAPS.tickets);
  const n = await db.incrby(`integration-votes:${name.toLowerCase()}`, 1);
  return NextResponse.json({ ok: true, votes: n });
}
