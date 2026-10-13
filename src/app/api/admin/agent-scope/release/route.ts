import { NextResponse } from "next/server";
import { adminActor, getUser, normalizeEmail, viaOf } from "@/lib/auth";
import { secondFactorRefusal } from "@/lib/admin-2fa";
import { adminAudit } from "@/lib/admin-audit";
import { updateTask } from "@/lib/brand";
import { listBrands, scopeFor } from "@/lib/brands";
import { itemHash } from "@/lib/agent-scope";

export const dynamic = "force-dynamic";

/** A task or brand id as the app makes them: short and plain, checked before any key is built. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * POST /api/admin/agent-scope/release {email, brandId?, itemId} (rule 1411; plan R15): the founder lets one held item
 * through the agent-scope publish check (rule 1410). Founder only (`adminActor`: the founder's session or the console key,
 * written to `admin:log` as `actor`), else 401.
 *
 * - `email` and `itemId` are required strings (400 `bad_request`); `itemId` must look like a task id. `brandId` defaults to
 *   "default" and must be one of the account's own brands (`listBrands(email)`), else 400 `bad_brand`.
 * - An unknown account is 404 `no_user`; an item not in that brand's workspace is 404 `no_item`.
 * - Under the task lock (`updateTask`) the item gets `agentScopeRelease: {hash: itemHash(t), by, at}`: the release covers that
 *   exact title and text, so an edit afterwards is checked again. Nothing is published here: the owner still presses Publish.
 * - One `admin:log` row `{actor, email, what: "agent_scope_release", brandId, itemId, at}` through `adminAudit` (rule 1172). The
 *   second factor gate (rule 1376) runs right after `adminActor` (2026-10-12 build batch).
 */
export async function POST(req: Request) {
  const who = await adminActor(req);
  if (!who) return NextResponse.json({ ok: false }, { status: 401 });
  // Rule 1376: once a second factor is enrolled, a founder write needs a live step-up or a code (src/lib/admin-2fa.ts).
  const no2fa = await secondFactorRefusal(req, who);
  if (no2fa) return no2fa;
  const b = (await req.json().catch(() => ({}))) as { email?: unknown; brandId?: unknown; itemId?: unknown } | null;
  const body = b && typeof b === "object" ? b : {};
  if (typeof body.email !== "string" || typeof body.itemId !== "string" || !ID.test(body.itemId)) return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  if (body.brandId !== undefined && (typeof body.brandId !== "string" || !ID.test(body.brandId))) return NextResponse.json({ ok: false, error: "bad_brand" }, { status: 400 });
  const email = normalizeEmail(body.email);
  const brandId = (body.brandId as string | undefined) ?? "default";
  const itemId = body.itemId;
  const [user, brands] = await Promise.all([getUser(email), listBrands(email)]);
  if (!user) return NextResponse.json({ ok: false, error: "no_user" }, { status: 404 });
  if (!brands.some((x) => x.id === brandId)) return NextResponse.json({ ok: false, error: "bad_brand" }, { status: 400 });
  const at = new Date().toISOString();
  const done = await updateTask(scopeFor(email, brandId), itemId, (t) => ({ ...t, agentScopeRelease: { hash: itemHash(t), by: who, at } }));
  if (!done) return NextResponse.json({ ok: false, error: "no_item" }, { status: 404 });
  await adminAudit({ actor: who, via: viaOf(req), section: "quality", action: "agent_scope_release", target: email, what: "agent_scope_release", extra: { brandId, itemId } });
  return NextResponse.json({ ok: true });
}
