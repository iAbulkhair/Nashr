import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { historyView, isRevisionId, rollbackGov } from "@/lib/governance";
import { byOf } from "@/lib/actor";
import { forbid } from "@/lib/roles";
import { allow, GOV_ROLLBACKS_PER_HOUR } from "@/lib/rate";

/**
 * POST {id, confirmAutoHandoff?} — put the governance settings back as they were before revision `id`. A restore that
 * would switch Majed's auto-run back on is refused (400 `auto_handoff_confirm`) unless `confirmAutoHandoff` is `true`,
 * as for a save, and (400 `auto_handoff_needs_cap`) when no agent he hands work to would have a cap. The id is looked up only in the
 * caller's own history (`govhist:{sc(u)}`): no scope, email or key is taken from the body. The restore goes through the
 * same checks as a save and is recorded as a new revision; the history itself is never changed. A restore is a
 * governance write: owner only (`governance.write`, src/lib/roles.ts), refused before any read, like PUT /api/governance.
 */
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false, error: "auth" }, { status: 401 });
  const no = forbid(u, "governance.write");
  if (no) return no;
  if (!(await allow(`govrollback:${u.email}`, GOV_ROLLBACKS_PER_HOUR, 3600))) return NextResponse.json({ ok: false, error: "slow_down" }, { status: 429 });
  const b = ((await req.json().catch(() => ({}))) ?? {}) as { id?: unknown; confirmAutoHandoff?: unknown };
  if (!isRevisionId(b.id)) return NextResponse.json({ ok: false, error: "bad_id" }, { status: 400 });
  // A restore that would switch Majed's auto-run back on needs the same explicit confirmation as a save.
  const r = await rollbackGov(sc(u), b.id, await byOf(u), { confirmAutoHandoff: b.confirmAutoHandoff === true });
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.error === "not_found" ? 404 : r.error === "busy" ? 409 : 400 });
  // The change as the history lists it (null when nothing changed), so the page adds it without another request.
  return NextResponse.json({ ok: true, governance: r.governance, entry: r.revision ? historyView([r.revision])[0] : null });
}
