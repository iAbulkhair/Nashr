import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { accountKey } from "@/lib/keys";
import { allow, retryLater, WINDOW } from "@/lib/rate";
import { PUSH_CALLS_PER_HOUR, pushEndpoint, pushLogin, pushOn, removeSubscription, saveSubscription } from "@/lib/push";

/**
 * The shared checks of both methods (rules 2562-2563): signed in first, push switched on, a person's own session
 * (`pushLogin`: never an MCP token or a founder's view), within the per-login hourly allowance, and an endpoint of a
 * browser's push service.
 */
async function gate(req: Request) {
  const u = await currentUser();
  if (!u) return { no: NextResponse.json({ ok: false }, { status: 401 }) };
  if (!pushOn()) return { no: NextResponse.json({ ok: false, error: "push_off" }, { status: 503 }) };
  const login = pushLogin(u.actor);
  if (!login) return { no: NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 }) };
  if (!(await allow(accountKey.pushBucket(login), PUSH_CALLS_PER_HOUR, WINDOW.hour))) return { no: retryLater({ ok: false, error: "slow_down" }, WINDOW.hour) };
  const b = (await req.json().catch(() => null)) as { endpoint?: unknown } | null;
  const endpoint = pushEndpoint(b?.endpoint);
  if (!endpoint) return { no: NextResponse.json({ ok: false, error: "bad_endpoint" }, { status: 400 }) };
  return { u, login, endpoint };
}

/**
 * POST /api/push `{ endpoint }` (rule 2562): store this device for phone notifications of the caller's active brand,
 * under `sc(u)` only. The endpoint must belong to a browser's push service; nothing else from the request is kept.
 */
export async function POST(req: Request) {
  const g = await gate(req);
  if (g.no) return g.no;
  await saveSubscription(sc(g.u), g.login, g.endpoint);
  return NextResponse.json({ ok: true });
}

/** DELETE /api/push `{ endpoint }` (rule 2563): forget this device in the caller's own workspace. */
export async function DELETE(req: Request) {
  const g = await gate(req);
  if (g.no) return g.no;
  await removeSubscription(sc(g.u), g.endpoint);
  return NextResponse.json({ ok: true });
}
