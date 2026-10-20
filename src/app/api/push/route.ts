import { NextResponse } from "next/server";
import { currentUser, sc } from "@/lib/auth";
import { accountKey } from "@/lib/keys";
import { allow, retryLater, WINDOW } from "@/lib/rate";
import { PUSH_CALLS_PER_HOUR, pushEndpoint, pushLogin, pushOn, removeSubscription, saveSubscription } from "@/lib/push";

const off = () => NextResponse.json({ ok: false, error: "push_off" }, { status: 503 });
const forbidden = () => NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
const badEndpoint = () => NextResponse.json({ ok: false, error: "bad_endpoint" }, { status: 400 });
const endpointOf = async (req: Request) => pushEndpoint(((await req.json().catch(() => null)) as { endpoint?: unknown } | null)?.endpoint);

/**
 * POST /api/push `{ endpoint }` (rule 2562): store this device for phone notifications of the caller's active brand,
 * under `sc(u)` only. Signed in first, push switched on, a person's own session (`pushLogin`: never an MCP token or a
 * founder's view), within the per-login hourly allowance, and an endpoint of a browser's push service; nothing else
 * from the request is kept.
 */
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  if (!pushOn()) return off();
  const login = pushLogin(u.actor);
  if (!login) return forbidden();
  if (!(await allow(accountKey.pushBucket(login), PUSH_CALLS_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  const endpoint = await endpointOf(req);
  if (!endpoint) return badEndpoint();
  await saveSubscription(sc(u), login, endpoint);
  return NextResponse.json({ ok: true });
}

/** DELETE /api/push `{ endpoint }` (rule 2563): forget this device in the caller's own workspace, with POST's checks. */
export async function DELETE(req: Request) {
  const u = await currentUser();
  if (!u) return NextResponse.json({ ok: false }, { status: 401 });
  if (!pushOn()) return off();
  const login = pushLogin(u.actor);
  if (!login) return forbidden();
  if (!(await allow(accountKey.pushBucket(login), PUSH_CALLS_PER_HOUR, WINDOW.hour))) return retryLater({ ok: false, error: "slow_down" }, WINDOW.hour);
  const endpoint = await endpointOf(req);
  if (!endpoint) return badEndpoint();
  await removeSubscription(sc(u), endpoint);
  return NextResponse.json({ ok: true });
}
