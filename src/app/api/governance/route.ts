import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { getGov, historyView, saveGovAs, type GovPatch } from "@/lib/governance";
import { byOf } from "@/lib/actor";

export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  return NextResponse.json({ ok: true, governance: await getGov(sc(u)) });
}
export async function PUT(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  // Every field is validated in `saveGov`'s merge; the body is only ever written to the caller's own scope. Who saved
  // comes from the session, never from the body, and a save that changes something is kept in the history.
  const [b, by] = await Promise.all([req.json().catch(() => ({})) as Promise<GovPatch>, byOf(u)]);
  const r = await saveGovAs(sc(u), b, by);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 409 });
  // The change as the history lists it (null when nothing changed), so the page adds it without another request.
  return NextResponse.json({ ok: true, governance: r.governance, entry: r.revision ? historyView([r.revision])[0] : null });
}
