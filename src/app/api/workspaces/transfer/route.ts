import { NextResponse } from "next/server";
import { currentPerson } from "@/lib/auth";
import { personKey } from "@/lib/keys";
import { MULTI_ORG } from "@/lib/multi-org";
import { isPersonLockTimeout } from "@/lib/person";
import { allow, retryLater } from "@/lib/rate";
import { isTeamLockTimeout } from "@/lib/team";
import { acceptTransfer } from "@/lib/transfer";
import { switchWorkspace } from "@/lib/workspaces";
import { appHref } from "@/lib/ws-path";

export const dynamic = "force-dynamic";

/** Accept attempts per person per hour: a wrong token is cheap to try, so it is metered. */
const ACCEPTS_PER_HOUR = 10;

const fail = (error: string, status: number) => NextResponse.json({ ok: false, error }, { status });
const lockTimeout = (e: unknown) => isTeamLockTimeout(e) || isPersonLockTimeout(e) || (e instanceof Error && e.message === "user_lock_timeout");

/**
 * POST /api/workspaces/transfer {handle, token} → {ok, handle, href} (multi-workspace M3, rules 2128, 2751): the signed-in
 * person accepts the ownership offer mailed to them. Behind `currentPerson()` (an impersonation has no person: 401). The
 * workspace is the handle matched among the person's own held accounts (rule 2112), never an id; the offer must name
 * this person and the token must match its stored hash. Wrong or stale: 400 `invalid`, nothing changed. Then this
 * device opens the workspace it now owns. With `MULTI_ORG` off, 404.
 */
export async function POST(req: Request) {
  if (!MULTI_ORG) return fail("not_found", 404);
  const me = await currentPerson();
  if (!me) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!(await allow(personKey.xferAcceptBucket(me.person.pid), ACCEPTS_PER_HOUR, 3600))) return retryLater({ ok: false, error: "rate_limited" }, 3600);
  const b = (await req.json().catch(() => ({}))) as { handle?: unknown; token?: unknown };
  try {
    const r = await acceptTransfer(me.person, b.handle, b.token);
    if (!r.ok) return fail(r.error, r.error === "invalid" ? 400 : 409);
    await switchWorkspace(me.person, r.handle);
    return NextResponse.json({ ok: true, handle: r.handle, href: appHref(me.person.lang, "", r.handle) });
  } catch (e) {
    if (lockTimeout(e)) return fail("busy", 409);
    throw e;
  }
}
