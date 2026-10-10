import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { byOf } from "@/lib/actor";
import { entitlements } from "@/lib/entitlements";
import { skippedCount } from "@/lib/agent-instructions";
import { getLayer, listHistory, saveDraft, type Draft } from "@/lib/instructions-store";
import { refused } from "@/lib/instructions-http";
import { forbid } from "@/lib/roles";
import { allow, INSTRUCTION_WRITES_PER_HOUR, retryLater, WINDOW } from "@/lib/rate";

/**
 * The brand workspace's agent instructions (agent skills portal, spec 5, 9, 10; rules 949-950).
 *
 * GET -> `{ ok, layer, skipped, limits, history }`: the live set, the draft being edited, how many switched-on items the
 * plan leaves out (the page says "N are not applied"), the plan's limits and the newest 20 versions. Open to every member.
 *
 * PUT `{ items: Draft[] }` -> `{ ok, layer }`: replaces the draft; the live set is untouched. Admin and owner
 * (`instructions.write`), 60 writes an hour per workspace (429 + Retry-After). A refused item is 400 `{ error, index }`.
 *
 * The workspace is always `sc(u)`: a `scope`, `email` or `brandId` in a body is never read, and who saved comes from the
 * session (`byOf`). The customer routes never write the platform layer (`platform: false`). Status of a refused store
 * call: see `statusOf` in src/lib/instructions-http.ts (busy and no_draft 409, not_found 404, a refused value 400).
 */
export async function GET() {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const limits = entitlements(u).instructions;
  const [layer, history] = await Promise.all([getLayer(sc(u)), listHistory(sc(u))]);
  return NextResponse.json({ ok: true, layer, skipped: skippedCount(layer.active, limits), limits, history: history.slice(0, 20) });
}

export async function PUT(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  const no = forbid(u, "instructions.write");
  if (no) return no;
  // One hourly bucket per workspace for save, activate, discard and restore; a refused caller above is not counted.
  if (!(await allow(`instr:w:${sc(u)}`, INSTRUCTION_WRITES_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  const [b, by] = await Promise.all([req.json().catch(() => null) as Promise<{ items?: unknown } | null>, byOf(u)]);
  if (!b || typeof b !== "object" || !Array.isArray(b.items)) return NextResponse.json({ ok: false, error: "bad_items" }, { status: 400 });
  const r = await saveDraft(sc(u), b.items as Draft[], by, { platform: false });
  if (!r.ok) return refused(r);
  return NextResponse.json({ ok: true, layer: r.layer });
}
