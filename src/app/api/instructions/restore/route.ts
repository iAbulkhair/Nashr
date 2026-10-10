import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { byOf } from "@/lib/actor";
import { entitlements } from "@/lib/entitlements";
import { skippedCount } from "@/lib/agent-instructions";
import { restore } from "@/lib/instructions-store";
import { publicLayer, publicRevision, refused } from "@/lib/instructions-http";
import { forbid } from "@/lib/roles";
import { allow, INSTRUCTION_WRITES_PER_HOUR, retryLater, WINDOW } from "@/lib/rate";

/**
 * POST `{ revisionId }` -> `{ ok, layer, revision, skipped }`: put a version back as the next one (the history is never changed).
 * Admin and owner (`instructions.write`), the workspace's write limit (429 + Retry-After). The id is looked up only in
 * this workspace's own history (the store never builds a key from it): 404 `not_found` for any other value, 409 for a
 * plan limit today's plan does not allow, 409 `busy`. Who acted comes from the session.
 */
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "instructions.write");
  if (no) return no;
  // One hourly bucket per workspace for save, activate, discard and restore; a refused caller above is not counted.
  if (!(await allow(`instr:w:${sc(u)}`, INSTRUCTION_WRITES_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  const b = (await req.json().catch(() => null)) as { revisionId?: unknown } | null;
  const id = b && typeof b === "object" && typeof b.revisionId === "string" ? b.revisionId : "";
  const r = await restore(sc(u), id, byOf(u), { platform: false, limits: entitlements(u).instructions });
  if (!r.ok) return refused(r);
  return NextResponse.json({ ok: true, layer: publicLayer(r.layer), revision: publicRevision(r.revision), skipped: skippedCount(r.layer.active, entitlements(u).instructions) });
}
