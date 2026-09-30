import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { getGov, historyView, saveGovAs, type GovPatch } from "@/lib/governance";
import { byOf } from "@/lib/actor";
import { forbid } from "@/lib/roles";

export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  return NextResponse.json({ ok: true, governance: await getGov(sc(u)) });
}
export async function PUT(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  // Agent caps, auto-approve and the reviewer decide what is spent and what skips the human gate: the owner's call only.
  const no = forbid(u, "governance.write");
  if (no) return no;
  // Every field is validated in `saveGov`'s merge; the body is only ever written to the caller's own scope. Who saved
  // comes from the session, never from the body, and a save that changes something is kept in the history.
  const [b, by] = await Promise.all([req.json().catch(() => ({})) as Promise<GovPatch | null>, byOf(u)]);
  // Switching Majed's auto-run on needs this literal `true`, which the page sends only after its confirmation dialog;
  // it is not a setting and is never stored. Without a cap on an agent he hands work to, it cannot be on at all.
  const confirmAutoHandoff = !!b && typeof b === "object" && (b as { confirmAutoHandoff?: unknown }).confirmAutoHandoff === true;
  const r = await saveGovAs(sc(u), b ?? {}, by, undefined, { confirmAutoHandoff });
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.error === "busy" ? 409 : 400 });
  // The change as the history lists it (null when nothing changed), so the page adds it without another request.
  return NextResponse.json({ ok: true, governance: r.governance, entry: r.revision ? historyView([r.revision])[0] : null });
}
