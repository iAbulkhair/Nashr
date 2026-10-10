import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { byOf } from "@/lib/actor";
import { entitlements } from "@/lib/entitlements";
import { activate } from "@/lib/instructions-store";
import { refused } from "@/lib/instructions-http";
import { forbid } from "@/lib/roles";
import { allow, INSTRUCTION_WRITES_PER_HOUR, retryLater, WINDOW } from "@/lib/rate";

/**
 * POST -> `{ ok, layer, revision }`: the draft becomes the next live version. Admin and owner (`instructions.write`), the
 * workspace's write limit (429 + Retry-After). The store checks the draft again against today's plan: 409 `no_draft`
 * when there is none, 409 `instructions_limit` / `per_agent_plan` / `refs_plan` when the plan does not allow it, 409
 * `busy` when the workspace's lock is held. The body is not read: the workspace is `sc(u)`, who acted comes from the session.
 */
export async function POST() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "instructions.write");
  if (no) return no;
  // One hourly bucket per workspace for save, activate, discard and restore; a refused caller above is not counted.
  if (!(await allow(`instr:w:${sc(u)}`, INSTRUCTION_WRITES_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  const r = await activate(sc(u), await byOf(u), { platform: false, limits: entitlements(u).instructions });
  if (!r.ok) return refused(r);
  return NextResponse.json({ ok: true, layer: r.layer, revision: r.revision });
}
