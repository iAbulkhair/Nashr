import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { byOf } from "@/lib/actor";
import { discardDraft } from "@/lib/instructions-store";
import { forbid } from "@/lib/roles";
import { publicLayer } from "@/lib/instructions-http";
import { allow, INSTRUCTION_WRITES_PER_HOUR, retryLater, WINDOW } from "@/lib/rate";

/**
 * POST -> `{ ok, layer }`: drop the draft; the live set stays. Admin and owner (`instructions.write`), the workspace's
 * write limit (429 + Retry-After). 409 `busy` when the workspace's lock is held. The body is not read.
 */
export async function POST() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "instructions.write");
  if (no) return no;
  // One hourly bucket per workspace for save, activate, discard and restore; a refused caller above is not counted.
  if (!(await allow(`instr:w:${sc(u)}`, INSTRUCTION_WRITES_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  const r = await discardDraft(sc(u), byOf(u));
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 409 });
  return NextResponse.json({ ok: true, layer: publicLayer(r.layer) });
}
